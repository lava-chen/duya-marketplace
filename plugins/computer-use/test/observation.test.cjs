'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createObservationStore } = require('../observation.cjs');
const { createManualClock } = require('./helpers/manual-clock.cjs');

const WINDOWS = [
  { id: '1', pid: 101, title: 'Blocked App', app: 'blocked.exe', processName: 'blocked.exe' },
  { id: '2', pid: 202, title: 'Allowed App', app: 'allowed.exe', processName: 'allowed.exe' },
];

function store(clock) {
  return createObservationStore({ clock, ttlMs: 1500, snapshotTtlMs: 30_000 });
}

test('each stored observation advances the generation', () => {
  const clock = createManualClock();
  const observations = store(clock);
  assert.equal(observations.generation(), 0);
  const first = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  assert.equal(first.generation, 1);
  const second = observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[1] });
  assert.equal(second.generation, 2);
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

test('an element reference resolves against the current generation', () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  observations.registerSnapshot('s12345678', { target: WINDOWS[1], tool: 'get_window_state' });
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });

  const resolved = observations.resolveTarget({ args: { element_token: 's12345678:1' }, name: 'set_value' });
  assert.equal(resolved.target.id, '2');
  assert.equal(resolved.token.snapshotId, 's12345678');
  assert.equal(resolved.token.rebound, true);
});

test('an element reference from an unknown snapshot is refused', () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  const resolved = observations.resolveTarget({ args: { element_token: 'sdeadbeef:1' }, name: 'set_value' });
  assert.match(resolved.error, /stale or unknown/);
});

test('an element reference whose window disappeared is refused', () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.registerSnapshot('s12345678', { target: WINDOWS[1], tool: 'get_window_state' });
  observations.store({ tool: 'get_desktop_state', windows: [WINDOWS[0]], active: WINDOWS[0] });
  const resolved = observations.resolveTarget({ args: { element_token: 's12345678:1' }, name: 'set_value' });
  assert.match(resolved.error, /no longer present/);
});

test('an element reference that disagrees with the requested window is refused', () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.registerSnapshot('s12345678', { target: WINDOWS[1], tool: 'get_window_state' });
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  const resolved = observations.resolveTarget({
    args: { element_token: 's12345678:1', window_id: 1, pid: 101 },
    name: 'set_value',
  });
  assert.match(resolved.error, /disagree/);
});

test('a snapshot reference expires with the snapshot lifetime', async () => {
  const clock = createManualClock();
  const observations = store(clock);
  observations.registerSnapshot('s12345678', { target: WINDOWS[1], tool: 'get_window_state' });
  observations.store({ tool: 'get_desktop_state', windows: WINDOWS, active: WINDOWS[0] });
  await clock.advance(30_001);
  const resolved = observations.resolveTarget({ args: { element_token: 's12345678:1' }, name: 'set_value' });
  assert.match(resolved.error, /stale or unknown/);
});

test('a write without any observation is refused instead of guessing', () => {
  const clock = createManualClock();
  const observations = store(clock);
  const resolved = observations.resolveTarget({ args: {}, name: 'click' });
  assert.match(resolved.error, /No desktop observation/);
});
