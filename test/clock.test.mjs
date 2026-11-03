import test from 'node:test';
import assert from 'node:assert/strict';
import {
	phaseAt, nextOffpeakStart, nextPeakStart, sendAt, beijing, fmtClock, fmtClockSec, fmtRemaining,
	normalizeCfg,
} from '../lib/core/clock.js';
import { HOLIDAYS_2026 } from '../lib/core/holidays.js';

/** 北京墙钟 → UTC 毫秒 */
const bj = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);
const CFG = { peak: [[540, 720], [840, 1080]], bufferMs: 3000, holidays: HOLIDAYS_2026 };

// 2026-10-28 是周三（工作日）
test('phaseAt 工作日边界', () => {
	const cases = [
		[bj(2026, 10, 28, 8, 59, 59), 'offpeak'],
		[bj(2026, 10, 28, 9, 0, 0), 'peak'],
		[bj(2026, 10, 28, 11, 59, 59), 'peak'],
		[bj(2026, 10, 28, 12, 0, 0), 'offpeak'],
		[bj(2026, 10, 28, 13, 59, 59), 'offpeak'],
		[bj(2026, 10, 28, 14, 0, 0), 'peak'],
		[bj(2026, 10, 28, 17, 59, 59), 'peak'],
		[bj(2026, 10, 28, 18, 0, 0), 'offpeak'],
		[bj(2026, 10, 28, 23, 30, 0), 'offpeak'],
	];
	for (const [t, want] of cases) assert.equal(phaseAt(t, CFG), want, new Date(t).toISOString());
});

test('周末与法定节假日全为谷时', () => {
	assert.equal(phaseAt(bj(2026, 10, 31, 10, 0), CFG), 'offpeak', '周六');
	assert.equal(phaseAt(bj(2026, 11, 1, 10, 0), CFG), 'offpeak', '周日');
	assert.equal(phaseAt(bj(2026, 10, 1, 10, 0), CFG), 'offpeak', '国庆');
	assert.equal(phaseAt(bj(2026, 2, 18, 10, 0), CFG), 'offpeak', '春节');
	// 调休上班的周六（2026-02-14 上班）仍按周末 → 谷时（保守）
	assert.equal(phaseAt(bj(2026, 2, 14, 10, 0), CFG), 'offpeak', '调休周六');
});

test('nextOffpeakStart / nextPeakStart', () => {
	const t = bj(2026, 10, 28, 15, 0);
	assert.equal(nextOffpeakStart(t, CFG), bj(2026, 10, 28, 18, 0));
	assert.equal(nextPeakStart(t, CFG), bj(2026, 10, 29, 9, 0));
	// 午休 12:00 就是谷时起点
	assert.equal(nextOffpeakStart(bj(2026, 10, 28, 10, 0), CFG), bj(2026, 10, 28, 12, 0));
	// 周五 18:00 之后的下一个高峰是周一 09:00
	assert.equal(nextPeakStart(bj(2026, 10, 30, 18, 0), CFG), bj(2026, 11, 2, 9, 0));
});

test('sendAt：谷时立即、高峰延迟 +buffer', () => {
	const offpeak = bj(2026, 10, 28, 12, 24);
	const r1 = sendAt(offpeak, CFG);
	assert.equal(r1.sendAt, offpeak);
	assert.equal(r1.delayed, false);

	const peak = bj(2026, 10, 28, 14, 0, 1);
	const r2 = sendAt(peak, CFG);
	assert.equal(r2.sendAt, bj(2026, 10, 28, 18, 0, 3));
	assert.equal(r2.delayed, true);
	assert.equal(r2.reason, 'peak');
	assert.equal(r2.waitMs, r2.sendAt - peak);
});

test('不变量：sendAt 落在 [now, now+4h+10s] 且相位为谷时', () => {
	// 覆盖一周内每 7 分钟的采样点 + 关键边界
	const samples = [];
	const base = bj(2026, 10, 26, 0, 0);
	for (let i = 0; i < 7 * 1440; i += 7) samples.push(base + i * 60000);
	for (const h of [9, 12, 14, 18]) samples.push(bj(2026, 10, 28, h, 0, 0) - 1, bj(2026, 10, 28, h, 0, 0), bj(2026, 10, 28, h, 0, 0) + 1);
	for (const now of samples) {
		const r = sendAt(now, CFG);
		assert.ok(r.sendAt >= now, 'never earlier');
		assert.ok(r.sendAt <= now + 4 * 3600_000 + 10_000, 'max wait 4h+10s');
		assert.equal(phaseAt(r.sendAt, CFG), 'offpeak', 'lands in offpeak ' + new Date(r.sendAt).toISOString());
	}
});

test('buffer 由配置决定并被钳制', () => {
	assert.equal(normalizeCfg({ bufferMs: 1000 }).bufferMs, 1000);
	assert.equal(normalizeCfg({ bufferMs: 60_000 }).bufferMs, 10_000);
	assert.equal(normalizeCfg({ bufferMs: 10 }).bufferMs, 1000);
	assert.equal(normalizeCfg({}).bufferMs, 3000);
	const t = bj(2026, 10, 28, 15, 0);
	assert.equal(sendAt(t, { ...CFG, bufferMs: 1000 }).sendAt, bj(2026, 10, 28, 18, 0, 1));
});

test('时区固定 UTC+8：不随进程时区变化', () => {
	const t = bj(2026, 10, 28, 10, 30);
	assert.equal(beijing(t).hour, 10);
	assert.equal(beijing(t).dateKey, '2026-10-28');
	assert.equal(fmtClock(t), '10:30');
	assert.equal(fmtClockSec(bj(2026, 10, 28, 18, 0, 3)), '18:00:03');
});

test('fmtRemaining', () => {
	assert.equal(fmtRemaining(9_000), '9 秒');
	assert.equal(fmtRemaining(252_000), '4 分 12 秒');
	assert.equal(fmtRemaining(3 * 3600_000 + 45 * 60_000), '3 小时 45 分');
	assert.equal(fmtRemaining(0), '0 秒');
});

test('未知年份/无节假日配置：按工作日（只多等不多付）', () => {
	const cfgNoHoliday = { peak: [[540, 720], [840, 1080]], bufferMs: 3000, holidays: [] };
	assert.equal(phaseAt(bj(2027, 10, 1, 10, 0), cfgNoHoliday), 'peak', '2027 国庆未收录 → 视为工作日高峰');
	assert.equal(phaseAt(bj(2027, 10, 2, 10, 0), cfgNoHoliday), 'offpeak', '周六仍谷时');
});
