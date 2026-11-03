/**
 * dsh-offpeak-send · 宿主半侧入口。
 *
 * 职责：持久化 outbox（domain 表）→ 单 timer 到点投递 → HTTP 路由给 client 用 →
 * 附件清理器收尾。时间相位一律问 lib/core/clock.js，不自己写 Date 逻辑。
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { beijing, nextOffpeakStart, nextPeakStart, normalizeCfg, phaseAt, sendAt } from './core/clock.js'
import { HOLIDAYS_2026 } from './core/holidays.js'
import {
  KEEP_DELIVERED,
  LIMIT_GLOBAL,
  LIMIT_PER_SESSION,
  MAX_ATTEMPTS,
  OutboxStore,
  countPending,
  nextDueTime,
  planDeliveries,
  retryDelayMs,
} from './outbox.js'
import { deliverItem, registerOrphans } from './deliver.js'
import { createCleanupRunner } from './gc.js'

export const name = 'dsh-offpeak-send'
export const inject = ['storageDomain', 'webServer', 'attachments', 'sessionController', 'sessions']

/** Node timer 能表示的最大延迟；更远的时间要靠分段唤醒。 */
const MAX_TIMER_DELAY_MS = 2147483647
/** 进程启动后 10 分钟跑第一轮清理。 */
const BOOT_CLEANUP_DELAY_MS = 10 * 60_000
/** 登记 orphan 之后去抖 15 分钟再清理，避免连续取消/清空时反复扫盘。 */
const ORPHAN_CLEANUP_DEBOUNCE_MS = 15 * 60_000
/** 每天 03:00（北京时间）跑一轮。 */
const DAILY_CLEANUP_HOUR = 3
const ROUTE_PREFIX = '/dsh-offpeak-send'
const STAGE_MAX_BYTES = 32 * 1024 * 1024
const JSON_MAX_BYTES = 512 * 1024
const MAX_ATTACHMENTS = 20
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DEFAULT_DSH_HOME = 'D:/dsh'

/** 图像准入失败（dsh-attachment 的 isImageAdmissionError 覆盖的 code）→ 415。 */
const IMAGE_ADMISSION_CODES = new Set([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
])

const attachmentRefSchema = z.object({
  kind: z.enum(['image', 'file']),
  attachmentId: z.string().min(1),
  mediaType: z.string().optional(),
  name: z.string().optional(),
  bytes: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
})

const outboxItemSchema = z.object({
  id: z.string().min(1),
  clientTag: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string(),
  attachments: z.array(attachmentRefSchema),
  createdAt: z.number(),
  sendAt: z.number(),
  reason: z.literal('peak'),
  status: z.enum(['waiting', 'sending', 'failed', 'abandoned']),
  attempts: z.number(),
  lastError: z.string().optional(),
  submittedModel: z.string().optional(),
  rescheduledFrom: z.number().optional(),
})

const deliveredRecordSchema = z.object({
  id: z.string().min(1),
  clientTag: z.string().min(1),
  sessionId: z.string().min(1),
  deliveredAt: z.number(),
  text: z.string(),
  attachments: z.array(attachmentRefSchema),
  status: z.literal('delivered'),
  note: z.string().optional(),
  model: z.string().optional(),
})

const orphanRecordSchema = z.object({
  attachmentId: z.string().min(1),
  kind: z.enum(['image', 'file']),
  bytes: z.number(),
  addedAt: z.number(),
  origin: z.enum(['cancel', 'clear', 'abandoned', 'images-dropped']),
})

const quarantineRecordSchema = z.object({
  attachmentId: z.string().min(1),
  kind: z.enum(['image', 'file']),
  bytes: z.number(),
  quarantinedAt: z.number(),
  orphanId: z.string().optional(),
})

