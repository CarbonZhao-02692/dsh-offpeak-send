/**
 * 附件清理器（PLAN §6.4 / v4 两段式）。
 *
 * 对象库里没有删除 API（dsh-attachment 自己承认对象会一直 unreachable），所以只能自己
 * 在文件系统上做：引用核对 → rename 进 .offpeak-trash（第一段）→ 7 天后 fs.rm（第二段）。
 * 任何一步判断失误都会删掉用户还在用的图，所以这里的规则是「宁可留」：
 * 引用集不全（扫描超预算）、对象比 orphan 记录还老、没有 orphan 记录 —— 一律不动。
 */
import nodeFs from 'node:fs/promises'
import nodePath from 'node:path'
import nodeZlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { normalizeAttachmentId, selectStale } from './outbox.js'

/** zstd 帧魔数（小端读出 0xFD2FB528）。 */
export const ZSTD_MAGIC = 4247762216

/** 隔离区保留 7 天。 */
export const QUARANTINE_TTL_MS = 7 * 24 * 3600 * 1000
/** 隔离区总量上限 2 GB，超出按最旧先删。 */
export const QUARANTINE_CAP_BYTES = 2 * 1024 * 1024 * 1024
/** 单轮安全阀：≤200 个对象 / ≤500 MB。 */
export const ROUND_MAX_OBJECTS = 200
export const ROUND_MAX_BYTES = 500 * 1024 * 1024
/** 单轮预算 120s；超预算就带着进度停，下一轮续跑（引用缓存按 mtime+size 复用）。 */
export const ROUND_BUDGET_MS = 120_000

export const TRASH_DIRNAME = '.offpeak-trash'

const HEX64 = /^[0-9a-f]{64}$/
const LOG_NAME = /\.jsonl(\.zstd)?$/

const defaultFs = {
  readdir: (...args) => nodeFs.readdir(...args),
  readFile: (...args) => nodeFs.readFile(...args),
  stat: (...args) => nodeFs.stat(...args),
  rename: (...args) => nodeFs.rename(...args),
  rm: (...args) => nodeFs.rm(...args),
  mkdir: (...args) => nodeFs.mkdir(...args),
}

/** @param {string} dshHome */
export function objectRoot(dshHome) {
  return nodePath.join(dshHome, 'attachments', 'v1')
}

/** @param {string} dshHome */
export function trashDir(dshHome) {
  return nodePath.join(objectRoot(dshHome), TRASH_DIRNAME)
}

/**
 * 对象在对象库里的相对路径：桶目录取 id 前两位，文件名是完整 64 位十六进制（实测）。
 *
 * @param {'image' | 'file'} kind
 * @param {string} attachmentId
 * @returns {string}
 */
export function objectRelPath(kind, attachmentId) {
  const hex = normalizeAttachmentId(attachmentId)
  return nodePath.join(kind === 'file' ? 'file-objects' : 'objects', hex.slice(0, 2), hex)
}

/**
 * 扫描 zstd 帧边界。
 *
 * 会话日志是「多个独立 zstd 帧首尾相接」的字节流，Node 的 zstdDecompressSync 只解第一帧
 * （实测只拿到 190 字节的头部行），所以必须先切帧再逐帧解压。
 *
 * @param {Buffer | Uint8Array} input
 * @param {{ maxFrames?: number }} [options]
 * @returns {{ frames: { start: number, end: number }[], tornStart?: number, reason?: string }}
 */
