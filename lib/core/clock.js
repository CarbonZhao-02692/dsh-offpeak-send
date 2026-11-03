/**
 * 谷时（DeepSeek 空闲计价）时间模型 —— 纯函数，宿主与客户端共用。
 * 约束：只接受 UTC 毫秒 + 固定 +8 偏移；禁止 new Date().getHours()（受浏览器时区污染）。
 * 高峰＝北京时间周一至周五 09:00–12:00、14:00–18:00（法定节假日除外）；其余全为谷时。
 * 调休上班日（周六日上班）按官方字面「其余包括周末」处理为谷时：只可能多等，不会多付。
 */

export const TZ_OFFSET_MS = 8 * 3600_000;

/** 分钟区间，左闭右开 */
export const DEFAULT_PEAK_RANGES = [[540, 720], [840, 1080]];

export const MIN_BUFFER_MS = 1000;
export const MAX_BUFFER_MS = 10_000;
export const DEFAULT_BUFFER_MS = 3000;

/** @param {any} cfg @returns {{peak:number[][], bufferMs:number, holidays:string[]}} */
export function normalizeCfg(cfg) {
	const c = cfg && typeof cfg === 'object' ? cfg : {};
	const peak = Array.isArray(c.peak) && c.peak.length > 0 ? c.peak : DEFAULT_PEAK_RANGES;
	const raw = typeof c.bufferMs === 'number' && Number.isFinite(c.bufferMs) ? c.bufferMs : DEFAULT_BUFFER_MS;
	const bufferMs = Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, Math.round(raw)));
	const holidays = Array.isArray(c.holidays) ? c.holidays.filter((d) => typeof d === 'string') : [];
	// 调试/验证用：把任意日期当成工作日（周末/节假日也走高峰判定）。缺省 false。
	const forceWorkday = c.forceWorkday === true;
	return { peak, bufferMs, holidays, forceWorkday };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * 北京墙钟分量。weekday: 0=周日 … 6=周六。
 * @param {number} ms
 */
export function beijing(ms) {
	const d = new Date(ms + TZ_OFFSET_MS);
	const y = d.getUTCFullYear();
	const mo = d.getUTCMonth() + 1;
	const day = d.getUTCDate();
	const h = d.getUTCHours();
	const mi = d.getUTCMinutes();
	const s = d.getUTCSeconds();
	return {
		year: y,
		month: mo,
		day,
		weekday: d.getUTCDay(),
		hour: h,
		minute: mi,
		second: s,
		minuteOfDay: h * 60 + mi,
		dateKey: `${y}-${pad(mo)}-${pad(day)}`,
	};
}

/** 是否非工作日（周末或法定节假日放假）。调休上班日不特殊处理。 */
export function isOffDay(ms, cfg) {
	const c = normalizeCfg(cfg);
	if (c.forceWorkday === true) return false;
	const b = beijing(ms);
	if (b.weekday === 0 || b.weekday === 6) return true;
	return c.holidays.includes(b.dateKey);
}

/** @returns {'peak'|'offpeak'} */
export function phaseAt(ms, cfg) {
	const c = normalizeCfg(cfg);
	if (isOffDay(ms, c)) return "offpeak";
	const m = beijing(ms).minuteOfDay;
	for (const [start, end] of c.peak) if (m >= start && m < end) return "peak";
	return "offpeak";
}

/**
 * 严格晚于 ms 的、下一个「相位切换点」（分钟对齐：该分钟为 want 且前一分钟不是 want）。
 * 处在 want 相位中时返回该相位的**下一次**起点，而不是当前分钟。
 * 最多向前找 8 天，找不到返回 ms+8d。
 * @param {number} ms @param {any} cfg @param {'peak'|'offpeak'} want
 */
export function nextBoundary(ms, cfg, want) {
	const c = normalizeCfg(cfg);
	const startMinute = Math.floor(ms / 60000) + 1;
	for (let i = 0; i < 8 * 1440; i++) {
		const at = (startMinute + i) * 60000;
		if (phaseAt(at, c) === want && phaseAt(at - 60000, c) !== want) return at;
	}
	return ms + 8 * 86_400_000;
}

export const nextOffpeakStart = (ms, cfg) => nextBoundary(ms, cfg, "offpeak");
export const nextPeakStart = (ms, cfg) => nextBoundary(ms, cfg, "peak");

/**
 * 决策：现在就在谷时 → 立即；在高峰 → 谷时开始 + buffer。
 * @param {number} ms @param {any} cfg
 * @returns {{sendAt:number, delayed:boolean, reason:'peak'|undefined, waitMs:number}}
 */
export function sendAt(ms, cfg) {
	const c = normalizeCfg(cfg);
	if (phaseAt(ms, c) === "offpeak") return { sendAt: ms, delayed: false, reason: undefined, waitMs: 0 };
	const at = nextOffpeakStart(ms, c) + c.bufferMs;
	return { sendAt: at, delayed: true, reason: "peak", waitMs: Math.max(0, at - ms) };
}

/** 'HH:MM' */
export function fmtClock(ms) {
	const b = beijing(ms);
	return `${pad(b.hour)}:${pad(b.minute)}`;
}

/** 'HH:MM:SS' */
export function fmtClockSec(ms) {
	const b = beijing(ms);
	return `${pad(b.hour)}:${pad(b.minute)}:${pad(b.second)}`;
}

/** 人类可读剩余时长：'3 小时 45 分' / '4 分 12 秒' / '9 秒' */
export function fmtRemaining(ms) {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const d = Math.floor(total / 86400);
	const h = Math.floor((total % 86400) / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (d > 0) return `${d} 天 ${h} 小时`;
	if (h > 0) return `${h} 小时 ${m} 分`;
	if (m > 0) return `${m} 分 ${s} 秒`;
	return `${s} 秒`;
}