const cleanupReportSchema = z.object({
  id: z.string().min(1),
  at: z.number(),
  scannedFiles: z.number(),
  candidates: z.number(),
  quarantined: z.number(),
  purged: z.number(),
  keptReferenced: z.number(),
  keptSharedByMtime: z.number(),
  keptUnknown: z.number(),
  truncated: z.number().optional(),
  bytesFreed: z.number(),
  errors: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      path: z.string().optional(),
      id: z.string().optional(),
    }),
  ),
  note: z.string().optional(),
})

const OFFPEAK_DOMAIN = defineDomain({
  // storage-domain 的单位名必须匹配 /^[a-z][a-z0-9_]*$/（不允许连字符），所以域用下划线。
  name: 'dsh_offpeak_send',
  version: 1,
  tables: {
    outbox: domainTable(outboxItemSchema),
    delivered: domainTable(deliveredRecordSchema),
    orphans: domainTable(orphanRecordSchema),
    quarantine: domainTable(quarantineRecordSchema),
    cleanup_reports: domainTable(cleanupReportSchema),
  },
})

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/**
 * @returns {string}
 */
function resolveDshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : DEFAULT_DSH_HOME
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: `该路由只接受 ${allow}` })
}

/**
 * 读完请求体；超限返回 null（调用方回 413）。超限后继续排空连接，不留下半截请求。
 */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      overflow = true
      continue
    }
    chunks.push(chunk)
  }
  if (overflow) return null
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const body = await readBody(req, JSON_MAX_BYTES)
  if (body === null) throw new HttpError(413, 'too-large', `请求体超过 ${JSON_MAX_BYTES} 字节`)
  if (body.length === 0) return {}
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid-json', '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'invalid-json', '请求体不是合法 JSON')
  }
}

function requireString(value, field, max = 4096) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid-param', `${field} 必须是字符串`)
  if (value.length === 0) throw new HttpError(400, 'invalid-param', `${field} 不能为空`)
  if (value.length > max) throw new HttpError(400, 'invalid-param', `${field} 不能超过 ${max} 字符`)
  return value
}

function toAttachmentRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid-attachment', 'attachments 里每一项必须是对象')
  }
  const kind = value.kind
  if (kind !== 'image' && kind !== 'file') {
    throw new HttpError(400, 'invalid-attachment', 'attachments[].kind 只能是 image 或 file')
  }
  const ref = { kind, attachmentId: requireString(value.attachmentId, 'attachments[].attachmentId', 200) }
  if (kind === 'image') {
    if (typeof value.mediaType === 'string' && value.mediaType !== '') ref.mediaType = value.mediaType
    if (Number.isFinite(value.width)) ref.width = Math.trunc(value.width)
    if (Number.isFinite(value.height)) ref.height = Math.trunc(value.height)
  } else {
    ref.name = typeof value.name === 'string' && value.name !== '' ? value.name : 'file'
  }
  if (Number.isFinite(value.bytes)) ref.bytes = Math.trunc(value.bytes)
  if (typeof value.name === 'string' && value.name !== '' && kind === 'image') ref.name = value.name
  return ref
}

