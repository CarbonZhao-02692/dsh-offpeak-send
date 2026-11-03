# 谷时发送（dsh-offpeak-send）

DeepSeek 计价分高峰与谷时（谷时半价）。这个插件在输入框权限选择模块的右侧加一个开关：开启后，按发送时如果正处高峰，消息不立即发出，而是排队到下一个谷时开始后 3 秒自动投递；处于谷时则照常立即发送。

当前状态：已在 DSH Web 0.2.1-rc.5 上真机验收通过——入口位置、排队、倒计时、立即发送、修改、取消、关闭开关三按钮弹窗、到点自动投递、设置面板、附件落盘、自动清理全部实测。

```
npm i @carbonzhao/dsh-offpeak-send
```

安装后重启 `dsh web`，输入框权限选择模块右侧会出现「谷时」开关。

English: adds an "off-peak" toggle to the DSH composer. When enabled, pressing send during DeepSeek's peak billing hours (Mon–Fri 09:00–12:00 / 14:00–18:00 Beijing time) queues the message and delivers it 3 s after the next off-peak window starts (off-peak costs 50% of peak). A dock above the composer shows the pending items, countdown, and per-item send-now / edit / cancel; the queue survives closing the browser or restarting DSH, attachments included.

## 计价时间模型

| 项目 | 规则 |
| --- | --- |
| 高峰（全价） | 北京时间周一至周五 09:00–12:00、14:00–18:00，法定节假日除外 |
| 谷时（半价） | 其余全部时间，含 12:00–14:00、18:00–次日 09:00、周末、法定节假日 |
| 时区 | 固定 UTC+8，只用 UTC getter + 固定偏移换算，不读浏览器本地小时 |
| 延迟点 | 谷时起点 + buffer（默认 3 秒，可配 1–10 秒） |
| 最长等待 | 约 4 小时（14:00 按下，18:00:03 投递） |
| 节假日表 | `lib/core/holidays.js`，2026 年 33 天放假（国办发明电〔2025〕7 号）；未列年份按普通工作日处理 |

2026 年节日按官方通知只登记放假日；调休上班的周六按谷时处理（只会多等、不会多付）。

## 前端行为

开关挂在 `conversation.input.left`（rc.5 起位于权限选择块紧右侧、与权限 chip 间距 8px），dock 条挂在 `conversation.input.dock`（输入框上方）。

> 槽位选择原因：rc.5 把权限块移到左侧 tools 组、把模型选择器推到右侧 trailing 组，`conversation.input.right` 会被排到输入框最右边（离权限块 255px）。DSH 0.2.1-rc.5 的 `dsh-client-ui-conversation/lib/client.js:19270` 在权限槽之后渲染 `conversation.input.left`，因此改挂该槽以保持「权限选择模块右侧」的原意。

| 状态 | chip 文案 | 圆点 | 行为 |
| --- | --- | --- | --- |
| 开关关闭 | 「谷时」 | 灰 | 全部直通，不拦任何发送 |
| 开 + 谷时 | 「谷时」 | 绿 | 立即发送 |
| 开 + 高峰 | 「谷时 HH:MM 后发」 | 橙 | 拦截、落盘附件、入队，dock 显示倒计时 |
| 排队中 | 同上，尾部带条数徽标 | — | dock 显示条目数、目标时刻、剩余时间 |

chip 的 `data-offpeak-chip` 为 `on`/`off`，`aria-pressed` 同步；title 里写明当前相位、下次切换点、排队条数，以及「仅对普通发送生效；追问/插话（steer）不排队」。

- 右键 chip 或长按 600 ms 打开设置面板：buffer 滑块（1–10 秒）、当前相位与下次谷时/高峰、节假日表（只读）、隔离区占用、最近清理记录与恢复入口、宿主时间与时钟偏移、发送拦截状态。
- 关闭开关时若当前会话还有排队：弹「关闭谷时发送？」对话框，三个按钮——全部清除（清队并入 orphan，随后自动清理）、全部发送（立即全部投递）、取消（保持开关开启）。dock 单条的「取消」只删该条，不改开关。
- dock 每条：[立即发送] [修改] [取消]。修改 = 取消该条并把正文放回输入框（有附件时二段确认）。
- steer（追问/插话）不排队，直通。

## 宿主行为

发送被拦截时：草稿里的附件经 `POST /stage` 落盘成宿主工件引用（`attachments/v1/objects/<sha256>`），再由 `POST /enqueue` 写进 outbox 持久化记录。因此关掉浏览器、重启 DSH 都不会丢排队消息。

