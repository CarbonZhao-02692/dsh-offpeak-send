import test from 'node:test'
import assert from 'node:assert/strict'
import nodePath from 'node:path'
import nodeZlib from 'node:zlib'
import {
  QUARANTINE_TTL_MS,
  applyRoundLimits,
  classifyCandidates,
  collectReferenceIds,
  createCleanupRunner,
  idsFromLogBuffer,
  listObjects,
  objectRelPath,
  objectRoot,
  orphanIndex,
  planQuarantinePurge,
  selectExpired,
  selectOverCap,
  trashDir,
} from '../lib/gc.js'
import { normalizeAttachmentId } from '../lib/outbox.js'

const DSH_HOME = '/gc-test-home'

/** 内存 fake domain 表。 */
function createTable(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() {
      return map.size
    },
    async put(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      return map.delete(key)
    },
    async update(key, fn) {
      if (!map.has(key)) throw new Error(`缺键 ${key}`)
      const next = fn(map.get(key))
      map.set(key, next)
      return next
    },
  }
}

const hex = (fill) => fill.repeat(64)
const norm = (value) => String(value).replace(/\\/g, '/')

/**
 * 内存 fake fs：只实现 gc.js 用到的 readdir/readFile/stat/rename/rm/mkdir。
 * 路径统一成正斜杠，方便断言。
 */
function createFakeFs(initialFiles = {}, options = {}) {
  const files = new Map()
  const dirs = new Set()
  const renames = []
  const removed = []
  const failRenameFor = new Set((options.failRenameFor ?? []).map(norm))
  function ensureDirsFor(path) {
    const parts = norm(path).split('/')
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'))
  }
  for (const [path, spec] of Object.entries(initialFiles)) {
    files.set(norm(path), {
      bytes: Number(spec.bytes ?? 0),
      mtimeMs: Number(spec.mtimeMs ?? 0),
      data: spec.data,
    })
    ensureDirsFor(path)
  }
  return {
    files,
    dirs,
    renames,
    removed,
    async readdir(dir) {
      const target = norm(dir)
      const present = dirs.has(target) || [...files.keys()].some((path) => path.startsWith(`${target}/`))
      if (!present) throw Object.assign(new Error(`ENOENT ${target}`), { code: 'ENOENT' })
      const names = new Set()
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(`${target}/`)) continue
        names.add(key.slice(target.length + 1).split('/')[0])
      }
      return [...names]
    },
    async stat(path) {
      const target = norm(path)
      const file = files.get(target)
      if (file) {
        return { size: file.bytes, mtimeMs: file.mtimeMs, isFile: () => true, isDirectory: () => false }
      }
      if (dirs.has(target)) {
        return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true }
      }
      throw Object.assign(new Error(`ENOENT ${target}`), { code: 'ENOENT' })
    },
    async rename(from, to) {
      const src = norm(from)
      const dst = norm(to)
      if (failRenameFor.has(src) || [...failRenameFor].some((suffix) => src.endsWith(suffix))) {
        throw new Error(`EPERM rename ${src}`)
      }
      const file = files.get(src)
      if (!file) throw Object.assign(new Error(`ENOENT ${src}`), { code: 'ENOENT' })
      files.delete(src)
      files.set(dst, file)
      ensureDirsFor(dst)
      renames.push({ from: src, to: dst })
    },
    async rm(path, opts) {
      const target = norm(path)
      if (files.delete(target)) {
        removed.push(target)
        return
      }
      if (opts && opts.force) {
        removed.push(target)
        return
      }
      throw Object.assign(new Error(`ENOENT ${target}`), { code: 'ENOENT' })
    },
    async mkdir(path) {
      const target = norm(path)
      dirs.add(target)
      ensureDirsFor(`${target}/x`)
    },
    async readFile(path) {
      const file = files.get(norm(path))
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return file.data ?? Buffer.alloc(file.bytes)
    },
  }
}

function objPath(kind, id) {
  return norm(nodePath.join(objectRoot(DSH_HOME), objectRelPath(kind, id)))
}

