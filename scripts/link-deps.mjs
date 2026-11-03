// 建立宿主依赖的 node_modules 链接（DSH 安装目录内的同版本包），以便 lib/index.js 能 import 宿主包。
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CANDIDATES = [
  process.env.DSH_PKG_ROOT,
  'D:/npm/node_modules/@deepseek-ai/dsh/node_modules',
  'C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules',
].filter(Boolean)

const BASE = CANDIDATES.find((p) => existsSync(join(p, '@deepseek-ai')))
if (!BASE) {
  console.error('link-deps: 找不到 DSH 安装目录的 node_modules（可设 DSH_PKG_ROOT）')
  process.exit(1)
}

const DEPS = {
  '@deepseek-ai/cordis': join(BASE, '@deepseek-ai/cordis'),
  '@deepseek-ai/schemastery': join(BASE, '@deepseek-ai/schemastery'),
  '@deepseek-ai/dsh-llm': join(BASE, '@deepseek-ai/dsh-llm'),
  '@deepseek-ai/dsh-storage-domain': join(BASE, '@deepseek-ai/dsh-storage-domain'),
  zod: join(BASE, 'zod'),
}

for (const [name, target] of Object.entries(DEPS)) {
  if (!existsSync(target)) { console.error('link-deps: 缺少目标', name, target); process.exit(1) }
  const at = join(ROOT, 'node_modules', name)
  rmSync(at, { recursive: true, force: true })
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
}
console.log('link-deps: ok ->', BASE)