'use strict';

// Observation bookkeeping for the Computer Use plugin.
//
// Every observation produces a state handle. A state carries the identity of
// the observed window, the capture that was taken and the generation it
// belongs to. An action names the state it was derived from, so the plugin can
// refuse an action that no longer matches the screen the agent looked at.

const { randomUUID } = require('node:crypto');
const { selectTargetWindow } = require('./identity.cjs');

const TOKEN_PATTERN = /^([A-Za-z0-9_-]{4,64}):(\d+)$/;

function parseElementToken(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(TOKEN_PATTERN);
  if (!match) return null;
  return { snapshotId: match[1], index: Number(match[2]) };
}

function sameWindow(left, right) {
  if (!left || !right) return false;
  return String(left.id) === String(right.id) && Number(left.pid) === Number(right.pid);
}

function newStateId() {
  return `st_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function createObservationStore({ clock, ttlMs = 1500, stateTtlMs = 30_000, maxStates = 64 } = {}) {
  const now = () => (clock?.now ? clock.now() : Date.now());
  let generation = 0;
  let observation = null;
  const states = new Map();

  function pruneStates() {
    for (const [id, state] of states) {
      if (now() - state.createdAt > stateTtlMs) states.delete(id);
    }
    while (states.size > maxStates) states.delete(states.keys().next().value);
  }

  // Record a fresh observation and mint the state handle that actions bind to.
  function store(entry) {
    generation += 1;
    const active = entry.active || null;
    const target = entry.target
      || (entry.windows || []).find((window) => sameWindow(window, active))
      || null;
    observation = {
      generation,
      observedAt: now(),
      tool: entry.tool || null,
      args: entry.args || {},
      windows: entry.windows || [],
      active,
      metrics: entry.metrics || null,
      snapshotId: entry.snapshotId || null,
    };
    const state = {
      state_id: newStateId(),
      generation,
      createdAt: now(),
      tool: entry.tool || null,
      window: target,
      snapshotId: entry.snapshotId || null,
      screenshot: entry.screenshot || null,
      display: entry.metrics || null,
    };
    states.set(state.state_id, state);
    pruneStates();
    return state;
  }

  // Merge extra observed windows into the current observation without
  // advancing the generation: a window list is the same desktop state.
  function mergeWindows(windows = [], active = null) {
    if (!observation) return null;
    const unique = new Map([...observation.windows, ...windows].map((window) => [`${window.pid ?? ''}:${window.id}:${window.title || ''}`, window]));
    observation = { ...observation, windows: [...unique.values()], active: observation.active || active };
    return observation;
  }

  function isFresh() {
    if (!observation) return false;
    return now() - observation.observedAt <= ttlMs;
  }

  // Resolve a state handle. An unknown or expired handle is not a state.
  function resolveState(stateId) {
    if (typeof stateId !== 'string' || !stateId) return null;
    const state = states.get(stateId);
    if (!state) return null;
    if (now() - state.createdAt > stateTtlMs) {
      states.delete(stateId);
      return null;
    }
    return state;
  }

  // Is the window this state observed still on screen?
  function windowStillObserved(state) {
    if (!state?.window?.id) return true;
    if (!observation) return false;
    return observation.windows.some((window) => (
      window.id === state.window.id
      && (state.window.pid === null || state.window.pid === undefined || window.pid === state.window.pid)
    ));
  }

  // Resolve the target window of a call against the current generation.
  function resolveTarget({ args = {}, name = '' } = {}) {
    if (!observation) {
      return { error: 'No desktop observation is available yet; call get_desktop_state first.', generation };
    }
    const token = parseElementToken(args.element_token);
    if (token) {
      return {
        error: `Element reference ${args.element_token} is not bound to an observation; pass the state_id of the observation it came from.`,
        generation: observation.generation,
      };
    }
    return {
      target: selectTargetWindow(observation, args, name),
      generation: observation.generation,
      token: null,
    };
  }

  function requestedIdentity(args = {}) {
    const target = args.target && typeof args.target === 'object' ? args.target : {};
    const id = args.window_id ?? args.windowId ?? target.window_id ?? target.windowId;
    const pid = args.pid ?? target.pid;
    if (id === undefined && pid === undefined) return null;
    return {
      id: id === undefined ? null : String(id),
      pid: pid === undefined ? null : Number(pid),
    };
  }

  return {
    store,
    mergeWindows,
    resolveState,
    resolveTarget,
    windowStillObserved,
    requestedIdentity,
    current: () => observation,
    isFresh,
    generation: () => generation,
    stateCount: () => states.size,
    parseElementToken,
  };
}

module.exports = { createObservationStore, parseElementToken };