const silentLogger = { info() {}, warn() {}, error() {} }

function fullIndex(ids) {
  return {
    async scan() {
      return { ids: new Set(ids), filesScanned: 0, filesTotal: 0, complete: true, errors: [] }
    },
  }
}

function runnerOptions(fs, tables, extra = {}) {
  const now = extra.nowFactory ?? (() => 10_000)
  return {
    dshHome: DSH_HOME,
    fs,
    tables,
    logger: silentLogger,
    now,
    index: extra.index ?? fullIndex([]),
    limits: extra.limits,
  }
}

test('classifyCandidates：引用中 / 未引用有 orphan / mtime 太新 / 没有 orphan 四类', () => {
  const referenced = { attachmentId: hex('a'), mtimeMs: 9_000 }
  const candidate = { attachmentId: hex('b'), mtimeMs: 9_000 }
  const tooNew = { attachmentId: hex('c'), mtimeMs: 1_000 }
  const unknown = { attachmentId: hex('d'), mtimeMs: 9_000 }
  const orphans = new Map([
    [hex('b'), { attachmentId: hex('b'), addedAt: 5_000, origin: 'cancel' }],
    [hex('c'), { attachmentId: hex('c'), addedAt: 5_000, origin: 'clear' }],
  ])
  const classified = classifyCandidates([referenced, candidate, tooNew, unknown], {
    references: new Set([hex('a')]),
    orphans,
  })
  assert.deepEqual(
    classified.candidates.map((entry) => entry.attachmentId),
    [hex('b')],
  )
  assert.equal(classified.candidates[0].orphanOrigin, 'cancel')
  assert.deepEqual(
    classified.keptReferenced.map((entry) => entry.attachmentId),
    [hex('a')],
  )
  assert.deepEqual(
    classified.keptSharedByMtime.map((entry) => entry.attachmentId),
    [hex('c')],
  )
  assert.deepEqual(
    classified.keptUnknown.map((entry) => entry.attachmentId),
    [hex('d')],
  )
})

test('classifyCandidates：orphan 表 key 带 sha256: 前缀也能对上', () => {
  const orphans = new Map([[`sha256:${hex('e')}`, { attachmentId: `sha256:${hex('e')}`, addedAt: 1 }]])
  const classified = classifyCandidates([{ attachmentId: hex('e'), mtimeMs: 2 }], { orphans })
  assert.equal(classified.candidates.length, 1)
  assert.equal(classified.candidates[0].attachmentId, hex('e'), '产出统一裸十六进制')
})

test('applyRoundLimits：单轮 ≤200 个对象，最旧先处理，超出部分留到下一轮', () => {
  const candidates = Array.from({ length: 250 }, (_, index) => ({
    attachmentId: String(index).padStart(4, '0') + 'x'.repeat(60),
    mtimeMs: index,
    bytes: 10,
  }))
  const round = applyRoundLimits(candidates)
  assert.equal(round.accepted.length, 200)
  assert.equal(round.truncated.length, 50)
  assert.equal(round.bytes, 2_000)
  assert.equal(round.accepted[0].mtimeMs, 0)
  assert.equal(round.accepted.at(-1).mtimeMs, 199)
  assert.equal(round.truncated[0].mtimeMs, 200)
})

test('applyRoundLimits：字节上限优先，但允许第一个对象超额', () => {
  const big = [
    { attachmentId: 'a', mtimeMs: 1, bytes: 400 },
    { attachmentId: 'b', mtimeMs: 2, bytes: 400 },
    { attachmentId: 'c', mtimeMs: 3, bytes: 400 },
  ]
  const round = applyRoundLimits(big, { maxObjects: 10, maxBytes: 500 })
  assert.deepEqual(
    round.accepted.map((entry) => entry.attachmentId),
    ['a'],
  )
  assert.equal(round.truncated.length, 2)
  const oversized = applyRoundLimits([{ attachmentId: 'z', mtimeMs: 1, bytes: 10_000 }], { maxBytes: 500 })
  assert.equal(oversized.accepted.length, 1, '单个超大对象仍处理，否则永远卡住')
})

