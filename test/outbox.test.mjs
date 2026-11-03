import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KEEP_DELIVERED,
  MAX_ATTEMPTS,
  OutboxStore,
  RETRY_DELAYS_MS,
  canAttempt,
  compareFifo,
  countPending,
  nextDueTime,
  normalizeAttachmentId,
  planDeliveries,
  retryDelayMs,
  selectStale,
} from '../lib/outbox.js'
import { buildContent, deliverItem, pruneDelivered, registerOrphans } from '../lib/deliver.js'

/** 内存 fake domain 表：形状与 KvTable 一致（get/entries/keys/size/put/delete/update）。 */
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

let seq = 0
function item(patch = {}) {
  seq += 1
  return {
    id: patch.id ?? `item-${String(seq).padStart(3, '0')}`,
    clientTag: patch.clientTag ?? `tag-${seq}`,
    sessionId: 's1',
    text: '',
    attachments: [],
    createdAt: patch.createdAt ?? seq,
    sendAt: patch.sendAt ?? 0,
    reason: 'peak',
    status: 'waiting',
    attempts: 0,
    ...patch,
  }
}

test('归一化附件 id：去掉 sha256: 前缀', () => {
  const hex = 'a'.repeat(64)
  assert.equal(normalizeAttachmentId(`sha256:${hex}`), hex)
  assert.equal(normalizeAttachmentId(hex), hex)
  assert.equal(normalizeAttachmentId(undefined), '')
})

test('FIFO：同会话按 createdAt 排序，跨会话按各自最早一条排序', () => {
  const items = [
    item({ sessionId: 's2', createdAt: 30 }),
    item({ sessionId: 's1', createdAt: 10 }),
    item({ sessionId: 's2', createdAt: 20 }),
    item({ sessionId: 's1', createdAt: 15 }),
  ]
  const groups = planDeliveries(items, { now: 100 })
  assert.deepEqual(
    groups.map((group) => group.sessionId),
    ['s1', 's2'],
  )
  assert.deepEqual(
    groups[0].items.map((entry) => entry.createdAt),
    [10, 15],
  )
  assert.deepEqual(
    groups[1].items.map((entry) => entry.createdAt),
    [20, 30],
  )
  assert.ok(compareFifo({ createdAt: 1, id: 'b' }, { createdAt: 1, id: 'a' }) > 0)
})

test('same-ms 也不抖：相同 createdAt 时按 id 稳定排序', () => {
  const a = item({ id: 'zzz', createdAt: 5 })
  const b = item({ id: 'aaa', createdAt: 5 })
  const sorted = [a, b].sort(compareFifo)
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ['aaa', 'zzz'],
  )
})

test('同会话前一项 sending 阻塞后续，跨会话不阻塞', () => {
  const first = item({ sessionId: 's1', createdAt: 1, status: 'sending' })
  const second = item({ sessionId: 's1', createdAt: 2 })
  const other = item({ sessionId: 's2', createdAt: 3 })
  const groups = planDeliveries([first, second, other], { now: 100 })
  assert.deepEqual(
    groups.map((group) => group.sessionId),
    ['s2'],
  )
  const unblocked = planDeliveries([first, second, other], { now: 100, includeFuture: true })
  const s1 = unblocked.find((group) => group.sessionId === 's1')
  assert.equal(s1, undefined, 'sending 之后同会话全部等待')
})

test('未到 sendAt 不投递；includeFuture 时强制取全部', () => {
  const later = item({ sendAt: 1_000, createdAt: 1 })
  assert.equal(planDeliveries([later], { now: 999 }).length, 0)
  assert.equal(planDeliveries([later], { now: 999, includeFuture: true }).length, 1)
  assert.equal(nextDueTime([later]), 1_000)
})

test('崩溃恢复：sending 有投递记录 → 删除；没有记录 → 退回 waiting', () => {
  const done = item({ status: 'sending', attempts: 1 })
  const unknown = item({ status: 'sending', attempts: 1 })
  const table = createTable({ [done.id]: done, [unknown.id]: unknown })
  const delivered = createTable({ [done.id]: { id: done.id, deliveredAt: 1 } })
  const store = new OutboxStore(table)
  return store.recover({ delivered }).then((result) => {
    assert.deepEqual(result, { requeued: 1, completed: 1 })
    assert.equal(table.get(done.id), undefined)
    assert.equal(table.get(unknown.id).status, 'waiting')
    assert.equal(table.get(unknown.id).attempts, 1, '重投保留已失败的次数')
  })
})