function decodeHeaderName(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 投递记录里按 clientTag 找：client 没收到响应用原 tag 重试时，不能再投一次。
 * 只覆盖最近 KEEP_DELIVERED 条（正常情况下足够）。
 */
function findDeliveredByClientTag(table, clientTag) {
  if (!table || typeof table.entries !== 'function') return undefined
  for (const [, record] of table.entries()) {
    if (record && record.clientTag === clientTag) return record
  }
  return undefined
}

/** 北京时间下一个 hour:00 距 now 的毫秒数（今天已过则算明天）。 */
function msUntilBeijingHour(now, hour) {
  const b = beijing(now)
  const elapsedMs = ((b.hour * 60 + b.minute) * 60 + b.second) * 1000 + (now % 1000)
  const delta = hour * 3_600_000 - elapsedMs
  return delta > 0 ? delta : delta + 86_400_000
}

function createRuntime(ctx) {
  const dshHome = resolveDshHome()
  const settingsPath = join(dshHome, 'offpeak-send', 'config.json')
  const logger = ctx.logger
  /** @type {any} */
  let domain
  /** @type {Record<string, any>} */
  let tables = {}
  /** @type {OutboxStore | undefined} */
  let store
  /** @type {ReturnType<typeof createCleanupRunner> | undefined} */
  let runner
  let config = { bufferMs: 3000, holidays: [...HOLIDAYS_2026], autoCleanup: true, peak: null, forceWorkday: false }
  let cfg = normalizeCfg({ ...config })
  let disposed = false
  let routeDisposers = []
  let timer
  let chain = Promise.resolve()
  let retryAt = {}
  const gc = { boot: undefined, daily: undefined, debounce: undefined, running: false, queued: false }

  function serialize(work) {
    const next = chain.then(work)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function deliveryDeps() {
    return { outbox: store, delivered: tables.delivered, orphans: tables.orphans, logger, keepDelivered: KEEP_DELIVERED }
  }

  function requestCleanup(reason) {
    if (disposed || !runner || config.autoCleanup !== true) return
    if (gc.debounce !== undefined) clearTimeout(gc.debounce)
    gc.debounce = setTimeout(() => {
      gc.debounce = undefined
      void runCleanup(reason)
    }, ORPHAN_CLEANUP_DEBOUNCE_MS)
    gc.debounce.unref?.()
  }

  async function runCleanup(reason) {
    if (disposed || !runner) return
    if (gc.running) {
      gc.queued = true
      return
    }
    gc.running = true
    try {
      const report = await runner.runOnce()
      if (report && report.skipped !== true) {
        logger.info(
          `dsh-offpeak-send: 清理（${reason}）扫描 ${report.scannedFiles} 个日志，隔离 ${report.quarantined} 个、永久删除 ${report.purged} 个`,
        )
      }
    } catch (error) {
      logger.warn(`dsh-offpeak-send: 清理（${reason}）失败：${String(error)}`)
    } finally {
      gc.running = false
      if (gc.queued && !disposed) {
        gc.queued = false
        requestCleanup('queued')
      }
    }
  }

  function scheduleDailyCleanup() {
    if (gc.daily !== undefined) clearTimeout(gc.daily)
    if (disposed) return
    const delay = msUntilBeijingHour(Date.now(), DAILY_CLEANUP_HOUR)
    gc.daily = setTimeout(() => {
      gc.daily = undefined
      void runCleanup('daily')
      scheduleDailyCleanup()
    }, delay)
    gc.daily.unref?.()
  }

  function armTimer() {
    clearTimer()
    if (disposed || !store) return
    const now = Date.now()
    const next = nextDueTime(store.all(), { retryAt, maxAttempts: MAX_ATTEMPTS })
    if (next === undefined) return
    const delay = Math.min(Math.max(next - now, 0), MAX_TIMER_DELAY_MS)
    timer = setTimeout(() => {
      timer = undefined
      void kick()
    }, delay)
    timer.unref?.()
  }

  async function runDelivery(item) {
    const result = await deliverItem(ctx, deliveryDeps(), item)
    if (result.ok) {
      delete retryAt[item.id]
      if ((result.droppedImages ?? 0) > 0) requestCleanup('images-dropped')
    } else if (result.abandoned) {
      delete retryAt[item.id]
      requestCleanup('abandoned')
    } else {
      retryAt[item.id] = Date.now() + retryDelayMs(result.attempts ?? 1)
    }
    return result
  }

  async function drainDue() {
    if (!store) return
    const now = Date.now()
    const groups = planDeliveries(store.all(), { now, retryAt, maxAttempts: MAX_ATTEMPTS })
    for (const group of groups) {
      for (const item of group.items) {
        if (disposed) return
        try {
          await runDelivery(item)
        } catch (error) {
          logger.warn(`dsh-offpeak-send: 投递 ${item.id} 抛错：${String(error)}`)
          retryAt[item.id] = Date.now() + retryDelayMs(1)
        }
      }
    }
  }

  function kick() {
    if (disposed) return
    const run = serialize(async () => {
      if (disposed) return
      await drainDue()
      armTimer()
    })
    run.catch((error) => logger.warn(`dsh-offpeak-send: 投递循环失败：${String(error)}`))
  }

  /** 重启时把「已经过了投递点但还在队列里」的项重新决策：还在高峰就改期到下一个谷时。 */
  async function rescheduleStale(now) {
    if (!store) return 0
    let changed = 0
    for (const item of store.all()) {
      if (item.status !== 'waiting' && item.status !== 'failed') continue
      if ((item.sendAt ?? 0) > now) continue
      if (phaseAt(now, cfg) === 'offpeak') continue
      const decision = sendAt(now, cfg)
      await store.update(item.id, { sendAt: decision.sendAt, rescheduledFrom: item.rescheduledFrom ?? item.sendAt })
      changed += 1
    }
    return changed
  }

  function configView() {
    return {
      bufferMs: cfg.bufferMs,
      holidays: [...cfg.holidays],
      autoCleanup: config.autoCleanup === true,
      // 峰段覆盖（测试/特殊排班用）：null = 官方默认 09:00-12:00、14:00-18:00
      peak: Array.isArray(config.peak) ? config.peak.map((range) => [range[0], range[1]]) : null,
      forceWorkday: config.forceWorkday === true,
    }
  }

  /** 校验并规范化峰段覆盖：[[start,end], ...]，分钟、左闭右开、非空、升序不重叠。 */
  function parsePeak(value) {
    if (!Array.isArray(value)) throw new HttpError(400, 'invalid-param', 'peak 必须是数组或 null')
    const ranges = value.map((range) => {
      if (!Array.isArray(range) || range.length !== 2) throw new HttpError(400, 'invalid-param', 'peak 里每项必须是 [startMinute, endMinute]')
      const start = range[0]
      const end = range[1]
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new HttpError(400, 'invalid-param', 'peak 的分钟数必须是整数')
      if (start < 0 || end > 1440 || start >= end) throw new HttpError(400, 'invalid-param', 'peak 需满足 0 <= start < end <= 1440')
      return [start, end]
    })
    if (ranges.length === 0) throw new HttpError(400, 'invalid-param', 'peak 不能是空数组（清空请传 null）')
    ranges.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i][0] < ranges[i - 1][1]) throw new HttpError(400, 'invalid-param', 'peak 区间不能重叠')
    }
    return ranges
  }

  async function loadConfig() {
    try {
      const text = await readFile(settingsPath, 'utf8')
      const parsed = JSON.parse(text)
      const next = { bufferMs: cfg.bufferMs, holidays: cfg.holidays, autoCleanup: config.autoCleanup, peak: config.peak, forceWorkday: config.forceWorkday }
      if (Number.isFinite(parsed?.bufferMs)) next.bufferMs = parsed.bufferMs
      if (Array.isArray(parsed?.holidays)) next.holidays = parsed.holidays.filter((item) => typeof item === 'string')
      if (typeof parsed?.autoCleanup === 'boolean') next.autoCleanup = parsed.autoCleanup
      if (parsed?.peak === null) next.peak = null
      else if (Array.isArray(parsed?.peak)) next.peak = parsePeak(parsed.peak)
      if (typeof parsed?.forceWorkday === 'boolean') next.forceWorkday = parsed.forceWorkday
      cfg = normalizeCfg({ ...next })
      config = { bufferMs: cfg.bufferMs, holidays: [...cfg.holidays], autoCleanup: next.autoCleanup, peak: next.peak ?? null, forceWorkday: next.forceWorkday === true }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return
      logger.warn(`dsh-offpeak-send: 读取设置失败，使用默认值：${String(error)}`)
    }
  }

  async function saveConfig() {
    try {
      await mkdir(dirname(settingsPath), { recursive: true })
      const temp = `${settingsPath}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(configView(), null, 2), 'utf8')
      await rename(temp, settingsPath)
      return true
    } catch (error) {
      logger.warn(`dsh-offpeak-send: 保存设置失败：${String(error)}`)
      return false
    }
  }

  function decorate(item) {
    return { ...item, remainingMs: Math.max(0, (item.sendAt ?? 0) - Date.now()) }
  }

  async function handleStage(req, res) {
    const kind = String(req.headers['x-offpeak-kind'] ?? '').trim().toLowerCase()
    if (kind !== 'image' && kind !== 'file') {
      throw new HttpError(400, 'invalid-kind', 'x-offpeak-kind 必须是 image 或 file')
    }
    const displayName = decodeHeaderName(req.headers['x-offpeak-name'])
    const mediaType = String(req.headers['x-offpeak-media-type'] ?? '').trim().toLowerCase()
    const body = await readBody(req, STAGE_MAX_BYTES)
    if (body === null) throw new HttpError(413, 'too-large', `附件超过 ${STAGE_MAX_BYTES} 字节`)
    if (body.length === 0) throw new HttpError(400, 'empty-body', '附件内容为空')
    const data = new Uint8Array(body)
    const service = ctx.attachments
    if (kind === 'image') {
      if (mediaType !== '' && !IMAGE_MEDIA_TYPES.has(mediaType)) {
        throw new HttpError(415, 'unsupported-image-type', `不支持的图像类型：${mediaType}`)
      }
      let refs
      try {
        refs = await service.saveImages([{ data, mediaType: mediaType || 'image/png', ...(displayName ? { name: displayName } : {}) }])
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : ''
        if (IMAGE_ADMISSION_CODES.has(code)) throw new HttpError(415, 'unsupported-image-type', String(error?.message ?? error))
        throw new HttpError(500, 'stage-failed', String(error?.message ?? error))
      }
      const ref = refs?.[0]
      if (!ref) throw new HttpError(500, 'stage-failed', '附件服务没有返回引用')
      sendJson(res, 200, {
        ok: true,
        ref: {
          kind: 'image',
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          width: ref.width,
          height: ref.height,
          bytes: ref.bytes,
          ...(typeof ref.name === 'string' && ref.name !== '' ? { name: ref.name } : displayName ? { name: displayName } : {}),
        },
      })
      return
    }
    let ref
    try {
      ref = await service.saveFile({ data, name: displayName ?? 'file' })
    } catch (error) {
      throw new HttpError(500, 'stage-failed', String(error?.message ?? error))
    }
    sendJson(res, 200, {
      ok: true,
      ref: { kind: 'file', attachmentId: ref.attachmentId, name: ref.name ?? displayName ?? 'file', bytes: ref.bytes },
    })
  }

  async function handleEnqueue(req, res) {
    const body = await readJson(req)
    const clientTag = requireString(body.clientTag, 'clientTag', 200)
    const sessionId = requireString(body.sessionId, 'sessionId', 200)
    const text = typeof body.text === 'string' ? body.text : ''
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : []
    if (rawAttachments.length > MAX_ATTACHMENTS) {
      throw new HttpError(400, 'too-many-attachments', `单条消息最多 ${MAX_ATTACHMENTS} 个附件`)
    }
    const attachments = rawAttachments.map(toAttachmentRef)
    if (text.trim() === '' && attachments.length === 0) {
      throw new HttpError(400, 'empty-message', '文本和附件不能同时为空')
    }
    const submittedModel = typeof body.submittedModel === 'string' && body.submittedModel !== '' ? body.submittedModel : undefined
    const existing = store.findByClientTag(clientTag)
    if (existing) {
      sendJson(res, 200, { ok: true, item: decorate(existing), deduped: true })
      return
    }
    const alreadyDelivered = findDeliveredByClientTag(tables.delivered, clientTag)
    if (alreadyDelivered) {
      sendJson(res, 200, { ok: true, delivered: true, deduped: true, deliveredAt: alreadyDelivered.deliveredAt })
      return
    }
    const items = store.all()
    if (items.length >= LIMIT_GLOBAL) throw new HttpError(429, 'queue-full', `全局队列已满（${LIMIT_GLOBAL}）`)
    if (items.filter((item) => item.sessionId === sessionId).length >= LIMIT_PER_SESSION) {
      throw new HttpError(429, 'queue-full', `该会话队列已满（${LIMIT_PER_SESSION}）`)
    }
    const now = Date.now()
    const decision = sendAt(now, cfg)
    const item = await store.add({
      clientTag,
      sessionId,
      text,
      attachments,
      createdAt: now,
      sendAt: decision.sendAt,
      submittedModel,
    })
    if (!decision.delayed) {
      const result = await serialize(() => runDelivery(item))
      armTimer()
      if (result.ok) {
        sendJson(res, 200, { ok: true, delivered: true })
        return
      }
      const latest = store.get(item.id)
      sendJson(res, 200, {
        ok: true,
        delivered: false,
        abandoned: result.abandoned === true,
        item: latest ? decorate(latest) : null,
      })
      return
    }
    armTimer()
    sendJson(res, 200, { ok: true, item: decorate(item) })
  }

  async function handlePending(req, res) {
    const url = new URL(req.url ?? ROUTE_PREFIX, 'http://127.0.0.1')
    const sessionId = requireString(url.searchParams.get('sessionId') ?? '', 'sessionId', 200)
    const now = Date.now()
    const items = store.list(sessionId).map(decorate)
    const others = countPending(store.all().filter((item) => item.sessionId !== sessionId))
    sendJson(res, 200, { ok: true, serverNow: now, items, others })
  }

  async function handleAction(req, res) {
    const body = await readJson(req)
    const id = requireString(body.id, 'id', 200)
    const action = requireString(body.action, 'action', 32)
    const item = store.get(id)
    if (!item) throw new HttpError(404, 'not-found', '没有这个待发项')
    if (action === 'send-now') {
      if (item.status === 'sending') throw new HttpError(409, 'delivery-in-progress', '这一项正在投递中')
      const result = await serialize(() => runDelivery(item))
      armTimer()
      const latest = store.get(id)
      sendJson(res, 200, { ok: true, delivered: result.ok === true, item: latest ? decorate(latest) : null })
      return
    }
    if (action === 'cancel') {
      if (item.status === 'sending') throw new HttpError(409, 'delivery-in-progress', '这一项正在投递中，不能取消')
      await registerOrphans(tables.orphans, item.attachments, { origin: 'cancel' })
      await store.remove(id)
      delete retryAt[id]
      armTimer()
      requestCleanup('cancel')
      sendJson(res, 200, { ok: true })
      return
    }
    if (action === 'retry') {
      const decision = sendAt(Date.now(), cfg)
      const next = await store.update(id, {
        status: 'waiting',
        attempts: 0,
        lastError: undefined,
        sendAt: decision.sendAt,
        rescheduledFrom: undefined,
      })
      delete retryAt[id]
      armTimer()
      sendJson(res, 200, { ok: true, item: next ? decorate(next) : null })
      return
    }
    throw new HttpError(400, 'invalid-action', "action 只能是 send-now / cancel / retry")
  }

  async function handleClear(req, res) {
    const body = await readJson(req)
    const sessionId = requireString(body.sessionId, 'sessionId', 200)
    let cleared = 0
    for (const item of store.list(sessionId)) {
      if (item.status === 'sending') continue
      await registerOrphans(tables.orphans, item.attachments, { origin: 'clear' })
      await store.remove(item.id)
      delete retryAt[item.id]
      cleared += 1
    }
    armTimer()
    if (cleared > 0) requestCleanup('clear')
    sendJson(res, 200, { ok: true, cleared })
  }

  async function handleFlush(req, res) {
    const body = await readJson(req)
    const sessionId = requireString(body.sessionId, 'sessionId', 200)
    const groups = planDeliveries(store.list(sessionId), {
      now: Date.now(),
      retryAt,
      maxAttempts: Number.MAX_SAFE_INTEGER,
      includeFuture: true,
    })
    let sent = 0
    let failed = 0
    for (const group of groups) {
      for (const item of group.items) {
        const result = await serialize(() => runDelivery(item))
        if (result.ok) sent += 1
        else failed += 1
      }
    }
    armTimer()
    sendJson(res, 200, { ok: true, sent, failed })
  }

  async function handleCleanupList(req, res) {
    const reports = [...(tables.cleanup_reports?.entries?.() ?? [])]
      .map(([, value]) => value)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 20)
    const quarantine = [...(tables.quarantine?.entries?.() ?? [])]
      .map(([key, value]) => ({ ...value, key }))
      .sort((a, b) => (b.quarantinedAt ?? 0) - (a.quarantinedAt ?? 0))
    const quarantineBytes = quarantine.reduce((sum, entry) => sum + Number(entry.bytes ?? 0), 0)
    sendJson(res, 200, { ok: true, reports, quarantine, quarantineBytes })
  }

  async function handleCleanupRestore(req, res) {
    const body = await readJson(req)
    const attachmentId = requireString(body.attachmentId, 'attachmentId', 200)
    const result = await runner.restore(attachmentId)
    if (result.ok) {
      sendJson(res, 200, { ok: true })
      return
    }
    if (result.code === 'not-found') throw new HttpError(404, 'not-found', result.message ?? '隔离区里没有这个附件')
    if (result.code === 'invalid-id') throw new HttpError(400, 'invalid-id', result.message ?? '附件 id 不合法')
    throw new HttpError(500, 'restore-failed', result.message ?? '还原失败')
  }

  async function handleConfigGet(req, res) {
    const now = Date.now()
    sendJson(res, 200, {
      ok: true,
      config: configView(),
      phase: phaseAt(now, cfg),
      nextOffpeakAt: nextOffpeakStart(now, cfg),
      nextPeakAt: nextPeakStart(now, cfg),
      pendingTotal: countPending(store.all()),
    })
  }

  async function handleConfigPost(req, res) {
    const body = await readJson(req)
    const next = { bufferMs: cfg.bufferMs, holidays: [...cfg.holidays], autoCleanup: config.autoCleanup === true, peak: config.peak, forceWorkday: config.forceWorkday }
    if (body.forceWorkday !== undefined) {
      if (typeof body.forceWorkday !== 'boolean') throw new HttpError(400, 'invalid-param', 'forceWorkday 必须是布尔值')
      next.forceWorkday = body.forceWorkday
    }
    if (body.peak !== undefined) {
      next.peak = body.peak === null ? null : parsePeak(body.peak)
    }
    if (body.bufferMs !== undefined) {
      if (!Number.isFinite(body.bufferMs)) throw new HttpError(400, 'invalid-param', 'bufferMs 必须是数字')
      next.bufferMs = body.bufferMs
    }
    if (body.holidays !== undefined) {
      if (!Array.isArray(body.holidays)) throw new HttpError(400, 'invalid-param', 'holidays 必须是字符串数组')
      next.holidays = body.holidays.map((day) => {
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          throw new HttpError(400, 'invalid-param', 'holidays 里每项必须是 YYYY-MM-DD')
        }
        return day
      })
    }
    if (body.autoCleanup !== undefined) {
      if (typeof body.autoCleanup !== 'boolean') throw new HttpError(400, 'invalid-param', 'autoCleanup 必须是布尔值')
      next.autoCleanup = body.autoCleanup
    }
    cfg = normalizeCfg({ ...next })
    config = { bufferMs: cfg.bufferMs, holidays: [...cfg.holidays], autoCleanup: next.autoCleanup, peak: next.peak ?? null, forceWorkday: next.forceWorkday === true }
    const persisted = await saveConfig()
    if (config.autoCleanup !== true) {
      if (gc.debounce !== undefined) clearTimeout(gc.debounce)
      gc.debounce = undefined
    }
    sendJson(res, 200, { ok: true, config: configView(), persisted })
  }

  /**
   * @param {string} methods - 允许的方法，多个用逗号分隔（如 'GET,POST'）。
   *   同 path 只能注册一次（webServer 对重复的 kind+path 会抛错），所以 /config 走合并路由。
   */
  function wrap(methods, handler) {
    const allowed = methods.split(',').map((entry) => entry.trim())
    return async (req, res) => {
      try {
        if (!allowed.includes(req.method)) {
          sendMethodNotAllowed(res, allowed.join(', '))
          return
        }
        await handler(req, res)
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
          return
        }
        logger.warn(`dsh-offpeak-send: 路由 ${req.method} ${req.url} 失败：${String(error)}`)
        sendJson(res, 500, { ok: false, code: 'internal', message: '内部错误' })
      }
    }
  }

  function registerRoutes() {
    const routes = [
      ['POST', '/stage', handleStage],
      ['POST', '/enqueue', handleEnqueue],
      ['GET', '/pending', handlePending],
      ['POST', '/action', handleAction],
      ['POST', '/clear', handleClear],
      ['POST', '/flush', handleFlush],
      ['GET', '/cleanup', handleCleanupList],
      ['POST', '/cleanup/restore', handleCleanupRestore],
      [
        'GET,POST',
        '/config',
        async (req, res) => {
          if (req.method === 'GET') {
            await handleConfigGet(req, res)
            return
          }
          await handleConfigPost(req, res)
        },
      ],
    ]
    routeDisposers = routes.map(([method, path, handler]) =>
      ctx.webServer.register({ kind: 'exact', path: ROUTE_PREFIX + path, handler: wrap(method, handler) }),
    )
  }

  async function start() {
    await loadConfig()
    domain = await ctx.storageDomain.open(OFFPEAK_DOMAIN)
    tables = {
      outbox: domain.table('outbox'),
      delivered: domain.table('delivered'),
      orphans: domain.table('orphans'),
      quarantine: domain.table('quarantine'),
      cleanup_reports: domain.table('cleanup_reports'),
    }
    store = new OutboxStore(tables.outbox)
    runner = createCleanupRunner({ dshHome, tables, logger })
    const recovery = await store.recover({ delivered: tables.delivered })
    const now = Date.now()
    const rescheduled = await rescheduleStale(now)
    registerRoutes()
    armTimer()
    scheduleDailyCleanup()
    gc.boot = setTimeout(() => {
      gc.boot = undefined
      void runCleanup('boot')
    }, BOOT_CLEANUP_DELAY_MS)
    gc.boot.unref?.()
    const stats = store.stats()
    logger.info(
      `dsh-offpeak-send: 就绪（相位 ${phaseAt(now, cfg)}，待发 ${stats.total} 条，恢复 ${recovery.requeued} 条、改期 ${rescheduled} 条）`,
    )
    if (recovery.requeued > 0) kick()
  }

  async function stop() {
    disposed = true
    clearTimer()
    for (const key of ['boot', 'daily', 'debounce']) {
      if (gc[key] !== undefined) clearTimeout(gc[key])
      gc[key] = undefined
    }
    for (const dispose of routeDisposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`dsh-offpeak-send: 注销路由失败：${String(error)}`)
      }
    }
    try {
      await chain
    } catch {
      /* 投递链自己吞掉错误 */
    }
    try {
      await domain?.close()
    } catch (error) {
      logger.warn(`dsh-offpeak-send: 关闭 domain 失败：${String(error)}`)
    }
    domain = undefined
    store = undefined
    runner = undefined
  }

  return { start, stop, stats: () => store?.stats() }
}

export function apply(ctx) {
  const runtime = createRuntime(ctx)
  ctx.effect(() => {
    const starting = runtime.start()
    starting.catch((error) => {
      ctx.logger.warn(`dsh-offpeak-send: 启动失败：${String(error)}`)
    })
    return async () => {
      await starting.catch(() => undefined)
      await runtime.stop()
    }
  }, 'dsh-offpeak-send: host')
}

export { OFFPEAK_DOMAIN }