test('selectExpired：满 7 天才算到期', () => {
  const now = 10 * QUARANTINE_TTL_MS
  const entries = [
    { key: 'old', value: { quarantinedAt: now - QUARANTINE_TTL_MS - 1 } },
    { key: 'fresh', value: { quarantinedAt: now - 1_000 } },
  ]
  assert.deepEqual(
    selectExpired(entries, { now }).map((entry) => entry.key),
    ['old'],
  )
})

test('selectOverCap：隔离区超 2 GB 上限时从最旧的开始删', () => {
  const entries = [
    { key: 'oldest', value: { quarantinedAt: 1, bytes: 500 } },
    { key: 'mid', value: { quarantinedAt: 2, bytes: 400 } },
    { key: 'newest', value: { quarantinedAt: 3, bytes: 300 } },
  ]
  const result = selectOverCap(entries, { capBytes: 1_000 })
  assert.equal(result.bytes, 700)
  assert.deepEqual(
    result.purged.map((entry) => entry.key),
    ['oldest'],
  )
})

test('planQuarantinePurge：到期 + 超限一起算', () => {
  const plan = planQuarantinePurge(
    [
      { key: 'expired', value: { quarantinedAt: 0, bytes: 10 } },
      { key: 'a', value: { quarantinedAt: 900_000, bytes: 900 } },
      { key: 'b', value: { quarantinedAt: 950_000, bytes: 500 } },
    ],
    { now: 1_000_000, ttlMs: 100_000, capBytes: 1_000 },
  )
  assert.deepEqual(
    plan.purged.map((entry) => entry.key),
    ['expired', 'a'],
  )
  assert.ok(plan.bytes <= 1_000)
})

test('listObjects：扫图像桶与文件桶，布局缺失时只报 layoutMissing', async () => {
  const imageId = hex('1')
  const fileId = hex('2')
  const fs = createFakeFs({
    [objPath('image', imageId)]: { bytes: 7, mtimeMs: 1_000 },
    [objPath('file', fileId)]: { bytes: 3, mtimeMs: 2_000 },
  })
  const listed = await listObjects({ dshHome: DSH_HOME, fs })
  assert.equal(listed.layoutMissing, false)
  assert.deepEqual(
    listed.items.map((entry) => `${entry.kind}:${entry.attachmentId}:${entry.bytes}:${entry.mtimeMs}`).sort(),
    [`file:${fileId}:3:2000`, `image:${imageId}:7:1000`],
  )
  const missing = await listObjects({ dshHome: DSH_HOME, fs: createFakeFs() })
  assert.deepEqual(missing, { layoutMissing: true, items: [] })
})

test('collectReferenceIds / orphanIndex：从表记录里取附件与 orphan', () => {
  const table = createTable({
    r1: { attachments: [{ attachmentId: `sha256:${hex('a')}` }, { attachmentId: hex('b') }] },
    r2: { attachments: [] },
  })
  assert.deepEqual([...collectReferenceIds(table)].sort(), [hex('a'), hex('b')])
  assert.equal(collectReferenceIds(undefined).size, 0)
  const indexes = orphanIndex(
    createTable({ [`sha256:${hex('c')}`]: { attachmentId: `sha256:${hex('c')}`, addedAt: 1 } }),
  )
  assert.equal(indexes.get(hex('c')).addedAt, 1)
})

