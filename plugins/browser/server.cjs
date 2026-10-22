#!/usr/bin/env node
'use strict';

// A dependency-free stdio MCP server. Both managed Chromium and Chrome/Edge
// control are owned by this plugin process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const repl = require('node:repl');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { createBridgeService } = require('./bridge-service.cjs');
const { createManagedBrowser } = require('./managed-browser.cjs');

const bridgeService = createBridgeService();
const bridgeReady = bridgeService.start();
bridgeReady.catch((error) => process.stderr.write(`Browser plugin service failed to start: ${error.message}\n`));
const sessionId = `cua_${process.pid}_${randomUUID()}`;
const managedDataRoot = process.env.DUYA_PLUGIN_DATA
  ? path.join(process.env.DUYA_PLUGIN_DATA, 'managed-browser')
  : path.join(os.homedir(), '.duya', 'plugins', 'browser');
const managedBrowser = createManagedBrowser({ dataPath: managedDataRoot });
const requestTimeoutMs = 35_000;
const maxOutputChars = 60_000;
let requestId = 0;
let docsRead = false;
let stateRead = false;
let initializationStage = 0;
let currentJsCall = 0;
let stateReadCall = -1;
let replServer;
let activeTarget = 'Managed Chromium';
let selectedSystemTab = null;
let managedTabs = new Map([['tab_0', { url: 'about:blank', title: '' }]]);
let activeManagedTab = 'tab_0';
let managedTabCounter = 0;
const nodeModuleDirs = [];

const API_DOCS = `Browser CUA API v1\n\nInitialization:\n1. The first js call after startup/reset must contain only await cua.getApiDocs(). Read its returned documentation before continuing.\n2. The next js call must contain only await cua.getState(). Inspect the returned target and page state before continuing.\n3. After switching targets or changing the active tab, use a separate js call with await cua.getState() and inspect its result before acting on that page.\n4. Only then navigate, click, type, or run other page actions. Reading state and performing browser actions in the same js call is rejected.\n\nTargets:\n- Managed Chromium: a private Chromium profile and page session owned by this Browser plugin. It runs independently of DUYA's in-app browser.\n- Chrome or Edge: the Browser Bridge extension connected to the plugin's local browser service. Its available HTTP(S) tabs can be selected by tab ID or exact URL and attached to this CUA session.\n\nMethods:\n- await cua.getApiDocs()\n- await cua.getState()\n- await cua.browser.targets()\n- await cua.browser.selectTarget({ browser: 'Managed Chromium' | 'Chrome' | 'Edge', tabId?: string | number, url?: string })\n- await cua.browser.tabs()\n- await cua.browser.newTab(url?)\n- await cua.browser.closeTab(tabId?)\n- await cua.browser.navigate(url)\n- await cua.browser.snapshot()\n- await cua.browser.click(selector)\n- await cua.browser.type(selector, text)\n- await cua.browser.pressKey(key)\n- await cua.browser.scroll({ direction?: 'up'|'down'|'left'|'right', amount?: number })\n- await cua.browser.screenshot()\n- await cua.browser.goBack()\n\nThe JavaScript REPL is persistent. js_reset clears its JavaScript bindings and repeats this initialization sequence; it does not close tabs or reset browser state.\n`;

function jsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function pluginBridgeJson(route, body, timeoutMs = requestTimeoutMs) {
  const port = await bridgeReady;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-DUYA-BROWSER': bridgeService.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Browser plugin service returned invalid JSON (${response.status})`); }
    if (!response.ok) throw new Error(data.error || `Browser plugin service returned HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function managedTabId() {
  return activeManagedTab;
}

async function managedCdp(method, params = {}, tabId = activeManagedTab) {
  return managedBrowser.send(method, params, String(tabId));
}

async function extensionCommand(command, timeoutMs = requestTimeoutMs) {
  const data = await pluginBridgeJson('/command', {
    id: `cua_${process.pid}_${Date.now()}_${++requestId}`,
    sessionId,
    ...command,
    ...(command.tabId !== undefined || selectedSystemTab === null ? {} : { tabId: selectedSystemTab }),
  }, timeoutMs);
  if (data.error || data.ok === false) throw new Error(data.error || 'Browser Bridge command failed');
  return data.data ?? data;
}

function assertInitialized() {
  if (!docsRead) throw new Error('Initialization required: first call await cua.getApiDocs().');
  if (!stateRead) throw new Error('Initialization required: call await cua.getState() and inspect the current browser state before acting.');
  if (stateReadCall >= currentJsCall) throw new Error('Initialization required: read and inspect the browser state in a separate js call before acting.');
}

async function targetTabs() {
  if (activeTarget === 'Managed Chromium') {
    const result = [];
    for (const [id, state] of managedTabs) {
      let current = state;
      if (id === activeManagedTab) {
        try {
          const details = await managedCdp('Runtime.evaluate', {
            expression: '({url: location.href, title: document.title})',
            returnByValue: true,
            awaitPromise: true,
          });
          current = { url: details?.result?.value?.url ?? state.url, title: details?.result?.value?.title ?? state.title };
          managedTabs.set(id, current);
        } catch {
          // Return known local state if a page is still starting up.
        }
      }
      result.push({ id, ...current, active: id === activeManagedTab });
    }
    return result;
  }
  const data = await extensionCommand({ action: 'tabs', op: 'list' });
  return Array.isArray(data) ? data : [];
}

async function availableSystemTabs() {
  const data = await extensionCommand({ action: 'tabs', op: 'available' });
  return Array.isArray(data) ? data : [];
}

async function selectTarget(input = {}) {
  const previousTarget = activeTarget;
  const previousSystemTab = selectedSystemTab;
  const previousManagedTab = activeManagedTab;
  const browser = typeof input.browser === 'string' ? input.browser.trim().toLowerCase() : '';
  if (browser) {
    if (browser === 'managed chromium' || browser === 'managed-chromium' || browser === 'duya' || browser === 'iab' || browser === 'in-app') activeTarget = 'Managed Chromium';
    else if (browser === 'chrome' || browser === 'edge' || browser === 'system') activeTarget = browser === 'edge' ? 'Edge' : 'Chrome';
    else throw new Error(`Unsupported browser target: ${input.browser}`);
  }

  const tabs = activeTarget === 'Managed Chromium' ? await targetTabs() : await availableSystemTabs();
  let match;
  if (input.tabId !== undefined) match = tabs.find((tab) => String(tab.id) === String(input.tabId));
  if (!match && typeof input.url === 'string') match = tabs.find((tab) => tab.url === input.url);
  if (!match && (input.tabId !== undefined || typeof input.url === 'string')) {
    throw new Error(`No ${activeTarget} browser tab matches ${input.tabId !== undefined ? `tabId ${input.tabId}` : `URL ${input.url}`}.`);
  }
  if (!match && tabs.length) match = tabs.find((tab) => tab.active) ?? tabs[0];

  if (activeTarget !== 'Managed Chromium') {
    if (input.tabId !== undefined && !match) throw new Error(`No available system-browser tab matches tabId ${input.tabId}.`);
    if (typeof input.url === 'string' && !match) throw new Error(`No available system-browser tab matches URL ${input.url}.`);
    if (!match) {
      const health = await pluginBridgeJson('/ping');
      if (!health.extensionConnected) throw new Error('No Chrome/Edge Browser Bridge extension is connected.');
      const created = await extensionCommand({ action: 'tabs', op: 'new', ...(input.url ? { url: input.url } : {}) });
      selectedSystemTab = created.tabId ?? null;
      match = { id: selectedSystemTab, url: created.url ?? input.url ?? 'about:blank', title: created.title ?? '' };
    } else {
      selectedSystemTab = Number.isFinite(Number(match.id)) ? Number(match.id) : match.id;
      await extensionCommand({ action: 'tabs', op: 'attach', tabId: selectedSystemTab });
      await extensionCommand({ action: 'tabs', op: 'select', tabId: selectedSystemTab });
    }
    if (previousTarget !== activeTarget || String(previousSystemTab) !== String(selectedSystemTab)) stateRead = false;
    return { browser: activeTarget, ...match };
  }

  if (!match && input.url) {
    await navigate(String(input.url));
    const state = managedTabs.get(activeManagedTab) ?? {};
    match = { id: activeManagedTab, ...state };
  }
  if (match) activeManagedTab = String(match.id);
  if (previousTarget !== activeTarget || previousManagedTab !== activeManagedTab) stateRead = false;
  return { browser: activeTarget, ...(match ?? { id: activeManagedTab, ...(managedTabs.get(activeManagedTab) ?? {}) }) };
}

async function navigate(url) {
  assertInitialized();
  if (typeof url !== 'string' || !url.trim()) throw new Error('navigate(url) requires a non-empty URL.');
  if (activeTarget !== 'Managed Chromium') {
    const result = await extensionCommand({ action: 'navigate', url });
    if (result.tabId !== undefined) selectedSystemTab = result.tabId;
    return result;
  }
  await managedCdp('Page.enable');
  await managedCdp('Page.navigate', { url });
  managedTabs.set(activeManagedTab, { url, title: '' });
  await managedBrowser.waitForLoad(managedTabId(), 10_000).catch(() => null);
  return await snapshot();
}

async function newTab(url) {
  assertInitialized();
  if (activeTarget !== 'Managed Chromium') {
    const result = await extensionCommand({ action: 'tabs', op: 'new', ...(url ? { url } : {}) });
    selectedSystemTab = result.tabId ?? null;
    stateRead = false;
    return result;
  }
  const tabId = `tab_${++managedTabCounter}`;
  managedTabs.set(tabId, { url: url ?? 'about:blank', title: '' });
  activeManagedTab = tabId;
  stateRead = false;
  await managedCdp('Page.enable', {}, tabId);
  if (url) {
    await managedCdp('Page.navigate', { url }, tabId);
    managedTabs.set(tabId, { url, title: '' });
    await managedBrowser.waitForLoad(tabId, 10_000).catch(() => null);
  }
  return { id: tabId, url: url ?? 'about:blank' };
}

async function closeTab(target) {
  assertInitialized();
  if (activeTarget !== 'Managed Chromium') {
    const tabId = target ?? selectedSystemTab;
    if (tabId === null || tabId === undefined) throw new Error('No selected system-browser tab to close.');
    const result = await extensionCommand({ action: 'tabs', op: 'close', tabId });
    const remaining = await targetTabs();
    selectedSystemTab = remaining.find((tab) => tab.active)?.id ?? remaining[0]?.id ?? null;
    stateRead = false;
    return result;
  }
  const tabId = target === undefined ? activeManagedTab : String(target);
  if (!managedTabs.has(tabId)) throw new Error(`No Managed Chromium tab matches ${tabId}.`);
  await managedBrowser.closeTab(tabId);
  managedTabs.delete(tabId);
  if (managedTabs.size === 0) managedTabs = new Map([['tab_0', { url: 'about:blank', title: '' }]]);
  activeManagedTab = managedTabs.keys().next().value ?? 'tab_0';
  stateRead = false;
  return { closed: tabId, active: activeManagedTab };
}

async function snapshot(internalStateRead = false) {
  if (!internalStateRead) assertInitialized();
  const expression = `(() => ({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 30000), elements: Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button]')).filter(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; }).slice(0,200).map(e => ({tag:e.tagName.toLowerCase(), role:e.getAttribute('role'), text:(e.innerText||e.getAttribute('aria-label')||e.value||'').trim().slice(0,300), href:e.href||undefined, type:e.type||undefined, placeholder:e.placeholder||undefined})) }))()`;
  if (activeTarget !== 'Managed Chromium') return await extensionCommand({ action: 'evaluate', script: expression });
  const result = await managedCdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result?.result?.value ?? null;
}

async function click(selector) {
  assertInitialized();
  if (typeof selector !== 'string' || !selector) throw new Error('click(selector) requires a CSS selector.');
  if (activeTarget !== 'Managed Chromium') return extensionCommand({ action: 'click', selector });
  const expression = `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Element not found: '+${JSON.stringify(selector)}); e.click(); return {clicked:${JSON.stringify(selector)}}; })()`;
  const result = await managedCdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result?.result?.value;
}

async function type(selector, text) {
  assertInitialized();
  if (typeof selector !== 'string' || !selector) throw new Error('type(selector, text) requires a CSS selector.');
  if (activeTarget !== 'Managed Chromium') return extensionCommand({ action: 'type', selector, text: String(text) });
  const expression = `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Element not found: '+${JSON.stringify(selector)}); e.focus(); e.value=${JSON.stringify(String(text))}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return {typed:${JSON.stringify(selector)}}; })()`;
  const result = await managedCdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result?.result?.value;
}

async function pressKey(key) {
  assertInitialized();
  if (activeTarget !== 'Managed Chromium') return extensionCommand({ action: 'press_key', key });
  const keyName = String(key);
  await managedCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName });
  await managedCdp('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName });
  return { pressed: keyName };
}

async function scroll({ direction = 'down', amount = 300 } = {}) {
  assertInitialized();
  const delta = Math.max(-5000, Math.min(5000, Number(amount) || 300));
  if (activeTarget !== 'Managed Chromium') return extensionCommand({ action: 'scroll', direction, amount: delta });
  const directions = { up: [0, -delta], down: [0, delta], left: [-delta, 0], right: [delta, 0] };
  const [deltaX, deltaY] = directions[direction] ?? directions.down;
  await managedCdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY });
  return { direction, amount: delta };
}

