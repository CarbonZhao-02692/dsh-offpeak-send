/**
 * 投递：把 outbox 里的一项真正送进目标会话（resolveAgent → followup → flush）。
 *
 * 这里的投递绕过了官方消息准入（那是 turn 内的路径），所以图像能力要自己判：
 * 提交时用的模型不支持图像，就丢掉全部 image 块、保留文本与文件、静默投递，
 * 并在文本末尾注明丢了几张（PLAN §6.5）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KEEP_DELIVERED, selectStale } from './outbox.js'

/** 判定「模型能吃图」的模型名特征（PLAN §6.5 约定）。 */
const IMAGE_CAPABLE_MODEL = /image|vision|vl|omni/i

const MAX_ERROR_TEXT = 500

/**
 * @param {unknown} model
 * @returns {boolean}
 */
export function modelSupportsImages(model) {
  return typeof model === 'string' && IMAGE_CAPABLE_MODEL.test(model)
}

/**
 * @param {number} count
 * @returns {string}
 */
export function droppedImagesNote(count) {
  return `（含 ${count} 张图片，当前模型不支持，已省略）`
}

/**
 * 扁平 ref → 宿主消息块需要的附件对象（contract §3）。
 *
 * @param {object} ref
 * @returns {object}
 */
function imageAttachmentRef(ref) {
  const attachment = { attachmentId: ref.attachmentId, mediaType: ref.mediaType }
  if (typeof ref.bytes === 'number') attachment.bytes = ref.bytes
  if (typeof ref.width === 'number') attachment.width = ref.width
  if (typeof ref.height === 'number') attachment.height = ref.height
  if (typeof ref.name === 'string' && ref.name !== '') attachment.name = ref.name
  return attachment
}

/**
 * @param {object} ref
 * @returns {object}
 */
function fileAttachmentRef(ref) {
  const attachment = { attachmentId: ref.attachmentId, name: typeof ref.name === 'string' ? ref.name : 'file' }
  if (typeof ref.bytes === 'number') attachment.bytes = ref.bytes
  return attachment
}

/**
 * 组投递内容：文本块在前，附件块在后。
 *
 * @param {object} item
 * @returns {{ content: object[], droppedImages: object[] }}
 */
export function buildContent(item) {
  const text = typeof item?.text === 'string' ? item.text : ''
  const attachments = Array.isArray(item?.attachments) ? item.attachments : []
  const supportsImages = modelSupportsImages(item?.submittedModel)
  const blocks = []
  const droppedImages = []
  for (const ref of attachments) {
    if (!ref || typeof ref !== 'object') continue
    if (ref.kind === 'image') {
      if (!supportsImages) {
        droppedImages.push(ref)
        continue
      }
      blocks.push({ type: 'image', attachment: imageAttachmentRef(ref) })
    } else if (ref.kind === 'file') {
      blocks.push({ type: 'file', attachment: fileAttachmentRef(ref) })
    }
  }
  const parts = []
  if (text !== '') parts.push(text)
  if (droppedImages.length > 0) parts.push(droppedImagesNote(droppedImages.length))
  const body = parts.join('\n\n')
  return { content: [{ type: 'text', text: body }, ...blocks], droppedImages }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code
  if (error instanceof Error && typeof error.name === 'string') return error.name
  return 'delivery-failed'
}

/**
 * 会话已不可达（删除/归档）：没有重试意义，直接放弃。
 *
 * @param {string} code
 * @param {string} message
 * @returns {boolean}
 */
export function isFatalTarget(code, message) {
  if (code === 'session/not-found' || code === 'session/archived') return true
  return /session not found|no such session/i.test(message)
}

/**
 * 把附件登记进 orphans 表（GC 的删除候选来源）。
 *
 * @param {object | undefined} table
 * @param {object[]} refs
 * @param {{ origin: 'cancel' | 'clear' | 'abandoned' | 'images-dropped', now?: number }} options
 * @returns {Promise<number>}
 */