test('idsFromLogBuffer：普通 jsonl 与多帧 zstd 都能抽出 attachmentId', (t) => {
  const id = hex('a')
  const plain = idsFromLogBuffer(Buffer.from(`{"attachmentId":"sha256:${id}"}\n`, 'utf8'), nodeZlib)
  assert.ok(plain.has(id))

  if (typeof nodeZlib.zstdCompressSync !== 'function') {
    t.diagnostic('当前 node:zlib 没有 zstdCompressSync，跳过 zstd 用例')
    return
  }
  const first = nodeZlib.zstdCompressSync(Buffer.from(`{"attachments":[{"attachmentId":"sha256:${id.slice(0, 40)}`, 'utf8'))
  const second = nodeZlib.zstdCompressSync(Buffer.from(`${id.slice(40)}"}]}\n`, 'utf8'))
  const stream = Buffer.concat([first, second])
  const collected = idsFromLogBuffer(stream, nodeZlib)
  assert.ok(collected.has(id), 'id 跨帧被切开也要拼回来')
})

test('createCleanupRunner：引用中的不动，未引用且 mtime 合法的进隔离区', async () => {
  const referencedId = hex('a')
  const candidateId = hex('b')
  const tooNewId = hex('c')
  const unknownId = hex('d')
  const fs = createFakeFs({
    [objPath('image', referencedId)]: { bytes: 1, mtimeMs: 9_000 },
    [objPath('image', candidateId)]: { bytes: 20, mtimeMs: 9_000 },
    [objPath('image', tooNewId)]: { bytes: 1, mtimeMs: 1_000 },
    [objPath('file', unknownId)]: { bytes: 1, mtimeMs: 9_000 },
  })
  const tables = {
    outbox: createTable({ item1: { attachments: [{ attachmentId: `sha256:${referencedId}` }] } }),
    delivered: createTable(),
    orphans: createTable({
      [candidateId]: { attachmentId: candidateId, kind: 'image', bytes: 20, addedAt: 5_000, origin: 'cancel' },
      [tooNewId]: { attachmentId: tooNewId, kind: 'image', bytes: 1, addedAt: 5_000, origin: 'clear' },
    }),
    quarantine: createTable(),
    cleanup_reports: createTable(),
  }
  const runner = createCleanupRunner(runnerOptions(fs, tables))
  const report = await runner.runOnce()
  assert.equal(report.quarantined, 1)
  assert.equal(report.candidates, 1)
  assert.equal(report.keptReferenced, 1)
  assert.equal(report.keptSharedByMtime, 1)
  assert.equal(report.keptUnknown, 1)
  assert.equal(fs.renames.length, 1)
  assert.equal(fs.renames[0].from, objPath('image', candidateId))
  assert.equal(fs.renames[0].to, norm(nodePath.join(trashDir(DSH_HOME), candidateId)))
  assert.ok(fs.files.has(objPath('image', referencedId)), '引用中的对象原地不动')
  assert.equal(tables.quarantine.get(candidateId).bytes, 20)
  assert.equal(tables.cleanup_reports.size, 1)
})

test('createCleanupRunner：rename 失败立刻停本轮，后面的不再尝试', async () => {
  const firstId = hex('1')
  const secondId = hex('2')
  const fs = createFakeFs(
    {
      [objPath('image', firstId)]: { bytes: 1, mtimeMs: 5_000 },
      [objPath('image', secondId)]: { bytes: 1, mtimeMs: 6_000 },
    },
    { failRenameFor: [objPath('image', firstId)] },
  )
  const tables = {
    orphans: createTable({
      [firstId]: { attachmentId: firstId, addedAt: 1, bytes: 1 },
      [secondId]: { attachmentId: secondId, addedAt: 1, bytes: 1 },
    }),
    quarantine: createTable(),
    cleanup_reports: createTable(),
  }
  const runner = createCleanupRunner(runnerOptions(fs, tables))
  const report = await runner.runOnce()
  assert.equal(report.quarantined, 0)
  assert.equal(report.errors[0].code, 'rename-failed')
  assert.equal(fs.renames.length, 0)
  assert.equal(tables.quarantine.size, 0)
})