export function scanZstdFrames(input, options = {}) {
  const buffer = input
  const maxFrames = options.maxFrames ?? 200_000
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: offset, reason: 'magic' }
    if (offset + 5 > buffer.length) return { frames, tornStart: offset, reason: 'truncated' }
    const descriptor = buffer.readUInt8(offset + 4)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const hasChecksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    let cursor = offset + 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    let complete = false
    while (cursor + 3 <= buffer.length) {
      const header = buffer.readUIntLE(cursor, 3)
      cursor += 3
      const last = (header & 1) === 1
      const blockType = (header >>> 1) & 3
      const blockSize = header >>> 3
      if (blockType === 3) return { frames, tornStart: offset, reason: 'reserved-block' }
      cursor += blockType === 1 ? 1 : blockSize
      if (cursor > buffer.length) return { frames, tornStart: offset, reason: 'truncated' }
      if (last) {
        complete = true
        break
      }
    }
    if (!complete) return { frames, tornStart: offset, reason: 'truncated' }
    if (hasChecksum) cursor += 4
    if (cursor > buffer.length) return { frames, tornStart: offset, reason: 'truncated' }
    frames.push({ start: offset, end: cursor })
    offset = cursor
    if (frames.length >= maxFrames) break
  }
  return offset < buffer.length ? { frames, tornStart: offset, reason: 'trailing' } : { frames }
}

/**
 * 从一段文本里收集 64 位十六进制 id；返回需要与下一段拼接的尾巴（id 可能跨帧）。
 *
 * @param {string} text
 * @param {Set<string>} into
 * @returns {string}
 */
export function collectHexIds(text, into) {
  for (const match of text.matchAll(/[0-9a-f]{64}/g)) into.add(match[0])
  return text.length > 63 ? text.slice(-63) : text
}

/**
 * 把一个日志文件解出全部 attachmentId。
 *
 * @param {Buffer} buffer
 * @param {{ zstdDecompressSync: (chunk: Buffer) => Buffer }} zlib
 * @returns {Set<string>}
 */
export function idsFromLogBuffer(buffer, zlib) {
  const ids = new Set()
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    let carry = ''
    for (const frame of scanZstdFrames(buffer).frames) {
      let chunk
      try {
        chunk = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end))
      } catch {
        continue
      }
      carry = collectHexIds(carry + chunk.toString('utf8'), ids)
    }
    return ids
  }
  collectHexIds(buffer.toString('utf8'), ids)
  return ids
}

/**
 * 引用核对：把对象分成「还在用」「可能有更早的引用者（mtime 太新/太旧）」「没有 orphan 记录」三类，
 * 只有剩下的一类才是清理候选。
 *
 * @param {{ attachmentId: string, mtimeMs: number, bytes?: number, kind?: string, path?: string }[]} objects
 * @param {{ references?: Set<string>, orphans?: Map<string, object> }} [options]
 * @returns {{ candidates: object[], keptReferenced: object[], keptSharedByMtime: object[], keptUnknown: object[] }}
 */
export function classifyCandidates(objects, options = {}) {
  const references = options.references ?? new Set()
  const orphans = options.orphans ?? new Map()
  const candidates = []
  const keptReferenced = []
  const keptSharedByMtime = []
  const keptUnknown = []
  for (const object of Array.isArray(objects) ? objects : []) {
    if (!object) continue
    const id = normalizeAttachmentId(object.attachmentId)
    if (references.has(id)) {
      keptReferenced.push(object)
      continue
    }
    const orphan = orphans.get(id) ?? orphans.get(`sha256:${id}`)
    if (!orphan) {
      keptUnknown.push(object)
      continue
    }
    const addedAt = Number(orphan.addedAt ?? 0)
    if (Number(object.mtimeMs ?? 0) < addedAt) {
      keptSharedByMtime.push(object)
      continue
    }
    candidates.push({ ...object, attachmentId: id, orphanAddedAt: addedAt, orphanOrigin: orphan.origin })
  }
  return { candidates, keptReferenced, keptSharedByMtime, keptUnknown }
}

/**
 * 单轮安全阀：最旧的先处理，最多 maxObjects 个、最多 maxBytes 字节。
 *
 * @param {object[]} candidates
 * @param {{ maxObjects?: number, maxBytes?: number }} [limits]
 * @returns {{ accepted: object[], truncated: object[], bytes: number }}
 */