export async function registerOrphans(table, refs, options) {
  if (!table || typeof table.put !== 'function') return 0
  const now = options?.now ?? Date.now()
  let count = 0
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') continue
    const record = {
      attachmentId: ref.attachmentId,
      kind: ref.kind === 'file' ? 'file' : 'image',
      bytes: typeof ref.bytes === 'number' ? ref.bytes : 0,
      addedAt: now,
      origin: options?.origin ?? 'clear',
    }
    await table.put(ref.attachmentId, record)
    count += 1
  }
  return count
}

/**
 * 保留最近 keep 条投递记录。
 *
 * @param {object} table - domain.table('delivered')
 * @param {number} [keep]
 * @returns {Promise<number>}
 */
export async function pruneDelivered(table, keep = KEEP_DELIVERED) {
  if (!table || typeof table.entries !== 'function') return 0
  const entries = [...table.entries()].map(([, value]) => value)
  const stale = selectStale(entries, { keep, timeKey: 'deliveredAt', keyOf: (record) => record.id })
  for (const id of stale) await table.delete(id)
  return stale.length
}

/**
 * 投递一项。
 *
 * 顺序（崩溃安全）：先落盘 `sending`（含 attempts+1），再 resolveAgent/followup/flush，
 * 最后写投递记录并删除 outbox 项。中途崩溃 → recover() 把 sending 退回 waiting 重投。
 *
 * @param {object} ctx - 宿主 context（sessionController/sessions）
 * @param {{ outbox: object, delivered: object, orphans?: object, logger?: object, now?: () => number }} deps
 * @param {object} item
 * @returns {Promise<{ ok: boolean, abandoned?: boolean, code?: string, message?: string, attempts?: number, droppedImages?: number }>}
 */
export async function deliverItem(ctx, deps, item) {
  const now = deps?.now ?? (() => Date.now())
  const outbox = deps?.outbox
  const attempt = Number(item?.attempts ?? 0) + 1
  const { content, droppedImages } = buildContent(item)
  // 先标记 sending：进程此刻崩溃时 recover() 能认出「结果未知」。
  await outbox.update(item.id, { status: 'sending', attempts: attempt })
  try {
    const resolved = await ctx.sessionController.resolveAgent(item.sessionId)
    if (resolved && 'error' in resolved && resolved.error) throw resolved.error
    const agent = resolved?.agent
    if (!agent) throw new Error('resolveAgent 未返回 agent')
    const message = createUserMessage({ content, source: { kind: 'user' } })
    agent.followup(message)
    if (!(await ctx.sessions.flush(agent.session))) throw new Error('flush not acknowledged')
  } catch (error) {
    const code = errorCode(error)
    const message = errorMessage(error)
    if (isFatalTarget(code, message)) {
      await registerOrphans(deps?.orphans, item.attachments, { origin: 'abandoned', now: now() })
      await outbox.remove(item.id)
      return { ok: false, abandoned: true, code, message, attempts: attempt }
    }
    await outbox.update(item.id, { status: 'failed', attempts: attempt, lastError: message })
    return { ok: false, abandoned: false, code, message, attempts: attempt }
  }
  const record = {
    id: item.id,
    clientTag: item.clientTag,
    sessionId: item.sessionId,
    deliveredAt: now(),
    text: typeof item.text === 'string' ? item.text : '',
    attachments: (Array.isArray(item.attachments) ? item.attachments : []).filter(
      (ref) => !droppedImages.includes(ref),
    ),
    status: 'delivered',
  }
  if (typeof item.submittedModel === 'string' && item.submittedModel !== '') record.model = item.submittedModel
  if (droppedImages.length > 0) record.note = `images-dropped:${droppedImages.length}`
  await deps.delivered.put(record.id, record)
  await pruneDelivered(deps.delivered, deps.keepDelivered ?? KEEP_DELIVERED)
  await registerOrphans(deps?.orphans, droppedImages, { origin: 'images-dropped', now: now() })
  await outbox.remove(item.id)
  return { ok: true, droppedImages: droppedImages.length }
}
