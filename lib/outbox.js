/**
 * 待发队列（outbox）纯逻辑：不 import cordis、不碰 HTTP、不判时间相位。
 *
 * 时间相位由调用方用 lib/core/clock.js 算好后写进 item.sendAt；这里只负责队列语义：
 * FIFO 顺序、状态机、失败重试封顶、clientTag 幂等、崩溃恢复、统计。
 * 持久化交给 domain.table('outbox')（真机）或内存 fake table（单测）。
 */

export const STATUSES = Object.freeze(['waiting', 'sending', 'failed', 'abandoned'])

/** 失败重试上限；达到后不再自动投递，留在队列里等人工 retry。 */
export const MAX_ATTEMPTS = 3

/** 第 1/2/3 次失败后的退避（PLAN §5.2：5s / 15s / 60s）。 */
export const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 60_000])

/** PLAN §6.6 队列上限。 */
export const LIMIT_PER_SESSION = 20
export const LIMIT_GLOBAL = 100

/** 投递记录只留最近 50 条；清理报告只留最近 20 条。 */
export const KEEP_DELIVERED = 50
export const KEEP_REPORTS = 20

const SHA_PREFIX = 'sha256:'

/**
 * 附件 id 在 ref 里带 `sha256:` 前缀，在对象库文件名里是裸 64 位十六进制。
 * 两处都要比对，统一成裸十六进制。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAttachmentId(value) {
  if (typeof value !== 'string') return ''
  return value.startsWith(SHA_PREFIX) ? value.slice(SHA_PREFIX.length) : value
}

/**
 * @param {unknown} ref
 * @returns {string}
 */
export function attachmentIdOf(ref) {
  return normalizeAttachmentId(ref && typeof ref === 'object' ? ref.attachmentId : '')
}

/**
 * @param {{ attachments?: unknown }} item
 * @returns {string[]}
 */
export function attachmentIdsOf(item) {
  const refs = Array.isArray(item?.attachments) ? item.attachments : []
  return refs.map(attachmentIdOf).filter((id) => id !== '')
}

/**
 * 第 n 次失败后的等待：attempts=1 → 5s，2 → 15s，≥3 → 60s（封顶）。
 *
 * @param {number} attempts - 已经失败的次数（≥1）。
 * @returns {number}
 */
export function retryDelayMs(attempts) {
  const index = Math.min(Math.max(Math.trunc(Number(attempts) || 1), 1), RETRY_DELAYS_MS.length) - 1
  return RETRY_DELAYS_MS[index]
}

/**
 * FIFO 排序：先 createdAt，再 id（同毫秒也不抖）。
 *
 * @param {{ createdAt?: number, id?: string }} a
 * @param {{ createdAt?: number, id?: string }} b
 * @returns {number}
 */
export function compareFifo(a, b) {
  const delta = (a?.createdAt ?? 0) - (b?.createdAt ?? 0)
  if (delta !== 0) return delta
  const left = String(a?.id ?? '')
  const right = String(b?.id ?? '')
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * 这一项现在能不能尝试投递（不看到点，只看状态与重试节奏）。
 *
 * @param {object} item
 * @param {{ now?: number, retryAt?: Record<string, number>, maxAttempts?: number }} [options]
 * @returns {boolean}
 */
export function canAttempt(item, options = {}) {
  if (!item || typeof item !== 'object') return false
  if (item.status === 'waiting') return true
  if (item.status !== 'failed') return false
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  if (Number(item.attempts ?? 0) >= maxAttempts) return false
  const retryAt = options.retryAt ?? {}
  const at = retryAt[item.id]
  if (typeof at === 'number' && at > (options.now ?? 0)) return false
  return true
}

/**
 * 按会话分组出「本轮该投递的项」。
 *
 * 顺序规则：全局按 FIFO 排；同一 sessionId 内严格 FIFO——前一项还在 `sending`
 * （投递中/崩溃未确认）时后面的项一律等待。失败封顶的项停在原地但不再阻塞后续项。
 *
 * @param {object[]} items
 * @param {{ now?: number, retryAt?: Record<string, number>, maxAttempts?: number, includeFuture?: boolean }} [options]
 * @returns {{ sessionId: string, items: object[] }[]}
 */
export function planDeliveries(items, options = {}) {
  const now = options.now ?? 0
  const retryAt = options.retryAt ?? {}
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const includeFuture = options.includeFuture === true
  const sorted = [...(Array.isArray(items) ? items : [])].sort(compareFifo)
  /** @type {Map<string, { sessionId: string, items: object[], blocked: boolean, createdAt: number }>} */
  const groups = new Map()
  for (const item of sorted) {
    if (!item || typeof item.sessionId !== 'string') continue
    let group = groups.get(item.sessionId)
    if (!group) {
      group = { sessionId: item.sessionId, items: [], blocked: false, createdAt: item.createdAt ?? 0 }
      groups.set(item.sessionId, group)
    }
    if (item.status === 'sending') {
      group.blocked = true
      continue
    }
    if (group.blocked) continue
    if (!canAttempt(item, { now, retryAt, maxAttempts })) continue
    if (!includeFuture && !((item.sendAt ?? 0) <= now)) continue
    group.items.push(item)
  }
  return [...groups.values()]
    .filter((group) => group.items.length > 0)
    .sort((a, b) => a.createdAt - b.createdAt || (a.sessionId < b.sessionId ? -1 : 1))
    .map((group) => ({ sessionId: group.sessionId, items: group.items }))
}

/**
 * 下一次需要唤醒定时器的时刻（undefined = 没有待办）。
 * `sending` 视为在途（崩溃恢复负责），`abandoned` 与失败封顶的项不再唤醒。
 *
 * @param {object[]} items
 * @param {{ retryAt?: Record<string, number>, maxAttempts?: number }} [options]
 * @returns {number | undefined}
 */
export function nextDueTime(items, options = {}) {
  const retryAt = options.retryAt ?? {}
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  let next
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue
    if (item.status === 'sending' || item.status === 'abandoned') continue
    if (item.status === 'failed' && Number(item.attempts ?? 0) >= maxAttempts) continue
    const candidate = Math.max(item.sendAt ?? 0, retryAt[item.id] ?? 0)
    if (next === undefined || candidate < next) next = candidate
  }
  return next
}