export function applyRoundLimits(candidates, limits = {}) {
  const maxObjects = limits.maxObjects ?? ROUND_MAX_OBJECTS
  const maxBytes = limits.maxBytes ?? ROUND_MAX_BYTES
  const sorted = [...(Array.isArray(candidates) ? candidates : [])].sort(
    (a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) || String(a.attachmentId).localeCompare(String(b.attachmentId)),
  )
  const accepted = []
  const truncated = []
  let bytes = 0
  for (const candidate of sorted) {
    const size = Number(candidate.bytes ?? 0)
    if (accepted.length >= maxObjects || (accepted.length > 0 && bytes + size > maxBytes)) {
      truncated.push(candidate)
      continue
    }
    accepted.push(candidate)
    bytes += size
  }
  return { accepted, truncated, bytes }
}

/**
 * 到期（隔离满 7 天）的条目。
 *
 * @param {object[]} entries
 * @param {{ now?: number, ttlMs?: number }} [options]
 * @returns {object[]}
 */
export function selectExpired(entries, options = {}) {
  const now = options.now ?? 0
  const ttlMs = options.ttlMs ?? QUARANTINE_TTL_MS
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const at = Number(entry?.value?.quarantinedAt ?? entry?.quarantinedAt ?? 0)
    return now - at >= ttlMs
  })
}

/**
 * 隔离区超上限时，从最旧的开始删到限额内。
 *
 * @param {object[]} entries
 * @param {{ capBytes?: number }} [options]
 * @returns {{ purged: object[], bytes: number }}
 */
export function selectOverCap(entries, options = {}) {
  const capBytes = options.capBytes ?? QUARANTINE_CAP_BYTES
  const sorted = [...(Array.isArray(entries) ? entries : [])].sort(
    (a, b) =>
      Number(a?.value?.quarantinedAt ?? a?.quarantinedAt ?? 0) -
      Number(b?.value?.quarantinedAt ?? b?.quarantinedAt ?? 0),
  )
  let total = sorted.reduce((sum, entry) => sum + Number(entry?.value?.bytes ?? entry?.bytes ?? 0), 0)
  const purged = []
  for (const entry of sorted) {
    if (total <= capBytes) break
    purged.push(entry)
    total -= Number(entry?.value?.bytes ?? entry?.bytes ?? 0)
  }
  return { purged, bytes: total }
}

/**
 * @param {object[]} entries
 * @param {{ now?: number, ttlMs?: number, capBytes?: number }} [options]
 * @returns {{ purged: object[], remaining: object[], bytes: number }}
 */
export function planQuarantinePurge(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  const expired = selectExpired(list, options)
  const rest = list.filter((entry) => !expired.includes(entry))
  const over = selectOverCap(rest, options)
  const remaining = rest.filter((entry) => !over.purged.includes(entry))
  return { purged: [...expired, ...over.purged], remaining, bytes: over.bytes }
}

/**
 * @param {object | undefined} table
 * @returns {{ key: string, value: object }[]}
 */
function entriesOf(table) {
  if (!table || typeof table.entries !== 'function') return []
  return [...table.entries()].map(([key, value]) => ({ key, value }))
}

/**
 * @param {object | undefined} table
 * @returns {Set<string>}
 */
export function collectReferenceIds(table) {
  const ids = new Set()
  for (const { value } of entriesOf(table)) {
    for (const ref of Array.isArray(value?.attachments) ? value.attachments : []) {
      const id = normalizeAttachmentId(ref?.attachmentId)
      if (id !== '') ids.add(id)
    }
  }
  return ids
}

/** @param {object | undefined} table @returns {Map<string, object>} */
export function orphanIndex(table) {
  const map = new Map()
  for (const { key, value } of entriesOf(table)) {
    if (!value || typeof value !== 'object') continue
    const id = normalizeAttachmentId(value.attachmentId ?? key)
    if (id === '') continue
    if (!map.has(id)) map.set(id, value)
  }
  return map
}

/**
 * 列对象库里的所有对象（图像 + 文件）。目录不存在 → 视为布局变化，只告警不清理。
 *
 * @param {{ dshHome: string, fs?: typeof defaultFs }} options
 * @returns {Promise<{ layoutMissing: boolean, items: object[] }>}
 */