- 存储：storageDomain `dsh_offpeak_send` v1，表 outbox / delivered（留 50 条）/ orphans / quarantine / cleanup_reports（留 20 条）。
- 调度：单 timer（`.unref()`，单次最大 2147483647 ms），到期按会话 FIFO 串行投递；同会话一条 sending 阻塞后一条，跨会话互不阻塞。
- 投递：`resolveAgent` → 拼 `[text, image?, file?]` → `createUserMessage({ content, source: { kind: 'user' } })` → `agent.followup` → `ctx.sessions.flush`。消息来源标记为真实用户，与手打无差别。
- 失败重试：最多 3 次，退避 5s / 15s / 60s；终态记 `failed`/`abandoned`。
- 重启恢复：sending 状态按投递记录核对（有记录即视为已投递；无记录退回 waiting）；已过期但仍处高峰的项改期到下一谷时起点 + buffer，并在 `rescheduledFrom` 记下原时刻。
- 到点投递时不再复检相位（`sendAt` 已保证落点在谷时），只有重启时的改期逻辑会重新决策。
- 模型不支持图像时：按模型名启发式判断（`/image|vision|vl|omni/i`），不支持就丢掉 image 块、保留文本与文件、在正文尾部追加「（含 N 张图片，当前模型不支持，已省略）」，静默投递，图片当孤儿登记待清理。

## 附件与孤儿清理

DSH 宿主没有附件删除 API，对象"unreachable until a future retention policy collects them"。所以清理走两段式：

1. 引用核对：引用集 = 会话日志（`sessions/**/session.v4.jsonl.zstd` 逐帧解压，按 mtime + size 缓存）∪ outbox ∪ delivered；候选 = 未被引用 且 有 orphan 登记 且 对象 mtime ≥ orphan.addedAt。
2. 先 rename 进 `<DSH_HOME>/attachments/v1/.offpeak-trash/<sha256>`（原子、可恢复），7 天后才真正 fs.rm。

- 触发：宿主启动 +10 分钟、每天 03:00、孤儿登记后去抖 15 分钟；后台异步，单轮限时 120 秒可续跑。
- 安全阀：单轮最多 200 个 / 500 MB；隔离区总量上限 2 GB（超出删最旧）；rename 失败立即停本轮；引用扫描不完整则本轮一个都不动。
- 恢复：设置面板「恢复被清理的附件」→ rename 回原位（引用是内容寻址固定路径，回位即可读）。允许隔离区里的对象被自动清除，所以"恢复"只在 7 天窗口内有效。
- 每轮写 CleanupReport（at / scannedFiles / candidates / quarantined / purged / keptReferenced / keptSharedByMtime / bytesFreed / errors）。

## 路由

前缀 `/dsh-offpeak-send`，全部 `kind: 'exact'`。插件路由不需要 GUI token。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /stage | 原始字节 + 头 `x-offpeak-kind: image\|file`、`x-offpeak-name`（URL 编码）、`x-offpeak-media-type` → `{ ok, ref }`；413 超 32 MB，415 图像准入失败 |
| POST | /enqueue | `{ clientTag, sessionId, text, attachments[], submittedModel? }`；谷时 `{ ok, delivered: true }`，高峰 `{ ok, item }`；同 clientTag 幂等 |
| GET | /pending?sessionId= | `{ ok, serverNow, items[], others }` |
| POST | /action | `{ id, action: send-now\|cancel\|retry }`；sending 中 409 |
| POST | /clear | `{ sessionId }` → 清空该会话排队，附件入 orphans（origin=clear） |
| POST | /flush | `{ sessionId }` → 立即投递该会话全部排队 |
| GET | /cleanup | `{ reports[≤20], quarantine[], quarantineBytes }` |
| POST | /cleanup/restore | `{ attachmentId }` → 从隔离区回位 |
| GET/POST | /config | 读写配置；POST 支持 bufferMs / holidays / autoCleanup / peak / forceWorkday |

配置持久化在 `<DSH_HOME>/offpeak-send/config.json`。

## 从源码构建与注入（开发用）

依赖 DSH 安装目录里的宿主包（`@deepseek-ai/cordis`、`schemastery`、`dsh-llm`、`dsh-storage-domain`、`zod`），`scripts/link-deps.mjs` 用 junction 把它们链进本项目 `node_modules`：

```bash
cd D:/dshSessions/offpeak-send/dsh-offpeak-send
npm run build        # link-deps + inline-clock
dev_inject_plugin { "dir": "D:/dshSessions/offpeak-send/dsh-offpeak-send" }
```

