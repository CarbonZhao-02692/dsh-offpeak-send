import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPrefs,
  normalizePrefs,
  effectiveEnabled,
  sessionPrefsView,
  canSetSession,
  canSetDefault,
} from '../lib/core/prefs.js';

test('defaultPrefs：默认开启、没有覆盖', () => {
  const p = defaultPrefs();
  assert.equal(p.defaultEnabled, true);
  assert.deepEqual(p.sessions, {});
  assert.equal(effectiveEnabled(p, 's1'), true);
});

test('normalizePrefs：非法字段回默认，只收布尔覆盖', () => {
  assert.deepEqual(normalizePrefs(null), { version: 1, defaultEnabled: true, sessions: {} });
  assert.deepEqual(normalizePrefs({ defaultEnabled: false, sessions: { s1: false, s2: 'no', '': true } }), {
    version: 1,
    defaultEnabled: false,
    sessions: { s1: false },
  });
});

test('effectiveEnabled：有覆盖用覆盖，否则默认', () => {
  const p = normalizePrefs({ defaultEnabled: true, sessions: { s1: false, s2: true } });
  assert.equal(effectiveEnabled(p, 's1'), false);
  assert.equal(effectiveEnabled(p, 's2'), true);
  assert.equal(effectiveEnabled(p, 's3'), true);
});

test('sessionPrefsView：null 表示跟随默认', () => {
  const p = normalizePrefs({ defaultEnabled: false, sessions: { s1: true } });
  assert.deepEqual(sessionPrefsView(p, 's1'), { defaultEnabled: false, sessionEnabled: true, effectiveEnabled: true });
  assert.deepEqual(sessionPrefsView(p, 's2'), { defaultEnabled: false, sessionEnabled: null, effectiveEnabled: false });
});

test('canSetSession：有排队时不能关，清覆盖成默认关也不行', () => {
  const p = normalizePrefs({ defaultEnabled: false, sessions: { s1: true } });
  assert.equal(canSetSession(p, 's1', 0, false).ok, true);
  assert.deepEqual(canSetSession(p, 's1', 2, false), { ok: false, code: 'session-has-pending', count: 2 });
  assert.deepEqual(canSetSession(p, 's1', 2, null), { ok: false, code: 'session-has-pending', count: 2 });
  assert.equal(canSetSession(p, 's1', 2, true).ok, true);
  assert.equal(canSetSession(p, 's2', 0, null).ok, true);
});

test('canSetDefault：有排队且无覆盖的会话会阻止默认关闭', () => {
  const p = normalizePrefs({ defaultEnabled: true, sessions: { pinned: true } });
  assert.equal(canSetDefault(p, true, { s1: 2 }).ok, true);
  assert.deepEqual(canSetDefault(p, false, { s1: 2, pinned: 3 }), {
    ok: false,
    code: 'sessions-have-pending',
    sessions: [{ sessionId: 's1', count: 2 }],
  });
  assert.equal(canSetDefault(p, false, { pinned: 3 }).ok, true);
  assert.equal(canSetDefault(p, false, {}).ok, true);
});

test('canSetSession / canSetDefault：非法输入', () => {
  const p = defaultPrefs();
  assert.deepEqual(canSetSession(p, 's1', 0, 'yes'), { ok: false, code: 'invalid-enabled' });
  assert.deepEqual(canSetDefault(p, 'no', {}), { ok: false, code: 'invalid-enabled' });
});
