import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(ROOT, 'lib', 'client.js')

const BEGIN = '// <clock:begin>'
const END = '// <clock:end>'

function readClient() {
  return readFileSync(clientPath, 'utf8')
}

/** 取出 lib/client.js 内联时钟区间，返回可 eval 的函数实现。 */
function loadInlineClock() {
  const src = readClient()
  const b = src.indexOf(BEGIN)
  const e = src.indexOf(END)
  assert.ok(b >= 0, 'lib/client.js 缺少 clock:begin 标记')
  assert.ok(e > b, 'lib/client.js 缺少 clock:end 标记')
  const lineEnd = src.indexOf('\n', b)
  assert.ok(lineEnd > 0, 'clock:begin 标记行异常')
  const body = src.slice(lineEnd + 1, e)
  // 内联块是纯函数声明（const/function），用 Function 求值后导出所需符号。
  const factory = new Function(body + '\nreturn { phaseAt, sendAt, normalizeCfg, fmtRemaining, nextOffpeakStart, nextPeakStart, HOLIDAYS_2026, DEFAULT_BUFFER_MS }')
  return factory()
}

const clock = await import(pathToFileURL(join(ROOT, 'lib', 'core', 'clock.js')).href)

test('client 内联时钟与 lib/core/clock.js 行为一致（相位/发送时刻/格式化）', () => {
  const inline = loadInlineClock()
  const cfg = clock.normalizeCfg({})
  const inlineCfg = inline.normalizeCfg({})

  // 采样一段覆盖高峰、午休、夜间、周末、节假日边界的时间
  const base = Date.UTC(2026, 9, 5, 0, 0, 0) // 2026-10-05 08:00 北京（国庆假期）
  const step = 7 * 60 * 1000
  for (let i = 0; i < 1200; i++) {
    const t = base + i * step
    assert.equal(inline.phaseAt(t, inlineCfg), clock.phaseAt(t, cfg), 'phaseAt 不一致 @ ' + new Date(t).toISOString())
    const a = clock.sendAt(t, cfg)
    const b = inline.sendAt(t, inlineCfg)
    assert.deepEqual(b, a, 'sendAt 不一致 @ ' + new Date(t).toISOString())
    assert.equal(inline.fmtRemaining(a.waitMs), clock.fmtRemaining(a.waitMs))
  }
})

test('client 内联时钟覆盖 9 条目边界点（不依赖采样）', () => {
  const inline = loadInlineClock()
  const cfg = clock.normalizeCfg({})
  const inlineCfg = inline.normalizeCfg({})
  const probes = [
    Date.UTC(2026, 9, 12, 0, 59, 59),  // 周一 08:59:59
    Date.UTC(2026, 9, 12, 1, 0, 0),    // 09:00
    Date.UTC(2026, 9, 12, 3, 59, 59),  // 11:59:59
    Date.UTC(2026, 9, 12, 4, 0, 0),    // 12:00
    Date.UTC(2026, 9, 12, 5, 59, 59),  // 13:59:59
    Date.UTC(2026, 9, 12, 6, 0, 0),    // 14:00
    Date.UTC(2026, 9, 12, 9, 59, 59),  // 17:59:59
    Date.UTC(2026, 9, 12, 10, 0, 0),   // 18:00
    Date.UTC(2026, 9, 16, 12, 0, 0),   // 周五 20:00
  ]
  for (const t of probes) {
    assert.equal(inline.phaseAt(t, inlineCfg), clock.phaseAt(t, cfg))
    assert.deepEqual(inline.sendAt(t, inlineCfg), clock.sendAt(t, cfg))
  }
})

test('内联块不包含 import/export（避免浏览器端语法错误）', () => {
  const src = readClient()
  const b = src.indexOf(BEGIN)
  const body = src.slice(src.indexOf('\n', b) + 1, src.indexOf(END))
  assert.ok(!/^\s*(import|export)\b/m.test(body), '内联块里出现了 import/export')
  assert.ok(body.trim().length > 500, '内联块疑似为空（先跑 npm run inline）')
})