async function screenshot() {
  assertInitialized();
  if (activeTarget !== 'Managed Chromium') {
    const result = await extensionCommand({ action: 'screenshot' });
    const data = typeof result === 'string' ? result : result?.data;
    const base64 = typeof data === 'string' ? data : data?.data;
    return base64 ? `data:image/png;base64,${base64}` : null;
  }
  const result = await managedCdp('Page.captureScreenshot', { format: 'png' });
  return result?.data ? `data:image/png;base64,${result.data}` : null;
}

async function goBack() {
  assertInitialized();
  if (activeTarget !== 'Managed Chromium') return extensionCommand({ action: 'go_back' });
  const history = await managedCdp('Page.getNavigationHistory');
  const current = history?.currentIndex ?? 0;
  if (current > 0) await managedCdp('Page.navigateToHistoryEntry', { entryId: history.entries[current - 1].id });
  return await snapshot();
}

const cua = {
  async getApiDocs() {
    docsRead = true;
    return API_DOCS;
  },
  async getState() {
    if (!docsRead) throw new Error('Call await cua.getApiDocs() first.');
    const tabs = await targetTabs();
    const health = activeTarget === 'Managed Chromium' ? await managedBrowser.health() : await pluginBridgeJson('/ping');
    try {
      const page = await snapshot(true);
      stateRead = true;
      stateReadCall = currentJsCall;
      return {
        target: activeTarget,
        ...(activeTarget === 'Managed Chromium'
          ? { managedBrowser: { available: health.ok, running: health.running, openTabs: health.openTabs } }
          : { extensionConnected: health.extensionConnected === true }),
        tabs,
        page,
      };
    } catch (err) {
      stateRead = false;
      throw err;
    }
  },
  browser: {
    async targets() {
      const [managed, bridge] = await Promise.all([
        managedBrowser.health(),
        pluginBridgeJson('/ping').catch(() => ({ extensionConnected: false })),
      ]);
      return [
        { browser: 'Managed Chromium', available: managed.ok === true, kind: 'plugin-managed Chromium process' },
        { browser: 'Chrome', available: bridge.extensionConnected === true, kind: 'Browser Bridge session' },
        { browser: 'Edge', available: bridge.extensionConnected === true, kind: 'Browser Bridge session' },
      ];
    },
    async selectTarget(input) { assertInitialized(); return selectTarget(input); },
    async tabs() { assertInitialized(); return targetTabs(); },
    newTab,
    closeTab,
    navigate,
    snapshot,
    click,
    type,
    pressKey,
    scroll,
    screenshot,
    goBack,
  },
};