`build` 的第二半是 `scripts/inline-clock.mjs`：把 `lib/core/holidays.js` + `clock.js` 内联进 `lib/client.js` 的标记区间（客户端 bundle 不是模块系统，不能 import 宿主模块）。改完时间逻辑必须重跑，否则前端判定与服务端不一致。

改完 host/client 代码后的生效方式分两种：

- **host**（`lib/index.js`、`outbox.js`、`deliver.js`、`gc.js`）：重启 DSH，或 `dev_reload_package("dsh-offpeak-send")`（清缓存、重建 fiber）。
- **client**（`lib/client.js`）：刷新浏览器页面。注意浏览器会按 URL 缓存 `/plugins/??…` 合并 bundle，直接刷新可能仍跑旧代码（本次实测踩过：页面显示高峰、发送却直通不排队）。排查/验证时用带时间戳的地址重开，例如在页面里 `location.href = 'http://127.0.0.1:3080/?cb=' + Date.now()`，再确认行为变化。

**注入器坑**：注入器的 slot 白名单（`D:/dsh-plugins/injector-dist/lib/index.js` 的 `clientSkeletonProblems`，`:8502-8517`）记忆的是启动时的值；改文件后 `dev_reload_package("dsh-super-injector")` 不会让它重新读取，必须重启 DSH。现已在 `:8511-8513` 补入 `conversation.input.right/left/permission`（重启后生效）。client bundle 里仍保留一个合法 slot 的单行锚点（`ctx.slots.register({ name: 'shell.overlay', id: 'offpeak-anchor', order: 900 }, () => null)`，返回 null 不渲染）作为兜底；确认白名单已生效后可删。

## 测试

```bash
npm test    # 49 例全绿
```

- `test/clock.test.mjs`（9）：相位边界 8:59:59 / 9:00 / 11:59:59 / 12:00 / 13:59:59 / 14:00 / 17:59:59 / 18:00、周末与节假日、调休周六、跨日与跨周末的 nextOffpeakStart/nextPeakStart、sendAt 落点不变（7 天每 7 分钟采样 + 边界 ±1 ms：落点必为谷时、等待 ≤ 4h + buffer）、buffer 钳制、时区固定。
- `test/outbox.test.mjs`（19）：FIFO、状态机、clientTag 幂等、退避、崩溃恢复、容量上限。
- `test/gc-refs.test.mjs`（18）：引用核对（zstd 帧扫描、缓存失效）、候选筛选、rename/恢复/过期删除、安全阀与失败即停。
- `test/client-inline.test.mjs`（3）：内联块存在且与源文件一致（重跑幂等）、client bundle 可解析。

## 端到端自测（造高峰）

周末/夜间全时段是谷时，没法自然制造排队。`POST /config` 接受两个调试字段（缺省关闭，不写配置文件时就是生产语义）：

```bash
# 把当前时刻当工作日、把 00:00–01:10 当高峰（分钟数区间，左闭右开）
curl -X POST -H 'content-type: application/json' \
  --data '{"forceWorkday":true,"peak":[[0,70]]}' \
  http://127.0.0.1:3080/dsh-offpeak-send/config

# 自测完还原
curl -X POST -H 'content-type: application/json' \
  --data '{"forceWorkday":false,"peak":null}' \
  http://127.0.0.1:3080/dsh-offpeak-send/config
```

`GET /config` 返回的 `phase` 应与页面 chip 的判定一致；不一致说明前端 bundle 是旧的（见上一节）。

## 已知限制

- 判断发生在按发送的那一刻：入队后相位再变化不会重新评估（到点即投递）；只有宿主重启时的改期逻辑会重新决策。
- 单附件 32 MB、单条 20 个附件、全局队列 100 条 / 单会话 20 条（超限返回 429 queue-full）。
- 模型是否支持图像靠模型名启发式匹配，可能误判。
- 取消/清除/丢图产生的附件孤儿最长要 7 天才会真正释放磁盘（隔离区窗口），期间可以在设置面板里恢复。
- 节假日表只覆盖 2026；后续年份需按官方通知补 `lib/core/holidays.js`（缺省按工作日，只会多等不多付）。
- 浏览器刷新后 dock 依赖 3 秒轮询恢复（页面隐藏时降为 10 秒），不是实时推送。
- 计价规则按 2026 年 8 月公布的口径（高峰 = 工作日 09:00–12:00 / 14:00–18:00，其余半价）；口径若再变，需同步 `lib/core/clock.js` 的 `DEFAULT_PEAK_RANGES`。

## License

MIT
