// Vendored dependency-free managed Chromium CDP transport from
// plugins/browser/managed-browser.cjs (marketplace commit 4751d02).
// Keep this copy local so Conductor Canvas remains independently installable.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const PROFILE_DIR_NAME = 'managed-chromium-profile';

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(explicitPath) {
  if (typeof explicitPath === 'string' && explicitPath.trim()) {
    const configured = path.resolve(explicitPath.trim());
    return isExecutable(configured) ? configured : null;
  }
  const candidates = [];
  for (const key of ['DUYA_BROWSER_EXECUTABLE', 'CHROME_BIN', 'CHROMIUM_PATH', 'GOOGLE_CHROME_BIN']) {
    if (typeof process.env[key] === 'string' && process.env[key].trim()) candidates.push(process.env[key].trim());
  }

  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge']) {
      for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        if (directory) candidates.push(path.join(directory, name));
      }
    }
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }

  return candidates.find(isExecutable) ?? null;
}

function prepareProfileDirectory(dataPath) {
  if (typeof dataPath !== 'string' || dataPath.trim().length === 0) {
    throw new TypeError('Managed Chromium requires a plugin dataPath.');
  }
  const requestedRoot = path.resolve(dataPath);
  if (requestedRoot === path.parse(requestedRoot).root) {
    throw new Error('Managed Chromium dataPath cannot be a filesystem root.');
  }
  fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(requestedRoot);
  const profilePath = path.join(root, PROFILE_DIR_NAME);
  try {
    const stat = fs.lstatSync(profilePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Managed Chromium profile path must be a real directory owned by the plugin.');
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    fs.mkdirSync(profilePath, { recursive: false, mode: 0o700 });
  }
  const realProfilePath = fs.realpathSync(profilePath);
  if (path.dirname(realProfilePath) !== root) {
    throw new Error('Managed Chromium profile escaped the plugin data directory.');
  }
  return realProfilePath;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createManagedBrowser(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Managed Chromium options must be an object.');
  }
  const profilePath = prepareProfileDirectory(options.dataPath);
  const configuredArgs = Array.isArray(options.args)
    ? options.args.filter((value) => typeof value === 'string')
    : [];
  const protectedArgs = configuredArgs.filter((value) =>
    /^--(?:remote-debugging-(?:pipe|port|address)|user-data-dir)(?:=|$)/i.test(value),
  );
  if (protectedArgs.length > 0) {
    throw new Error(`Managed Chromium does not allow overriding its profile or CDP pipe arguments: ${protectedArgs.join(', ')}.`);
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 120_000)
    : DEFAULT_TIMEOUT_MS;

  let child = null;
  let launchPromise = null;
  let nextCommandId = 0;
  let pipeBuffer = Buffer.alloc(0);
  let stderrTail = '';
  let closed = false;
  const pending = new Map();
  const tabs = new Map();
  const tabInitializations = new Map();

  function rejectAllPending(error) {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      item.reject(error);
      pending.delete(id);
    }
  }

  function resetAfterExit(processRef, code, signal) {
    if (child !== processRef) return;
    child = null;
    launchPromise = null;
    pipeBuffer = Buffer.alloc(0);
    const detail = signal ? `signal ${signal}` : `exit code ${code}`;
    const tail = stderrTail.trim();
    const error = new Error(`Managed Chromium exited (${detail}).${tail ? ` ${tail}` : ''}`);
    rejectAllPending(error);
    for (const tab of tabs.values()) {
      tab.sessionId = null;
      tab.targetId = null;
      tab.pendingLoad = false;
      tab.lastLoadError = error;
      for (const waiter of tab.loadWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      tab.loadWaiters.clear();
    }
  }

  function deliverMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (message && Number.isInteger(message.id)) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) {
        const error = new Error(message.error.message || `Chromium CDP command ${item.method} failed.`);
        error.code = message.error.code;
        error.data = message.error.data;
        item.reject(error);
      } else {
        item.resolve(message.result ?? {});
      }
      return;
    }

    if (message?.method === 'Page.loadEventFired') {
      const tab = [...tabs.values()].find((candidate) => candidate.sessionId === message.sessionId);
      if (!tab) return;
      tab.pendingLoad = false;
      tab.lastLoadError = null;
      for (const waiter of tab.loadWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve({ loaded: true });
      }
      tab.loadWaiters.clear();
    }
  }

  function handlePipeData(chunk) {
    pipeBuffer = Buffer.concat([pipeBuffer, Buffer.from(chunk)]);
    if (pipeBuffer.length > MAX_MESSAGE_BYTES && !pipeBuffer.includes(0)) {
      const error = new Error('Managed Chromium sent an oversized CDP message.');
      child?.kill();
      rejectAllPending(error);
      pipeBuffer = Buffer.alloc(0);
      return;
    }
    let separator;
    while ((separator = pipeBuffer.indexOf(0)) !== -1) {
      const message = pipeBuffer.subarray(0, separator);
      pipeBuffer = pipeBuffer.subarray(separator + 1);
      if (message.length <= MAX_MESSAGE_BYTES) deliverMessage(message);
    }
  }

  function rawCommand(method, params = {}, sessionId) {
    if (!child || child.exitCode !== null || child.killed) {
      return Promise.reject(new Error('Managed Chromium is not running.'));
    }
    const id = ++nextCommandId;
    const command = { id, method, params };
    if (sessionId) command.sessionId = sessionId;
    // Chromium reads commands from child fd 3 and writes responses/events to fd 4.
    const output = child.stdio[3];
    if (!output || output.destroyed || output.writableEnded) {
      return Promise.reject(new Error('Managed Chromium CDP pipe is closed.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Managed Chromium CDP command ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      output.write(`${JSON.stringify(command)}\0`, (error) => {
        if (!error) return;
        const item = pending.get(id);
        if (!item) return;
        pending.delete(id);
        clearTimeout(item.timer);
        reject(error);
      });
    });
  }

  async function ensureProcess() {
    if (closed) throw new Error('Managed Chromium backend is closed.');
    if (child && child.exitCode === null && !child.killed) return;
    if (launchPromise) return launchPromise;
    const executablePath = findExecutable(options.executablePath);
    if (!executablePath) {
      throw new Error('Chrome or Chromium was not found. Set executablePath or CHROME_BIN to a browser executable.');
    }
    const args = [
      '--remote-debugging-pipe',
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      ...configuredArgs,
      'about:blank',
    ];

    launchPromise = new Promise((resolve, reject) => {
      let processRef;
      try {
        processRef = spawn(executablePath, args, {
          stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: process.env,
        });
      } catch (error) {
        launchPromise = null;
        reject(new Error(`Could not launch managed Chromium: ${error.message}`));
        return;
      }
      child = processRef;
      stderrTail = '';
      processRef.stderr?.on('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4000);
      });
      // Keep the descriptor directions explicit; both Node Socket wrappers are duplex.
      processRef.stdio[4]?.on('data', handlePipeData);
      processRef.stdio[3]?.on('error', (error) => rejectAllPending(error));
      processRef.stdio[4]?.on('error', (error) => rejectAllPending(error));
      processRef.once('error', (error) => {
        resetAfterExit(processRef, null, null);
        reject(new Error(`Could not launch managed Chromium: ${error.message}`));
      });
      processRef.once('exit', (code, signal) => {
        resetAfterExit(processRef, code, signal);
      });
      processRef.once('spawn', () => resolve());
    });
    return launchPromise;
  }

  async function browserCommand(method, params) {
    await ensureProcess();
    return rawCommand(method, params);
  }

  async function ensureTab(tabId) {
    if (typeof tabId !== 'string' || tabId.length === 0 || tabId.length > 256) {
      throw new TypeError('Managed Chromium tabId must be a non-empty string up to 256 characters.');
    }
    await ensureProcess();
    const existing = tabs.get(tabId);
    if (existing?.sessionId && existing.targetId) return existing;
    const pendingInitialization = tabInitializations.get(tabId);
    if (pendingInitialization) return pendingInitialization;
    const initialization = (async () => {
      let targetId;
      if (tabId === 'tab_0') {
        const result = await rawCommand('Target.getTargets');
        const pageTarget = result.targetInfos?.find((target) => target.type === 'page' && target.url === 'about:blank');
        targetId = pageTarget?.targetId;
      }
      if (!targetId) {
        const result = await rawCommand('Target.createTarget', { url: 'about:blank' });
        targetId = result.targetId;
      }
      if (typeof targetId !== 'string' || targetId.length === 0) {
        throw new Error(`Managed Chromium did not create a page target for tab ${tabId}.`);
      }
      const attached = await rawCommand('Target.attachToTarget', { targetId, flatten: true });
      if (typeof attached.sessionId !== 'string' || attached.sessionId.length === 0) {
        throw new Error(`Managed Chromium did not attach a CDP session for tab ${tabId}.`);
      }
      const tab = existing ?? { targetId: null, sessionId: null, pendingLoad: false, lastLoadError: null, loadWaiters: new Set() };
      tab.targetId = targetId;
      tab.sessionId = attached.sessionId;
      tab.pendingLoad = false;
      tab.lastLoadError = null;
      tabs.set(tabId, tab);
      return tab;
    })();
    tabInitializations.set(tabId, initialization);
    try {
      return await initialization;
    } finally {
      if (tabInitializations.get(tabId) === initialization) tabInitializations.delete(tabId);
    }
  }

  async function send(method, params = {}, tabId = 'tab_0') {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]+$/.test(method)) {
      throw new TypeError('Managed Chromium CDP method is invalid.');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new TypeError('Managed Chromium CDP params must be an object.');
    }
    const tab = await ensureTab(String(tabId));
    if (method === 'Page.navigate') {
      tab.pendingLoad = true;
      tab.lastLoadError = null;
    }
    let result;
    try {
      result = await rawCommand(method, params, tab.sessionId);
    } catch (error) {
      if (method === 'Page.navigate') {
        tab.pendingLoad = false;
        tab.lastLoadError = error;
      }
      throw error;
    }
    if (method === 'Page.navigate' && typeof result.errorText === 'string' && result.errorText.length > 0) {
      tab.pendingLoad = false;
      tab.lastLoadError = new Error(result.errorText);
      throw tab.lastLoadError;
    }
    return result;
  }

  async function closeTab(tabId) {
    const key = String(tabId);
    const initialization = tabInitializations.get(key);
    if (initialization) await initialization.catch(() => {});
    const tab = tabs.get(key);
    if (!tab) return { closed: false, tabId: key };
    let result = { success: true };
    if (child && child.exitCode === null && !child.killed && tab.targetId) {
      result = await rawCommand('Target.closeTarget', { targetId: tab.targetId });
    }
    tabs.delete(key);
    const error = new Error(`Managed Chromium tab ${key} was closed.`);
    for (const waiter of tab.loadWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    tab.loadWaiters.clear();
    return { ...result, tabId: key };
  }

  async function waitForLoad(tabId, waitTimeoutMs = timeoutMs) {
    const tab = tabs.get(String(tabId));
    if (!tab) throw new Error(`Managed Chromium tab ${String(tabId)} has not been opened.`);
    if (tab.lastLoadError) {
      const error = tab.lastLoadError;
      tab.lastLoadError = null;
      throw error;
    }
    if (!tab.pendingLoad) return { loaded: true };
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) {
      throw new TypeError('Managed Chromium waitForLoad timeout must be a positive number.');
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          tab.loadWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for managed Chromium tab ${String(tabId)} to load after ${waitTimeoutMs}ms.`));
        }, Math.min(waitTimeoutMs, 120_000)),
      };
      tab.loadWaiters.add(waiter);
    });
  }

  async function health() {
    const executablePath = findExecutable(options.executablePath);
    const running = Boolean(child && child.exitCode === null && !child.killed);
    return {
      ok: Boolean(executablePath),
      running,
      executablePath: executablePath ?? undefined,
      openTabs: tabs.size,
      ...(executablePath ? {} : { error: 'Chrome or Chromium was not found.' }),
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    const processRef = child;
    if (!processRef || processRef.exitCode !== null || processRef.killed) return;
    try {
      await Promise.race([rawCommand('Browser.close'), delay(750)]);
    } catch {
      // The browser may close its pipe before replying to Browser.close.
    }
    if (processRef.exitCode !== null) return;
    const exited = new Promise((resolve) => processRef.once('exit', resolve));
    await Promise.race([exited, delay(1500)]);
    if (processRef.exitCode === null) processRef.kill('SIGTERM');
    if (processRef.exitCode === null) await Promise.race([exited, delay(1500)]);
    if (processRef.exitCode === null) processRef.kill('SIGKILL');
    rejectAllPending(new Error('Managed Chromium backend closed.'));
    tabs.clear();
  }

  return Object.freeze({ send, closeTab, waitForLoad, health, close });
}

module.exports = { createManagedBrowser };