function makeRequire() {
  const requires = nodeModuleDirs.map((dir) => createRequire(path.join(dir, '__duya_cua_repl__.cjs')));
  const baseRequire = createRequire(__filename);
  return (specifier) => {
    let lastError;
    for (const requireFromDir of requires) {
      try { return requireFromDir(specifier); } catch (err) { lastError = err; }
    }
    try { return baseRequire(specifier); } catch (err) { throw lastError ?? err; }
  };
}

function createRepl() {
  const input = new PassThrough();
  const output = new PassThrough();
  replServer = repl.start({ prompt: '', input, output, terminal: false, useGlobal: false, ignoreUndefined: true });
  replServer.context.cua = cua;
  replServer.context.require = makeRequire();
  replServer.context.console = {
    log: (...args) => { replServer.__logs.push(args.map(formatValue).join(' ')); },
    info: (...args) => { replServer.__logs.push(args.map(formatValue).join(' ')); },
    warn: (...args) => { replServer.__logs.push(args.map(formatValue).join(' ')); },
    error: (...args) => { replServer.__logs.push(args.map(formatValue).join(' ')); },
  };
  replServer.__logs = [];
  replServer.__busy = false;
}

function formatValue(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function serializable(value) {
  if (value === undefined) return '(undefined)';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function executeJs({ code, timeout_ms, title }) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('Parameter "code" must be a non-empty string.');
  const normalizedCode = code.trim().replace(/;$/, '').trim();
  if (initializationStage === 0 && normalizedCode !== 'await cua.getApiDocs()') {
    throw new Error('Initialization required: the first js call must contain only await cua.getApiDocs().');
  }
  if (initializationStage === 1 && normalizedCode !== 'await cua.getState()') {
    throw new Error('Initialization required: the second js call must contain only await cua.getState().');
  }
  const readsState = /\bcua\s*\.\s*getState\s*\(/.test(code);
  const performsBrowserAction = /\bcua\s*\.\s*browser\s*\.\s*(?:selectTarget|newTab|closeTab|navigate|click|type|pressKey|scroll|screenshot|goBack)\s*\(/.test(code);
  if (readsState && normalizedCode !== 'await cua.getState()') {
    throw new Error('Call only await cua.getState() in a js call, inspect its result, and act in a later js call.');
  }
  if (performsBrowserAction && !stateRead) {
    throw new Error('Initialization required: call await cua.getState() in a separate js call before browser actions.');
  }
  if (replServer.__busy) throw new Error('The previous JavaScript evaluation is still running. Wait for it to finish before sending another call.');
  currentJsCall += 1;
  const timeout = Number.isInteger(timeout_ms) ? Math.max(100, Math.min(timeout_ms, 30_000)) : 30_000;
  replServer.__busy = true;
  replServer.__logs = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`JavaScript evaluation exceeded timeout_ms=${timeout}${title ? ` (${title})` : ''}.`));
    }, timeout);
    replServer.eval(code, replServer.context, 'duya-cua-repl', (err, value) => {
      clearTimeout(timer);
      replServer.__busy = false;
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      if (initializationStage === 0) initializationStage = 1;
      else if (initializationStage === 1) initializationStage = 2;
      let output = serializable(value);
      if (replServer.__logs.length) output = `${replServer.__logs.join('\n')}\n${output}`;
      if (output.length > maxOutputChars) output = `${output.slice(0, maxOutputChars)}\n… (output truncated)`;
      resolve(output);
    });
  });
}

