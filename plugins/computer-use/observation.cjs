'use strict';

// Observation bookkeeping for the Computer Use plugin.
//
// Every fresh desktop observation gets a generation number. A write tool never
// trusts an identity that came from an older generation: an element reference
// may only *select* a window, and the identity that the policy check runs
// against is always re-read from the current generation.

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

function createObservationStore({ clock, ttlMs = 1500, snapshotTtlMs = 30_000 } = {}) {
  const now = () => (clock?.now ? clock.now() : Date.now());
  let generation = 0;
  let observation = null;
  const snapshots = new Map();

  function store(entry) {
    generation += 1;
    observation = {
      generation,
      observedAt: now(),
      tool: entry.tool || null,
      args: entry.args || {},
      windows: entry.windows || [],
      active: entry.active || null,
      metrics: entry.metrics || null,
      snapshotId: entry.snapshotId || null,
    };
    if (observation.snapshotId) registerSnapshot(observation.snapshotId, {
      windows: observation.windows,
      target: entry.target || null,
      tool: observation.tool,
    });
    return observation;
  }

  function registerSnapshot(snapshotId, entry = {}) {    if (typeof snapshotId !== 'string' || !snapshotId) return null;
    const record = {
      snapshotId,
      generation: entry.generation ?? generation,
      createdAt: now(),
      windows: entry.windows || [],
      target: entry.target || null,
      tool: entry.tool || null,
    };
    snapshots.set(snapshotId, record);
    if (snapshots.size > 512) snapshots.delete(snapshots.keys().next().value);
    return record;
  }

  function lookupSnapshot(snapshotId) {
    const record = snapshots.get(snapshotId);
    if (!record) return null;
    if (now() - record.createdAt > snapshotTtlMs) {
      snapshots.delete(snapshotId);
      return null;
    }
    return record;
  }

  function isFresh() {
    if (!observation) return false;
    return now() - observation.observedAt <= ttlMs;
  }

  // Resolve the target window of a call against the current generation.
  // Returns `{ target, generation, token }` or `{ error, generation }`.
  function resolveTarget({ args = {}, name = '' } = {}) {
    if (!observation) {
      return { error: 'No desktop observation is available yet; call get_desktop_state first.', generation };
    }
    const token = parseElementToken(args.element_token);
    let record = null;
    if (token) {
      record = lookupSnapshot(token.snapshotId);
      if (!record) {
        return {
          error: `Element reference ${args.element_token} is stale or unknown; re-observe the window and try again.`,
          generation: observation.generation,
        };
      }
    }
    if (record) {
      const requested = requestedIdentity(args);
      if (requested && !sameWindow(requested, record.target)) {
        return {
          error: 'The element reference and the requested window disagree; re-observe and use a single target.',
          generation: observation.generation,
        };
      }
      if (record.target) {
        const current = observation.windows.find((window) => sameWindow(window, record.target));
        if (!current) {
          return {
            error: 'The observed target window is no longer present; re-observe the desktop and select a visible window.',
            generation: observation.generation,
          };
        }
        return {
          target: current,
          generation: observation.generation,
          token: {
            snapshotId: record.snapshotId,
            generation: record.generation,
            rebound: record.generation !== observation.generation,
          },
        };
      }
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

  // Merge extra observed windows into the current observation without
  // advancing the generation: a window list is the same desktop state.
  function mergeWindows(windows = [], active = null) {
    if (!observation) {
      return store({ tool: 'list_windows', windows, active });
    }
    const unique = new Map([...observation.windows, ...windows].map((window) => [`${window.pid ?? ''}:${window.id}:${window.title || ''}`, window]));
    observation = { ...observation, windows: [...unique.values()], active: observation.active || active };
    return observation;
  }

  return {
    store,
    mergeWindows,
    registerSnapshot,
    lookupSnapshot,
    resolveTarget,
    snapshot: () => observation,
    isFresh,
    generation: () => generation,
    parseElementToken,
  };
}

module.exports = { createObservationStore, parseElementToken };