/**
 * 待办计数（UI 与 /config 用）。
 *
 * @param {object[]} items
 * @returns {number}
 */
export function countPending(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) => item && (item.status === 'waiting' || item.status === 'sending' || item.status === 'failed'),
  ).length
}

/**
 * 保留最近 N 条：返回该删除的主键（按 timeKey 升序，最旧的先删）。
 *
 * @param {object[]} entries
 * @param {{ keep?: number, timeKey?: string, keyOf?: (entry: object) => string }} [options]
 * @returns {string[]}
 */
export function selectStale(entries, options = {}) {
  const keep = Math.max(0, options.keep ?? 0)
  const timeKey = options.timeKey ?? 'deliveredAt'
  const keyOf = options.keyOf ?? ((entry) => entry.id)
  const sorted = [...(Array.isArray(entries) ? entries : [])].sort(
    (a, b) => (a?.[timeKey] ?? 0) - (b?.[timeKey] ?? 0),
  )
  return sorted.slice(0, Math.max(0, sorted.length - keep)).map((entry) => keyOf(entry))
}

/**
 * outbox 表的读写封装。表是 domain.table('outbox')（key = item.id）。
 */
export class OutboxStore {
  /**
   * @param {object} table - KvTable 形状：get/entries/put/delete/update/size
   * @param {{ now?: () => number, idGen?: () => string }} [options]
   */
  constructor(table, options = {}) {
    if (!table || typeof table.entries !== 'function') throw new TypeError('OutboxStore 需要一个 domain 表')
    this.table = table
    this.now = options.now ?? (() => Date.now())
    this.idGen = options.idGen ?? (() => globalThis.crypto.randomUUID())
  }

  /** @returns {object[]} 全量快照（FIFO 序） */
  all() {
    return [...this.table.entries()].map(([, value]) => value).sort(compareFifo)
  }

  /**
   * @param {string} sessionId
   * @returns {object[]}
   */
  list(sessionId) {
    return this.all().filter((item) => item.sessionId === sessionId)
  }

  /**
   * @param {string} id
   * @returns {object | undefined}
   */
  get(id) {
    return this.table.get(id)
  }

  /**
   * 写入一项。缺省 status=waiting、attempts=0、reason='peak'。
   *
   * @param {object} input
   * @returns {Promise<object>}
   */
  async add(input) {
    const at = Number(input.createdAt ?? this.now())
    const item = {
      id: input.id ?? this.idGen(),
      clientTag: input.clientTag,
      sessionId: input.sessionId,
      text: input.text ?? '',
      attachments: Array.isArray(input.attachments) ? [...input.attachments] : [],
      createdAt: at,
      sendAt: Number(input.sendAt ?? at),
      reason: 'peak',
      status: input.status ?? 'waiting',
      attempts: Number(input.attempts ?? 0),
    }
    if (input.lastError !== undefined) item.lastError = input.lastError
    if (input.submittedModel !== undefined) item.submittedModel = input.submittedModel
    if (input.rescheduledFrom !== undefined) item.rescheduledFrom = input.rescheduledFrom
    await this.table.put(item.id, item)
    return item
  }

  /**
   * 原子改一项；patch 里值为 undefined 表示「删掉这个字段」。
   *
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object | undefined>}
   */
  async update(id, patch) {
    const current = this.table.get(id)
    if (!current) return undefined
    const entries = Object.entries(patch ?? {})
    return this.table.update(id, (value) => {
      const next = { ...value }
      for (const [key, field] of entries) {
        if (field === undefined) delete next[key]
        else next[key] = field
      }
      return next
    })
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    return this.table.delete(id)
  }

  /**
   * @param {string} clientTag
   * @returns {object | undefined}
   */
  findByClientTag(clientTag) {
    if (typeof clientTag !== 'string' || clientTag === '') return undefined
    return this.all().find((item) => item.clientTag === clientTag)
  }

  /** @returns {{ total: number, waiting: number, sending: number, failed: number, abandoned: number, sessions: number }} */
  stats() {
    const items = this.all()
    const counts = { total: items.length, waiting: 0, sending: 0, failed: 0, abandoned: 0 }
    const sessions = new Set()
    for (const item of items) {
      if (counts[item.status] !== undefined) counts[item.status] += 1
      sessions.add(item.sessionId)
    }
    return { ...counts, sessions: sessions.size }
  }

  /**
   * 崩溃恢复：`sending` 说明上次进程在投递中途退出（投递结果未知）。
   * 已写投递记录 → 视为完成并清掉；没有记录 → 退回 waiting 重投。
   *
   * @param {{ delivered?: { get: (id: string) => unknown } }} [options]
   * @returns {Promise<{ requeued: number, completed: number }>}
   */
  async recover(options = {}) {
    const delivered = options.delivered
    let requeued = 0
    let completed = 0
    for (const item of this.all()) {
      if (item.status !== 'sending') continue
      if (delivered && typeof delivered.get === 'function' && delivered.get(item.id) !== undefined) {
        await this.remove(item.id)
        completed += 1
        continue
      }
      await this.update(item.id, { status: 'waiting' })
      requeued += 1
    }
    return { requeued, completed }
  }
}