test('失败重试封顶：attempts 达上限后 canAttempt / planDeliveries / nextDueTime 全部跳过', () => {
  const capped = item({ status: 'failed', attempts: MAX_ATTEMPTS, sendAt: 10 })
  assert.equal(canAttempt(capped, { now: 1e9 }), false)
  assert.equal(planDeliveries([capped], { now: 1e9, includeFuture: true }).length, 0)
  assert.equal(nextDueTime([capped]), undefined)

  const belowCap = item({ status: 'failed', attempts: MAX_ATTEMPTS - 1, sendAt: 10 })
  assert.equal(canAttempt(belowCap, { now: 1e9 }), true)
  assert.equal(nextDueTime([belowCap]), 10)

  const cooled = item({ status: 'failed', attempts: 1, sendAt: 0 })
  assert.equal(canAttempt(cooled, { now: 1_000, retryAt: { [cooled.id]: 5_000 } }), false, '退避未到')
  assert.equal(canAttempt(cooled, { now: 5_000, retryAt: { [cooled.id]: 5_000 } }), true)
  assert.equal(nextDueTime([cooled], { retryAt: { [cooled.id]: 5_000 } }), 5_000)
})

test('退避序列 5s / 15s / 60s 封顶', () => {
  assert.deepEqual([...RETRY_DELAYS_MS], [5_000, 15_000, 60_000])
  assert.equal(retryDelayMs(1), 5_000)
  assert.equal(retryDelayMs(2), 15_000)
  assert.equal(retryDelayMs(3), 60_000)
  assert.equal(retryDelayMs(9), 60_000)
  assert.equal(retryDelayMs(0), 5_000)
})

test('失败封顶的项不阻塞同会话后面的项', () => {
  const capped = item({ status: 'failed', attempts: MAX_ATTEMPTS, createdAt: 1 })
  const next = item({ createdAt: 2 })
  const groups = planDeliveries([capped, next], { now: 1e9, includeFuture: true })
  assert.equal(groups.length, 1)
  assert.deepEqual(
    groups[0].items.map((entry) => entry.id),
    [next.id],
  )
})

test('幂等 clientTag：重复入队命中同一项，不新增', async () => {
  const table = createTable()
  const store = new OutboxStore(table)
  const first = await store.add({ clientTag: 'abc', sessionId: 's1', text: 'hi', sendAt: 5 })
  const found = store.findByClientTag('abc')
  assert.equal(found.id, first.id)
  // 入队处理器的语义：命中即返回已有项，不再 add
  const again = store.findByClientTag('abc') ?? (await store.add({ clientTag: 'abc', sessionId: 's1' }))
  assert.equal(again.id, first.id)
  assert.equal(store.all().length, 1)
  assert.equal(store.findByClientTag(''), undefined)
})

test('update 传 undefined 是删字段（retry 清 lastError/rescheduledFrom）', async () => {
  const table = createTable()
  const store = new OutboxStore(table)
  const added = await store.add({ clientTag: 'x', sessionId: 's1', lastError: 'boom', rescheduledFrom: 7 })
  const next = await store.update(added.id, { status: 'waiting', attempts: 0, lastError: undefined, rescheduledFrom: undefined })
  assert.equal(next.status, 'waiting')
  assert.equal('lastError' in next, false)
  assert.equal('rescheduledFrom' in next, false)
  assert.equal(await store.update('missing', { status: 'waiting' }), undefined)
})

test('统计与待办计数忽略 abandoned', () => {
  const items = [
    item({ status: 'waiting' }),
    item({ status: 'sending' }),
    item({ status: 'failed', attempts: 1 }),
    item({ status: 'abandoned' }),
  ]
  assert.equal(countPending(items), 3)
  const table = createTable(Object.fromEntries(items.map((entry) => [entry.id, entry])))
  const stats = new OutboxStore(table).stats()
  assert.deepEqual(stats, { total: 4, waiting: 1, sending: 1, failed: 1, abandoned: 1, sessions: 1 })
})

test('投递记录只留最近 50 条', async () => {
  assert.equal(KEEP_DELIVERED, 50)
  const table = createTable()
  for (let i = 0; i < 55; i += 1) {
    await table.put(`d${i}`, { id: `d${i}`, deliveredAt: i })
  }
  const removed = await pruneDelivered(table)
  assert.equal(removed, 5)
  assert.equal(table.size, 50)
  assert.equal(table.get('d4'), undefined)
  assert.ok(table.get('d5'))
  assert.deepEqual(selectStale([{ id: 'a', deliveredAt: 1 }, { id: 'b', deliveredAt: 2 }], { keep: 1 }), ['a'])
})

/** 假宿主 ctx：resolveAgent / sessions.flush 由用例注入。 */
function createCtx({ resolve, flush = true }) {
  const sent = []
  return {
    sent,
    sessionController: { resolveAgent: async (sessionId) => resolve(sessionId) },
    sessions: { flush: async () => flush },
    agent: { session: {}, followup: (message) => sent.push(message) },
  }
}