export async function listObjects(options) {
  const dshHome = options.dshHome
  const fs = options.fs ?? defaultFs
  const root = objectRoot(dshHome)
  try {
    await fs.readdir(root)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { layoutMissing: true, items: [] }
    throw error
  }
  const items = []
  for (const kind of ['image', 'file']) {
    const dir = nodePath.join(root, kind === 'file' ? 'file-objects' : 'objects')
    let buckets
    try {
      buckets = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const bucket of buckets) {
      if (!/^[0-9a-f]{2}$/.test(bucket)) continue
      let names
      try {
        names = await fs.readdir(nodePath.join(dir, bucket))
      } catch {
        continue
      }
      for (const name of names) {
        if (!HEX64.test(name)) continue
        const path = nodePath.join(dir, bucket, name)
        let stats
        try {
          stats = await fs.stat(path)
        } catch {
          continue
        }
        if (typeof stats.isFile === 'function' && !stats.isFile()) continue
        items.push({
          attachmentId: name,
          kind,
          path,
          bytes: Number(stats.size ?? 0),
          mtimeMs: Number(stats.mtimeMs ?? 0),
        })
      }
    }
  }
  return { layoutMissing: false, items }
}

/**
 * 引用索引：<DSH_HOME>/sessions 下所有 .jsonl / .jsonl.zstd 里的 attachmentId。
 * 425 个日志解压后 500 MB 级别，所以按 (mtimeMs,size) 缓存每个文件的结果，跨轮复用。
 *
 * @param {{ dshHome: string, fs?: typeof defaultFs, zlib?: { zstdDecompressSync: Function }, logger?: object }} options
 */
export function createReferenceIndex(options) {
  const dshHome = options.dshHome
  const fs = options.fs ?? defaultFs
  const zlib = options.zlib ?? nodeZlib
  const cache = new Map()

  async function walk(dir, depth, out) {
    if (depth > 4) return out
    let names
    try {
      names = await fs.readdir(dir)
    } catch {
      return out
    }
    for (const name of names) {
      const path = nodePath.join(dir, name)
      let stats
      try {
        stats = await fs.stat(path)
      } catch {
        continue
      }
      if (typeof stats.isDirectory === 'function' && stats.isDirectory()) {
        await walk(path, depth + 1, out)
        continue
      }
      if (LOG_NAME.test(name)) out.push({ path, mtimeMs: Number(stats.mtimeMs ?? 0), size: Number(stats.size ?? 0) })
    }
    return out
  }

  /**
   * @param {{ budgetMs?: number, force?: boolean }} [opts]
   * @returns {Promise<{ ids: Set<string>, filesScanned: number, filesTotal: number, complete: boolean, errors: object[] }>}
   */
  async function scan(opts = {}) {
    const budgetMs = opts.budgetMs ?? 600_000
    const deadline = Date.now() + budgetMs
    const ids = new Set()
    const errors = []
    const logs = await walk(nodePath.join(dshHome, 'sessions'), 0, [])
    let filesScanned = 0
    let complete = true
    for (const log of logs) {
      if (Date.now() > deadline) {
        complete = false
        break
      }
      const signature = `${log.mtimeMs}:${log.size}`
      const cached = cache.get(log.path)
      if (!opts.force && cached && cached.signature === signature) {
        for (const id of cached.ids) ids.add(id)
        filesScanned += 1
        continue
      }
      let buffer
      try {
        buffer = await fs.readFile(log.path)
      } catch (error) {
        errors.push({ code: 'read-failed', message: String(error?.message ?? error), path: log.path })
        continue
      }
      let fileIds
      try {
        fileIds = idsFromLogBuffer(buffer, zlib)
      } catch (error) {
        errors.push({ code: 'decode-failed', message: String(error?.message ?? error), path: log.path })
        continue
      }
      cache.set(log.path, { signature, ids: fileIds })
      for (const id of fileIds) ids.add(id)
      filesScanned += 1
    }
    return { ids, filesScanned, filesTotal: logs.length, complete, errors }
  }

  return {
    scan,
    cache,
    clear() {
      cache.clear()
    },
  }
}

