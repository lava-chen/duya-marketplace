#!/usr/bin/env node
'use strict';

// A supervised client for the official Cua Driver MCP server.
//
// The driver is a child process that speaks newline-delimited JSON-RPC over
// stdin/stdout. This client owns that process: it starts lazily, performs the
// MCP handshake, supervises the child, and restarts it with backoff when it
// dies unexpectedly. A failed start is never fatal - the next start retries.

const { spawn } = require('node:child_process');

const INITIALIZE_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'duya-computer-use', version: '0.3.0' },
};

function systemClock() {
  return {
    now: () => Date.now(),
    setTimeout: (handler, delay) => setTimeout(handler, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

// Dotted numeric comparison that ignores a leading "v" and missing segments.
function compareVersions(left, right) {
  const parse = (value) => String(value ?? '').trim().replace(/^v/i, '').split('.').map((part) => {
    const match = part.match(/^(\d+)/);
    return match ? Number(match[1]) : 0;
  });
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function createDriverClient(options = {}) {
  const {
    command,
    args = [],
    env = {},
    cwd,
    clock = systemClock(),
    logger = {},
    minimumVersion,
    handshakeTimeoutMs = 30_000,
    callTimeoutMs = 60_000,
    backoff = {},
    spawnFn,
  } = options;

  if (typeof command !== 'string' || !command.trim()) {
    throw new TypeError('createDriverClient requires a "command" string.');
  }

  const {
    initialMs = 250,
    maxMs = 5_000,
    factor = 2,
    maxAttempts = 5,
  } = backoff || {};

  const log = {
    warn: typeof logger.warn === 'function' ? (message) => logger.warn(message) : () => {},
    debug: typeof logger.debug === 'function' ? (message) => logger.debug(message) : () => {},
  };

  const listeners = new Set();
  let status = 'idle';
  let lastError = null;
  let driverVersion = null;
  const tools = new Map();
  let restartAttempts = 0;
  let current = null;
  let nextId = 1;
  let startPromise = null;
  let backoffHandle = null;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    for (const listener of [...listeners]) {
      try { listener(next); } catch (cause) { log.warn(`Cua Driver status listener failed: ${cause.message}`); }
    }
  }

  function cancelBackoff() {
    if (backoffHandle === null) return;
    clock.clearTimeout(backoffHandle);
    backoffHandle = null;
  }

  function rejectPending(state, reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const [id, item] of state.pending) {
      clock.clearTimeout(item.timer);
      state.pending.delete(id);
      item.reject(error);
    }
  }

  function handleMessage(state, message) {
    if (!message || typeof message !== 'object') {
      log.warn('Ignoring a non-object Cua Driver MCP message.');
      return;
    }
    const item = state.pending.get(message.id);
    if (!item) {
      log.debug(`Ignoring an unmatched Cua Driver MCP message (id ${message.id}).`);
      return;
    }
    state.pending.delete(message.id);
    clock.clearTimeout(item.timer);
    if (message.error) {
      item.reject(new Error(message.error.message || 'Cua Driver MCP error'));
      return;
    }
    item.resolve(message.result);
  }

  function onStdout(state, chunk) {
    state.buffer += chunk;
    for (;;) {
      const index = state.buffer.indexOf('\n');
      if (index < 0) break;
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (cause) { log.warn(`Invalid Cua Driver MCP response: ${cause.message}`); continue; }
      handleMessage(state, message);
    }
  }

  function onChildError(state, cause) {
    const hint = cause.code === 'ENOENT'
      ? 'The Cua Driver is not installed or not on PATH; install it and set the executable path.'
      : 'Check the configured executable path and OS permissions.';
    const message = `Cua Driver could not start (${cause.message}). ${hint}`;
    log.warn(message);
    if (!state.alive) return;
    state.alive = false;
    rejectPending(state, message);
    if (state !== current) return;
    lastError = new Error(message);
    setStatus('failed');
    scheduleRestart();
  }

  function onChildExit(state, code, signal) {
    if (!state.alive) return;
    state.alive = false;
    const message = `Cua Driver exited (${code ?? signal ?? 'unknown'}).`;
    rejectPending(state, message);
    if (state !== current) return;
    if (state.intentional) {
      setStatus('stopped');
      return;
    }
    log.warn(`Cua Driver exited unexpectedly: ${message}`);
    lastError = new Error(message);
    setStatus('failed');
    scheduleRestart();
  }

  function scheduleRestart() {
    if (restartAttempts >= maxAttempts) {
      log.warn('Cua Driver restart budget exhausted; an explicit start or restart is required.');
      return;
    }
    const delay = Math.min(maxMs, Math.round(initialMs * (factor ** restartAttempts)));
    restartAttempts += 1;
    log.debug(`Cua Driver auto-restart scheduled in ${delay}ms (attempt ${restartAttempts}/${maxAttempts}).`);
    backoffHandle = clock.setTimeout(() => {
      backoffHandle = null;
      return ensureStarted().catch((cause) => {
        log.warn(`Cua Driver auto-restart failed: ${cause.message}`);
      });
    }, delay);
  }

  function waitForClose(state) {
    if (state.closePromise) return state.closePromise;
    state.closePromise = new Promise((resolve) => {
      const { child } = state;
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const kill = clock.setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (cause) { log.debug(`Cua Driver kill failed: ${cause.message}`); }
      }, 750);
      const giveUp = clock.setTimeout(() => resolve(), 2_000);
      child.once('close', () => {
        clock.clearTimeout(kill);
        clock.clearTimeout(giveUp);
        resolve();
      });
    });
    return state.closePromise;
  }

  async function teardownState(state, reason) {
    if (current === state) current = null;
    if (!state.alive) return;
    state.alive = false;
    state.intentional = true;
    rejectPending(state, reason);
    try { state.child.stdin?.end(); } catch (cause) { log.debug(`Cua Driver stdin close failed: ${cause.message}`); }
    try { state.child.kill('SIGTERM'); } catch (cause) { log.debug(`Cua Driver kill failed: ${cause.message}`); }
    await waitForClose(state);
  }

  function spawnDriver() {
    const spawnImpl = typeof spawnFn === 'function' ? spawnFn : spawn;
    const child = spawnImpl(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const state = {
      child,
      alive: true,
      intentional: false,
      initialized: null,
      pending: new Map(),
      buffer: '',
      closePromise: null,
    };
    current = state;
    child.on('error', (cause) => onChildError(state, cause));
    child.on('exit', (code, signal) => onChildExit(state, code, signal));
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => onStdout(state, chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => log.debug(`Cua Driver stderr: ${String(chunk).trimEnd()}`));
    }
    return state;
  }

  function send(state, method, params = {}, timeoutMs = callTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (!state.alive) {
        reject(new Error('Cua Driver is not running.'));
        return;
      }
      const id = nextId;
      nextId += 1;
      const timer = clock.setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`Cua Driver ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      try {
        state.child.stdin.write(payload, (cause) => {
          if (!cause) return;
          const item = state.pending.get(id);
          if (!item) return;
          state.pending.delete(id);
          clock.clearTimeout(item.timer);
          item.reject(new Error(`Cua Driver ${method} failed: ${cause.message}`));
        });
      } catch (cause) {
        state.pending.delete(id);
        clock.clearTimeout(timer);
        reject(new Error(`Cua Driver ${method} failed: ${cause.message}`));
      }
    });
  }

  function notify(state, method, params) {
    if (!state.alive) return;
    try {
      state.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch (cause) {
      log.warn(`Could not send ${method} to the Cua Driver: ${cause.message}`);
    }
  }

  async function doStart() {
    const state = spawnDriver();
    setStatus('starting');
    try {
      const initialized = await send(state, 'initialize', INITIALIZE_PARAMS, handshakeTimeoutMs);
      const reported = initialized?.serverInfo?.version ?? null;
      if (minimumVersion) {
        if (!reported) {
          log.warn('The Cua Driver did not report a version; the minimum version cannot be verified.');
        } else if (compareVersions(reported, minimumVersion) < 0) {
          throw new Error(`Cua Driver ${reported} is older than the required minimum ${minimumVersion}.`);
        }
      }
      driverVersion = reported;
      notify(state, 'notifications/initialized', {});
      const catalog = await send(state, 'tools/list', {}, handshakeTimeoutMs);
      tools.clear();
      for (const tool of catalog?.tools ?? []) {
        if (!tool || typeof tool.name !== 'string') continue;
        tools.set(tool.name, {
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? {},
        });
      }
      state.initialized = initialized;
      restartAttempts = 0;
      lastError = null;
      setStatus('ready');
      return initialized;
    } catch (cause) {
      lastError = cause instanceof Error ? cause : new Error(String(cause));
      setStatus('failed');
      await teardownState(state, 'Cua Driver startup failed.');
      throw lastError;
    }
  }

  function ensureStarted() {
    if (status === 'ready' && current && current.alive) {
      return Promise.resolve(current.initialized);
    }
    if (startPromise) return startPromise;
    const promise = (async () => {
      cancelBackoff();
      const stale = current;
      if (stale) await teardownState(stale, 'Cua Driver session replaced.');
      return doStart();
    })();
    startPromise = promise;
    const clear = () => { if (startPromise === promise) startPromise = null; };
    promise.then(clear, clear);
    return promise;
  }

  async function call(method, params = {}, callOptions = {}) {
    await ensureStarted();
    const state = current;
    if (!state || !state.alive) throw new Error('Cua Driver is not running.');
    const timeoutMs = typeof callOptions?.timeoutMs === 'number' ? callOptions.timeoutMs : callTimeoutMs;
    return send(state, method, params, timeoutMs);
  }

  async function restart() {
    cancelBackoff();
    const inFlight = startPromise;
    startPromise = null;
    const stale = current;
    if (stale) await teardownState(stale, 'Cua Driver session restarted.');
    if (inFlight) { try { await inFlight; } catch { /* the replaced session already failed */ } }
    return ensureStarted();
  }

  async function stop() {
    cancelBackoff();
    const state = current;
    current = null;
    if (state) await teardownState(state, 'Cua Driver was stopped.');
    setStatus('stopped');
  }

  async function health() {
    const state = current;
    if (!state || !state.alive) return false;
    try {
      await send(state, 'ping', {}, Math.min(callTimeoutMs, 5_000));
      return true;
    } catch {
      return false;
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribe expects a function.');
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return {
    get status() { return status; },
    get lastError() { return lastError; },
    get driverVersion() { return driverVersion; },
    get tools() { return tools; },
    get restartAttempts() { return restartAttempts; },
    start: ensureStarted,
    call,
    restart,
    stop,
    health,
    subscribe,
  };
}

module.exports = { createDriverClient, compareVersions };