function deliveryDeps(overrides = {}) {
  const outboxTable = createTable()
  const deliveredTable = createTable()
  const orphansTable = createTable()
  return {
    outboxTable,
    deliveredTable,
    orphansTable,
    deps: {
      outbox: new OutboxStore(outboxTable),
      delivered: deliveredTable,
      orphans: orphansTable,
      logger: { info() {}, warn() {} },
      keepDelivered: KEEP_DELIVERED,
      ...overrides,
    },
  }
}

test('deliverItem 成功：写投递记录、删 outbox 项、followup 一次', async () => {
  const { deps, outboxTable, deliveredTable } = deliveryDeps()
  const target = item({ text: '谷时送达' })
  await deps.outbox.add(target)
  const agent = { session: {}, followup(m) { this.message = m } }
  const ctx = createCtx({ resolve: () => ({ agent }) })
  const result = await deliverItem(ctx, deps, deps.outbox.get(target.id))
  assert.equal(result.ok, true)
  assert.equal(agent.message.source.kind, 'user')
  assert.equal(agent.message.content[0].text, '谷时送达')
  assert.equal(outboxTable.get(target.id), undefined)
  const record = deliveredTable.get(target.id)
  assert.equal(record.status, 'delivered')
  assert.equal(record.clientTag, target.clientTag)
})

test('deliverItem flush 未确认 → failed，attempts+1，lastError 落盘', async () => {
  const { deps, outboxTable } = deliveryDeps()
  const target = item({ text: 'x' })
  await deps.outbox.add(target)
  const ctx = createCtx({ resolve: () => ({ agent: { session: {}, followup() {} } }), flush: false })
  const result = await deliverItem(ctx, deps, deps.outbox.get(target.id))
  assert.equal(result.ok, false)
  assert.equal(result.abandoned, false)
  assert.equal(result.attempts, 1)
  const stored = outboxTable.get(target.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.attempts, 1)
  assert.match(stored.lastError, /flush not acknowledged/)
})

test('deliverItem 会话不存在 → abandoned，附件登记 orphan、outbox 清除', async () => {
  const { deps, outboxTable, orphansTable } = deliveryDeps()
  const target = item({ attachments: [{ kind: 'file', attachmentId: 'sha256:' + 'b'.repeat(64), name: 'a.txt' }] })
  await deps.outbox.add(target)
  const ctx = createCtx({
    resolve: () => ({ error: Object.assign(new Error('session not found'), { code: 'session/not-found' }) }),
  })
  const result = await deliverItem(ctx, deps, deps.outbox.get(target.id))
  assert.equal(result.ok, false)
  assert.equal(result.abandoned, true)
  assert.equal(outboxTable.get(target.id), undefined)
  const orphan = orphansTable.get('sha256:' + 'b'.repeat(64))
  assert.equal(orphan.origin, 'abandoned')
})

test('图像能力：模型名不支持图像时丢图 + 文本备注，文件块保留', () => {
  const image = { kind: 'image', attachmentId: 'sha256:' + 'c'.repeat(64), mediaType: 'image/png', bytes: 9 }
  const file = { kind: 'file', attachmentId: 'sha256:' + 'd'.repeat(64), name: 'n.txt' }
  const plain = buildContent({ text: '看这个', attachments: [image, file], submittedModel: 'deepseek-chat' })
  assert.equal(plain.droppedImages.length, 1)
  assert.equal(plain.content.length, 2, '文本块 + 文件块')
  assert.match(plain.content[0].text, /看这个/)
  assert.match(plain.content[0].text, /（含 1 张图片，当前模型不支持，已省略）/)
  assert.equal(plain.content[1].type, 'file')

  const vision = buildContent({ text: '', attachments: [image], submittedModel: 'gpt-4o-vision' })
  assert.equal(vision.droppedImages.length, 0)
  assert.equal(vision.content[1].type, 'image')
  assert.equal(vision.content[1].attachment.mediaType, 'image/png')
})

test('纯图片消息在不支持图像的模型下只剩备注文本', () => {
  const image = { kind: 'image', attachmentId: 'sha256:' + 'e'.repeat(64), mediaType: 'image/jpeg', bytes: 1 }
  const built = buildContent({ text: '', attachments: [image] })
  assert.equal(built.content.length, 1)
  assert.match(built.content[0].text, /已省略/)
})

test('registerOrphans 原样保留 attachmentId（含前缀），origin 按调用方给', async () => {
  const table = createTable()
  const count = await registerOrphans(table, [{ kind: 'image', attachmentId: 'sha256:' + 'f'.repeat(64), bytes: 3 }], {
    origin: 'cancel',
    now: 1234,
  })
  assert.equal(count, 1)
  assert.deepEqual(table.get('sha256:' + 'f'.repeat(64)), {
    attachmentId: 'sha256:' + 'f'.repeat(64),
    kind: 'image',
    bytes: 3,
    addedAt: 1234,
    origin: 'cancel',
  })
})