/**
 * 清理执行器：runOnce() 跑一轮，restore() 从隔离区救回一个附件。
 *
 * @param {{
 *   dshHome: string,
 *   tables: { outbox?: object, delivered?: object, orphans?: object, quarantine?: object, cleanup_reports?: object },
 *   fs?: typeof defaultFs,
 *   zlib?: object,
 *   logger?: object,
 *   now?: () => number,
 *   limits?: object,
 *   index?: object,
 * }} options
 */
export function createCleanupRunner(options) {
  const dshHome = options.dshHome
  const fs = options.fs ?? defaultFs
  const logger = options.logger ?? { info() {}, warn() {} }
  const now = options.now ?? (() => Date.now())
  const tables = options.tables ?? {}
  const limits = {
    maxObjects: ROUND_MAX_OBJECTS,
    maxBytes: ROUND_MAX_BYTES,
    budgetMs: ROUND_BUDGET_MS,
    ttlMs: QUARANTINE_TTL_MS,
    capBytes: QUARANTINE_CAP_BYTES,
    keepReports: 20,
    ...(options.limits ?? {}),
  }
  const index = options.index ?? createReferenceIndex({ dshHome, fs, zlib: options.zlib ?? nodeZlib, logger })
  let running = false

  async function writeReport(report) {
    const table = tables.cleanup_reports
    if (!table) return
    try {
      await table.put(report.id, report)
      const stale = selectStale(
        entriesOf(table).map((entry) => entry.value),
        { keep: limits.keepReports, timeKey: 'at', keyOf: (entry) => entry.id },
      )
      for (const id of stale) await table.delete(id)
    } catch (error) {
      logger.warn(`dsh-offpeak-send: 清理报告写入失败：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 跑一轮清理。busy 时直接返回 skipped（调用方稍后再踢）。
   *
   * @param {{ budgetMs?: number, force?: boolean }} [overrides]
   * @returns {Promise<object>}
   */
  async function runOnce(overrides = {}) {
    if (running) return { skipped: true, reason: 'busy' }
    running = true
    const startedAt = now()
    const budgetMs = overrides.budgetMs ?? limits.budgetMs
    const deadline = startedAt + budgetMs
    const errors = []
    const report = {
      id: randomUUID(),
      at: startedAt,
      scannedFiles: 0,
      candidates: 0,
      quarantined: 0,
      purged: 0,
      keptReferenced: 0,
      keptSharedByMtime: 0,
      keptUnknown: 0,
      truncated: 0,
      bytesFreed: 0,
      errors,
    }
    try {
      // 第二段：隔离区到期/超限（不依赖引用扫描，先做）
      const quarantineEntries = entriesOf(tables.quarantine)
      const purge = planQuarantinePurge(quarantineEntries, {
        now: startedAt,
        ttlMs: limits.ttlMs,
        capBytes: limits.capBytes,
      })
      for (const entry of purge.purged) {
        const hex = normalizeAttachmentId(entry.value?.attachmentId ?? entry.key)
        const bytes = Number(entry.value?.bytes ?? 0)
        try {
          await fs.rm(nodePath.join(trashDir(dshHome), hex), { force: true })
        } catch (error) {
          errors.push({ code: 'purge-failed', message: String(error?.message ?? error), id: hex })
          continue
        }
        await tables.quarantine?.delete(entry.key)
        report.purged += 1
        report.bytesFreed += bytes
      }

      // 第一段：扫对象库 + 引用核对 + rename 进隔离区
      const listed = await listObjects({ dshHome, fs })
      if (listed.layoutMissing) {
        report.note = 'attach-store-layout-missing'
        logger.warn('dsh-offpeak-send: 附件对象库目录不存在，跳过本轮清理（布局可能变化）')
        return report
      }
      const remaining = Math.max(2_000, deadline - now())
      const scan = await index.scan({ budgetMs: remaining, force: overrides.force === true })
      report.scannedFiles = scan.filesScanned
      if (scan.errors?.length > 0) for (const error of scan.errors) errors.push(error)
      if (!scan.complete) {
        report.note = 'reference-scan-incomplete'
        logger.warn('dsh-offpeak-send: 引用扫描未能在预算内完成，本轮不动任何对象（下轮续扫）')
        return report
      }
      const references = new Set(scan.ids)
      for (const id of collectReferenceIds(tables.outbox)) references.add(id)
      for (const id of collectReferenceIds(tables.delivered)) references.add(id)
      const classified = classifyCandidates(listed.items, {
        references,
        orphans: orphanIndex(tables.orphans),
      })
      report.candidates = classified.candidates.length
      report.keptReferenced = classified.keptReferenced.length
      report.keptSharedByMtime = classified.keptSharedByMtime.length
      report.keptUnknown = classified.keptUnknown.length
      const round = applyRoundLimits(classified.candidates, limits)
      report.truncated = round.truncated.length
      const trash = trashDir(dshHome)
      await fs.mkdir(trash, { recursive: true })
      for (const candidate of round.accepted) {
        if (now() > deadline) {
          report.note = 'round-budget-exceeded'
          break
        }
        const target = nodePath.join(trash, candidate.attachmentId)
        try {
          await fs.rename(candidate.path, target)
        } catch (error) {
          // 安全阀：rename 失败立刻停本轮，不重试
          errors.push({
            code: 'rename-failed',
            message: String(error?.message ?? error),
            id: candidate.attachmentId,
          })
          logger.warn(`dsh-offpeak-send: 隔离附件失败（本轮停止）：${String(error?.message ?? error)}`)
          break
        }
        await tables.quarantine?.put(candidate.attachmentId, {
          attachmentId: candidate.attachmentId,
          kind: candidate.kind,
          bytes: Number(candidate.bytes ?? 0),
          quarantinedAt: now(),
          orphanId: candidate.attachmentId,
        })
        report.quarantined += 1
      }
    } catch (error) {
      errors.push({ code: 'round-failed', message: String(error?.message ?? error) })
      logger.warn(`dsh-offpeak-send: 清理轮次失败：${String(error?.message ?? error)}`)
    } finally {
      running = false
      await writeReport(report)
    }
    if (report.quarantined > 0 || report.purged > 0) {
      logger.info(
        `dsh-offpeak-send: 清理完成，隔离 ${report.quarantined} 个、永久删除 ${report.purged} 个、释放 ${report.bytesFreed} 字节`,
      )
    }
    return report
  }

  /**
   * 从隔离区救回一个附件（rename 回去）；失败保留记录并报错。
   *
   * @param {string} attachmentId
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async function restore(attachmentId) {
    const hex = normalizeAttachmentId(attachmentId)
    if (!HEX64.test(hex)) return { ok: false, code: 'invalid-id', message: '附件 id 必须是 64 位十六进制' }
    const table = tables.quarantine
    const entry = entriesOf(table).find((candidate) => normalizeAttachmentId(candidate.key) === hex)
    if (!entry) return { ok: false, code: 'not-found', message: '隔离区里没有这个附件' }
    const kind = entry.value?.kind === 'file' ? 'file' : 'image'
    const target = nodePath.join(objectRoot(dshHome), objectRelPath(kind, hex))
    try {
      await fs.mkdir(nodePath.dirname(target), { recursive: true })
      await fs.rename(nodePath.join(trashDir(dshHome), hex), target)
    } catch (error) {
      logger.warn(`dsh-offpeak-send: 还原附件失败：${String(error?.message ?? error)}`)
      return { ok: false, code: 'restore-failed', message: String(error?.message ?? error) }
    }
    await table.delete(entry.key)
    return { ok: true }
  }

  return { runOnce, restore, index, limits }
}
