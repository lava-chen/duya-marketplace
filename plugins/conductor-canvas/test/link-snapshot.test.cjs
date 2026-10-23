'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLinkSnapshotTool, dimensionsFor, normalizeUrl } = require('../link-snapshot.cjs');

test('accepts http(s) URLs and rejects unsupported schemes and credentials', () => {
  assert.equal(normalizeUrl('https://example.com/page#section'), 'https://example.com/page');
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /only http and https/);
  assert.throws(() => normalizeUrl('https://user:pass@example.com'), /username and password/);
});

test('snapshot dimensions use the requested device and cap full-page height', () => {
  assert.deepEqual(dimensionsFor('desktop-head', { height: 5000 }), { width: 1280, height: 800 });
  assert.deepEqual(dimensionsFor('mobile-full', { height: 20_000 }), { width: 390, height: 12_000 });
});

test('captures in isolated Chromium, stores the asset, and closes its temporary tab', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-link-snapshot-'));
  const assetDir = path.join(root, 'assets');
  const commands = [];
  let closedTab;
  const bytes = Buffer.from('jpeg bytes');
  const browser = {
    health: () => ({ ok: true }),
    send: async (method, params, tabId) => {
      commands.push({ method, params, tabId });
      if (method === 'Runtime.evaluate') return { result: { value: { height: 2400, width: 1280 } } };
      if (method === 'Page.captureScreenshot') return { data: bytes.toString('base64') };
      return {};
    },
    waitForLoad: async () => ({ loaded: true }),
    closeTab: async (tabId) => { closedTab = tabId; },
  };
  try {
    const capture = createLinkSnapshotTool({ browser, assetDir });
    const result = await capture({ url: 'https://example.com/article', mode: 'desktop-full' });
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.width, 1280);
    assert.equal(result.height, 2400);
    assert.equal(fs.readFileSync(path.join(assetDir, result.assetId)).toString(), 'jpeg bytes');
    assert.equal(JSON.parse(fs.readFileSync(path.join(assetDir, `${result.assetId}.json`), 'utf8')).mimeType, 'image/jpeg');
    assert.equal(closedTab, commands[0].tabId);
    assert.ok(commands.some(({ method }) => method === 'Page.navigate'));
    assert.ok(commands.some(({ method }) => method === 'Page.captureScreenshot'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports how to configure Chromium when no executable is available', async () => {
  const capture = createLinkSnapshotTool({
    assetDir: path.join(os.tmpdir(), 'unused-canvas-assets'),
    browser: { health: () => ({ ok: false }), send: async () => assert.fail('must not navigate') },
  });
  await assert.rejects(capture({ url: 'https://example.com', mode: 'desktop-head' }), /Set CHROME_BIN or DUYA_BROWSER_EXECUTABLE/);
});
