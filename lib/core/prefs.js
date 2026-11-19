/**
 * 会话级谷时开关的纯逻辑：默认值 + 每会话覆盖。
 * 默认与覆盖都由宿主持久化；客户端只消费 /pending、/prefs 的结果。
 */

export const PREFS_VERSION = 1;

/** @returns {{version:number, defaultEnabled:boolean, sessions:Record<string,boolean>}} */
export function defaultPrefs() {
  return { version: PREFS_VERSION, defaultEnabled: true, sessions: {} };
}

/**
 * 读取不可信文件/请求后的归一化；非法字段回默认，不抛。
 * @param {unknown} raw
 * @returns {{version:number, defaultEnabled:boolean, sessions:Record<string,boolean>}}
 */
export function normalizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sessions = {};
  if (src.sessions && typeof src.sessions === 'object' && !Array.isArray(src.sessions)) {
    for (const [key, value] of Object.entries(src.sessions)) {
      if (typeof key === 'string' && key !== '' && typeof value === 'boolean') sessions[key] = value;
    }
  }
  return {
    version: PREFS_VERSION,
    defaultEnabled: typeof src.defaultEnabled === 'boolean' ? src.defaultEnabled : true,
    sessions,
  };
}

/**
 * 会话的有效开关：有覆盖用覆盖，否则用默认。
 * @param {{defaultEnabled:boolean, sessions:Record<string,boolean>}} prefs
 * @param {string} sessionId
 * @returns {boolean}
 */
export function effectiveEnabled(prefs, sessionId) {
  const p = normalizePrefs(prefs);
  if (typeof sessionId === 'string' && Object.prototype.hasOwnProperty.call(p.sessions, sessionId)) {
    return p.sessions[sessionId];
  }
  return p.defaultEnabled;
}

/**
 * 给客户端的会话视图：sessionEnabled=null 表示跟随默认。
 * @param {{defaultEnabled:boolean, sessions:Record<string,boolean>}} prefs
 * @param {string} sessionId
 */
export function sessionPrefsView(prefs, sessionId) {
  const p = normalizePrefs(prefs);
  const has = typeof sessionId === 'string' && Object.prototype.hasOwnProperty.call(p.sessions, sessionId);
  const sessionEnabled = has ? p.sessions[sessionId] : null;
  return {
    defaultEnabled: p.defaultEnabled,
    sessionEnabled,
    effectiveEnabled: sessionEnabled === null ? p.defaultEnabled : sessionEnabled,
  };
}

/**
 * 把会话覆盖改成 enabled（null=清除覆盖）后，是否允许。
 * 规则：有效值不能是 false 且该会话还有排队。
 * @returns {{ok:true} | {ok:false, code:'session-has-pending', count:number} | {ok:false, code:'invalid-enabled'}}
 */
export function canSetSession(prefs, sessionId, pendingCount, enabled) {
  const p = normalizePrefs(prefs);
  if (enabled !== null && typeof enabled !== 'boolean') return { ok: false, code: 'invalid-enabled' };
  const nextEffective = enabled === null ? p.defaultEnabled : enabled;
  const count = Math.max(0, Math.trunc(Number(pendingCount) || 0));
  if (nextEffective === false && count > 0) return { ok: false, code: 'session-has-pending', count };
  return { ok: true };
}

/**
 * 把默认改成 enabled 后，是否允许。
 * 规则：默认改成 false 时，任何「有排队且没有显式覆盖」的会话都会变成排队中关闭，拒绝。
 * @param {Record<string, number>} pendingBySession
 * @returns {{ok:true} | {ok:false, code:'sessions-have-pending', sessions:{sessionId:string,count:number}[]} | {ok:false, code:'invalid-enabled'}}
 */
export function canSetDefault(prefs, enabled, pendingBySession) {
  const p = normalizePrefs(prefs);
  if (typeof enabled !== 'boolean') return { ok: false, code: 'invalid-enabled' };
  if (enabled === true) return { ok: true };
  const blocked = [];
  const counts = pendingBySession && typeof pendingBySession === 'object' ? pendingBySession : {};
  for (const [sessionId, rawCount] of Object.entries(counts)) {
    const count = Math.max(0, Math.trunc(Number(rawCount) || 0));
    if (count <= 0) continue;
    if (Object.prototype.hasOwnProperty.call(p.sessions, sessionId)) continue;
    blocked.push({ sessionId, count });
  }
  if (blocked.length > 0) return { ok: false, code: 'sessions-have-pending', sessions: blocked };
  return { ok: true };
}
