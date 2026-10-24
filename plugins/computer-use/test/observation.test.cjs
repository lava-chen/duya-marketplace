'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createObservationStore, parseElementToken } = require('../observation.cjs');
const { createManualClock } = require('./helpers/manual-clock.cjs');

const WINDOWS = [
  { id: '1', pid: 101, title: 'Blocked App', app: 'blocked.exe', processName: 'blocked.exe' },
  { id: '2', pid: 202, title: 'Allowed App', app: 'allowed.exe', processName: 'allowed.exe' },
];

function store(clock) {
  return createObservationStore({ clock, ttlMs: 1500, stateTtlMs: 30_000 });
}

test('each stored observation advances the generation and mints a state handle', () => {
  const clock = createManualClock();
  const observations = store(clock);
  assert.equal(observations.generation(), 0);
  const first = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  assert.equal(first.generation, 1);
  assert.match(first.state_id, /^st_[0-9a-f]{8}$/);
  const second = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[1] });
  assert.equal(second.generation, 2);
  assert.notEqual(second.state_id, first.state_id);
  assert.equal(observations.generation(), 2);
});

test('the cached observation goes stale after the configured lifetime', async () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  assert.equal(observations.isFresh(), true);
  await clock.advance(1499);
  assert.equal(observations.isFresh(), true);
  await clock.advance(2);
  assert.equal(observations.isFresh(), false);
});

test('a write without an explicit window resolves to the observed active window', () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[1] });
  const resolved = observations.resolveTarget({ args: {}, name: 'click' });
  assert.equal(resolved.target.title, 'Allowed App');
  assert.equal(resolved.generation, 1);
});

test('a state handle keeps naming its own window after a newer observation', () => {
  const clock = createManualClock();
  const observations = store(clock);
  const first = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[1] });

  const resolved = observations.resolveState(first.state_id);
  assert.ok(resolved, 'the older state is still known');
  assert.equal(resolved.window.id, '1');
  assert.equal(resolved.generation, 1);
});

test('an unknown state handle is not a state', () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  assert.equal(observations.resolveState('st_deadbeef'), null);
  assert.equal(observations.resolveState(''), null);
  assert.equal(observations.resolveState(undefined), null);
});

test('a state handle expires with the state lifetime', async () => {
  const clock = createManualClock();
  const observations = store(clock);
  const state = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  await clock.advance(29_999);
  assert.ok(observations.resolveState(state.state_id), 'the state is still alive');
  await clock.advance(2);
  assert.equal(observations.resolveState(state.state_id), null);
});

test('a state whose window left the screen is no longer observed', () => {
  const clock = createManualClock();
  const observations = store(clock);
  const state = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  assert.equal(observations.windowStillObserved(state), true);

  observations.store({ tool: 'get_desktop_state', windows: [WINDOWS[1]], active: WINDOWS[1] });
  assert.equal(observations.windowStillObserved(state), false);
});

test('a state whose window is still on screen stays observed', () => {
  const clock = createManualClock();
  const observations = store(clock);
  const state = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[1] });
  assert.equal(observations.windowStillObserved(state), true);
});

test('an element reference without a state is refused', () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  const resolved = observations.resolveTarget({ args: { element_token: 'sdeadbeef:1' }, name: 'set_value' });
  assert.match(resolved.error, /not bound to an observation/);
  assert.match(resolved.error, /state_id/);
});

test('a write without any observation is refused instead of guessing', () => {
  const clock = createManualClock();
  const observations = store(clock);
  const resolved = observations.resolveTarget({ args: {}, name: 'click' });
  assert.match(resolved.error, /No desktop observation/);
});

test('the requested window identity is read from every accepted spelling', () => {
  const clock = createManualClock();
  const observations = store(clock);
  assert.equal(observations.requestedIdentity({}), null);
  assert.deepEqual(observations.requestedIdentity({ window_id: 7 }), { id: '7', pid: null });
  assert.deepEqual(observations.requestedIdentity({ windowId: 7, pid: 42 }), { id: '7', pid: 42 });
  assert.deepEqual(observations.requestedIdentity({ target: { window_id: 9, pid: 5 } }), { id: '9', pid: 5 });
});

test('an element token is parsed into its snapshot and index', () => {
  assert.deepEqual(parseElementToken('s12345678:3'), { snapshotId: 's12345678', index: 3 });
  assert.equal(parseElementToken('s12345678'), null);
  assert.equal(parseElementToken('nope'), null);
  assert.equal(parseElementToken(42), null);
});

test('the state store is bounded', () => {
  const clock = createManualClock();
  const observations = createObservationStore({ clock, ttlMs: 1500, stateTtlMs: 30_000, maxStates: 4 });
  for (let index = 0; index < 10; index += 1) {
    observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  }
  assert.equal(observations.stateCount(), 4);
});