function toolDefinitions() {
  return [
    {
      name: 'js',
      description: 'Run JavaScript in the persistent Browser CUA session. After startup/reset, the first js call must contain only await cua.getApiDocs(), the next only await cua.getState(). Inspect state in a separate call after switching targets or tabs before taking browser actions.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to evaluate in the persistent CUA REPL.' },
          timeout_ms: { type: 'integer', minimum: 100, maximum: 30000, description: 'Evaluation timeout in milliseconds. Defaults to 30000.' },
          title: { type: 'string', description: 'Short description of this browser action.' },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
    {
      name: 'js_add_node_module_dir',
      description: 'Add an absolute node_modules directory to require() lookup in the persistent CUA JavaScript session. Takes effect immediately and remains after js_reset.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to a node_modules directory.' } }, required: ['path'], additionalProperties: false },
    },
    {
      name: 'js_reset',
      description: 'Reset the persistent JavaScript context. Browser tabs and browser state remain open. The next js call must invoke await cua.getApiDocs() again.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

async function handleTool(name, args = {}) {
  if (name === 'js') {
    const output = await executeJs(args);
    const imageMatch = output.match(/(?:^|\n)(data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+))\s*$/);
    if (imageMatch) {
      const text = output.slice(0, imageMatch.index).trim();
      return {
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          { type: 'image', mimeType: `image/${imageMatch[2]}`, data: imageMatch[3] },
        ],
      };
    }
    return textResult(output);
  }
  if (name === 'js_add_node_module_dir') {
    const value = args.path;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('path must be an absolute path.');
    const resolved = path.resolve(value);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Directory not found: ${resolved}`);
    if (!nodeModuleDirs.includes(resolved)) nodeModuleDirs.push(resolved);
    if (replServer) replServer.context.require = makeRequire();
    return textResult(`Added node module directory: ${resolved}`);
  }
  if (name === 'js_reset') {
    if (replServer?.__busy) throw new Error('Cannot reset while a JavaScript evaluation is still running.');
    if (replServer) replServer.close();
    docsRead = false;
    stateRead = false;
    initializationStage = 0;
    currentJsCall = 0;
    stateReadCall = -1;
    createRepl();
    return textResult('JavaScript context reset. Browser tabs and browser state were preserved. The next js call must invoke await cua.getApiDocs().');
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function dispatch(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const { id, method, params = {} } = message;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'initialize') {
    jsonLine({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'duya-browser-cua-repl', version: '0.1.0' } } });
    return;
  }
  if (method === 'ping') {
    jsonLine({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    jsonLine({ jsonrpc: '2.0', id, result: { tools: toolDefinitions() } });
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = await handleTool(params.name, params.arguments ?? {});
      jsonLine({ jsonrpc: '2.0', id, result });
    } catch (err) {
      jsonLine({ jsonrpc: '2.0', id, result: textResult(err instanceof Error ? err.message : String(err), true) });
    }
    return;
  }
  if (id !== undefined) jsonLine({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

createRepl();
let inputBuffer = '';
let shutdownPromise;
function shutdown() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        const health = await pluginBridgeJson('/ping', undefined, 1_000);
        if (health.extensionConnected) await extensionCommand({ action: 'close_session' }, 5_000);
      } catch { /* Extension may already be unavailable. */ }
      await Promise.allSettled([bridgeService.close(), managedBrowser.close()]);
    })();
  }
  return shutdownPromise;
}
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => { void shutdown(); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  while (true) {
    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;
    try { void dispatch(JSON.parse(line)); }
    catch (err) { process.stderr.write(`Invalid MCP message: ${err instanceof Error ? err.message : String(err)}\n`); }
  }
});

