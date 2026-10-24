'use strict';

// A clock whose time only moves when a test asks it to. Timers fire in
// scheduled order while the clock is advanced, so backoff and expiry logic
// can be asserted without wall-clock waits.
function createManualClock({ start = 1_700_000_000_000 } = {}) {
  let current = start;
  let sequence = 0;
  const timers = new Map();

  function dueTimers(upTo) {
    return [...timers.entries()]
      .filter(([, timer]) => timer.at <= upTo)
      .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
  }

  return {
    now: () => current,
    setTimeout(handler, delay) {
      const id = ++sequence;
      timers.set(id, { at: current + Math.max(0, Number(delay) || 0), handler });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = current + Math.max(0, Number(ms) || 0);
      for (;;) {
        const next = dueTimers(target)[0];
        if (!next) break;
        timers.delete(next[0]);
        current = Math.max(current, next[1].at);
        await next[1].handler();
      }
      current = target;
    },
  };
}

module.exports = { createManualClock };