test('createCleanupRunner：引用扫描不完整时一个对象都不动', async () => {
  const fs = createFakeFs({ [objPath('image', hex('a'))]: { bytes: 1, mtimeMs: 9_000 } })
  const tables = {
    orphans: createTable({ [hex('a')]: { attachmentId: hex('a'), addedAt: 1, bytes: 1 } }),
    quarantine: createTable(),
    cleanup_reports: createTable(),
  }
  const index = { async scan() { return { ids: new Set(), filesScanned: 0, filesTotal: 9, complete: false, errors: [] } } }
  const runner = createCleanupRunner(runnerOptions(fs, tables, { index }))
  const report = await runner.runOnce()
  assert.equal(report.note, 'reference-scan-incomplete')
  assert.equal(report.quarantined, 0)
  assert.equal(fs.renames.length, 0)
})

test('createCleanupRunner：隔离区 7 天后永久删除，记录一并删掉', async () => {
  const expiredId = hex('9')
  const fs = createFakeFs({ [norm(nodePath.join(trashDir(DSH_HOME), expiredId))]: { bytes: 5, mtimeMs: 0 } })
  const tables = {
    quarantine: createTable({
      [expiredId]: { attachmentId: expiredId, kind: 'image', bytes: 5, quarantinedAt: 1_000 },
    }),
    cleanup_reports: createTable(),
  }
  const runner = createCleanupRunner(
    runnerOptions(fs, tables, { nowFactory: () => 1_000 + QUARANTINE_TTL_MS + 1 }),
  )
  const report = await runner.runOnce()
  assert.equal(report.purged, 1)
  assert.equal(report.bytesFreed, 5)
  assert.equal(tables.quarantine.size, 0)
  assert.ok(fs.removed.includes(norm(nodePath.join(trashDir(DSH_HOME), expiredId))))
})

test('createCleanupRunner：清理报告只留最近 20 条', async () => {
  const fs = createFakeFs()
  const tables = { quarantine: createTable(), cleanup_reports: createTable() }
  let clock = 0
  const runner = createCleanupRunner(
    runnerOptions(fs, tables, { nowFactory: () => (clock += 1_000) }),
  )
  for (let i = 0; i < 23; i += 1) await runner.runOnce()
  assert.equal(tables.cleanup_reports.size, 20)
  const times = [...tables.cleanup_reports.entries()].map(([, report]) => report.at)
  assert.equal(Math.min(...times), 4_000, '最早的三条被裁掉')
})

test('restore：把隔离的附件 rename 回对象库并删记录', async () => {
  const id = hex('7')
  const trashPath = norm(nodePath.join(trashDir(DSH_HOME), id))
  const fs = createFakeFs({ [trashPath]: { bytes: 5, mtimeMs: 0 } })
  const tables = { quarantine: createTable({ [id]: { attachmentId: id, kind: 'image', bytes: 5, quarantinedAt: 1 } }) }
  const runner = createCleanupRunner(runnerOptions(fs, tables))
  assert.deepEqual(await runner.restore(id), { ok: true })
  assert.ok(fs.files.has(objPath('image', id)))
  assert.equal(tables.quarantine.size, 0)
  assert.deepEqual(await runner.restore(id), { ok: false, code: 'not-found', message: '隔离区里没有这个附件' })
  assert.equal((await runner.restore('not-hex')).code, 'invalid-id')
})

test('restore 失败：记录保留，返回 restore-failed', async () => {
  const id = hex('8')
  const tables = { quarantine: createTable({ [id]: { attachmentId: id, kind: 'file', bytes: 5, quarantinedAt: 1 } }) }
  const fs = createFakeFs({}, { failRenameFor: [id] })
  const runner = createCleanupRunner(runnerOptions(fs, tables))
  const result = await runner.restore(id)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'restore-failed')
  assert.equal(tables.quarantine.size, 1)
})

test('normalizeAttachmentId 与 objectRelPath 配合：桶目录两位、文件名全 64 位', () => {
  const id = hex('ab')
  assert.equal(normalizeAttachmentId(`sha256:${id}`), id)
  assert.equal(norm(objectRelPath('image', `sha256:${id}`)), `objects/ab/${id}`)
  assert.equal(norm(objectRelPath('file', id)), `file-objects/ab/${id}`)
})
