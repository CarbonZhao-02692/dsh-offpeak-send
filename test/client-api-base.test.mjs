import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BEGIN = '// <api-base:begin>'
const END = '// <api-base:end>'

/** 取出 lib/client.js 的 api-base 区间，返回可调用的 resolveApiBase。 */
function loadResolveApiBase() {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const b = src.indexOf(BEGIN)
  const e = src.indexOf(END)
  assert.ok(b >= 0, 'lib/client.js 缺少 api-base:begin 标记')
  assert.ok(e > b, 'lib/client.js 缺少 api-base:end 标记')
  const body = src.slice(src.indexOf('\n', b) + 1, e)
  // 区间内是纯函数声明（const/function），用 Function 求值后取出符号；document/location 由用例注入。
  const factory = new Function(body + '\nreturn resolveApiBase')
  return factory()
}

/** 临时注入/抹掉 document、location 这类浏览器全局。 */
function withGlobals(values, run) {
  const saved = new Map()
  for (const key of Object.keys(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value: values[key], configurable: true, writable: true })
  }
  try {
    return run()
  } finally {
    for (const [key, desc] of saved) {
      if (desc === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, desc)
    }
  }
}

test('根路径部署：前缀保持 /dsh-offpeak-send', () => {
  const resolveApiBase = loadResolveApiBase()
  const cases = [
    'http://127.0.0.1:3080/',
    'http://127.0.0.1:3080/?token=abc', // dsh web 打印的带 token 启动地址
    'https://nas.local:2299/',
  ]
  for (const baseURI of cases) {
    assert.equal(withGlobals({ document: { baseURI } }, resolveApiBase), '/dsh-offpeak-send', baseURI)
  }
})

test('反代子路径部署：前缀带上页面所在目录', () => {
  const resolveApiBase = loadResolveApiBase()
  const cases = [
    // 飞牛 FnConnect 网关：WebUI 挂在 /app/deepseek-harness/fngateway/
    ['https://saaak001.fnos.net/app/deepseek-harness/fngateway/', '/app/deepseek-harness/fngateway/dsh-offpeak-send'],
    // 没有结尾斜杠时按目录处理，不能退到上一级目录
    ['https://saaak001.fnos.net/app/deepseek-harness/fngateway', '/app/deepseek-harness/fngateway/dsh-offpeak-send'],
    ['https://example.com/dsh/sub/', '/dsh/sub/dsh-offpeak-send'],
    ['https://example.com/dsh/sub', '/dsh/sub/dsh-offpeak-send'],
  ]
  for (const [baseURI, expected] of cases) {
    assert.equal(withGlobals({ document: { baseURI } }, resolveApiBase), expected, baseURI)
  }
})

test('没有 document 时退回 location.href 兜底', () => {
  const resolveApiBase = loadResolveApiBase()
  const got = withGlobals(
    { document: undefined, location: { href: 'https://example.com/app/x/' } },
    resolveApiBase,
  )
  assert.equal(got, '/app/x/dsh-offpeak-send')
})

test('无基准或非法基准时退回绝对前缀（保持旧行为，不抛异常）', () => {
  const resolveApiBase = loadResolveApiBase()
  assert.equal(withGlobals({ document: undefined, location: undefined }, resolveApiBase), '/dsh-offpeak-send')
  assert.equal(withGlobals({ document: { baseURI: 'not a url' }, location: undefined }, resolveApiBase), '/dsh-offpeak-send')
})
