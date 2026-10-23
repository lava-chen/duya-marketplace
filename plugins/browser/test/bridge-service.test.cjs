'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');
const { test } = require('node:test');
const { createBridgeService } = require('../bridge-service.cjs');

const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function maskedFrame(value) {
  const payload = Buffer.from(value);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

class ExtensionSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    socket.on('data', (chunk) => this.consume(chunk));
  }

  static async connect(port, id = extensionId) {
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const key = crypto.randomBytes(16).toString('base64');
    socket.write([
      'GET /ext HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Origin: chrome-extension://${id}`,
      '',
      '',
    ].join('\r\n'));
    let response = Buffer.alloc(0);
    const header = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket upgrade timed out.')), 2000);
      const onData = (chunk) => {
        response = Buffer.concat([response, chunk]);
        const boundary = response.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        clearTimeout(timer);
        socket.off('data', onData);
        resolve({ text: response.subarray(0, boundary).toString('utf8'), remainder: response.subarray(boundary + 4) });
      };
      socket.on('data', onData);
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const client = new ExtensionSocket(socket);
    if (header.remainder.length) client.consume(header.remainder);
    return { client, status: header.text.split('\r\n')[0] };
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) {
        const waiter = this.waiters.shift();
        if (waiter) waiter(JSON.parse(payload.toString('utf8')));
        else this.messages.push(JSON.parse(payload.toString('utf8')));
      }
    }
  }

  send(value) {
    this.socket.write(maskedFrame(JSON.stringify(value)));
  }

  nextMessage() {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message.')), 2000);
      this.waiters.push((message) => { clearTimeout(timer); resolve(message); });
    });
  }

  close() {
    this.socket.destroy();
  }
}

test('owns extension authentication, command relay, and disconnect lifecycle', async () => {
  const service = createBridgeService({ port: 0, extensionId });
  const port = await service.start();
  let extension;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(denied.status, 403);
    const ping = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { 'X-DUYA-BROWSER': service.token } });
    assert.deepEqual(await ping.json(), { ok: true, extensionConnected: false, extension: null });

    const wrongOrigin = await ExtensionSocket.connect(port, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.match(wrongOrigin.status, /403 Forbidden/);
    wrongOrigin.client.close();

    const opened = await ExtensionSocket.connect(port);
    assert.match(opened.status, /101 Switching Protocols/);
    extension = opened.client;
    extension.send({ type: 'hello', name: 'DUYA Browser Bridge', version: '1.5.9', extensionId });
    assert.deepEqual(await extension.nextMessage(), { type: 'hello_ack', ok: true });

    const connected = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { 'X-DUYA-BROWSER': service.token } });
    assert.deepEqual(await connected.json(), {
      ok: true,
      extensionConnected: true,
      extension: { id: extensionId, name: 'DUYA Browser Bridge', version: '1.5.9' },
    });

    const request = fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'X-DUYA-BROWSER': service.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'command-1', action: 'tabs', op: 'available' }),
    });
    assert.deepEqual(await extension.nextMessage(), { id: 'command-1', action: 'tabs', op: 'available' });
    extension.send({ id: 'command-1', ok: true, data: [{ id: 7, url: 'https://example.com' }] });
    const result = await request;
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { id: 'command-1', ok: true, data: [{ id: 7, url: 'https://example.com' }] });

    const pending = fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'X-DUYA-BROWSER': service.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'command-2', action: 'screenshot' }),
    });
    assert.equal((await extension.nextMessage()).id, 'command-2');
    extension.close();
    extension = null;
    const disconnected = await pending;
    assert.equal(disconnected.status, 400);
    assert.match((await disconnected.json()).error, /extension disconnected/i);
  } finally {
    extension?.close();
    await service.close();
  }
});

test('rejects cross-origin and untrusted clients, duplicate IDs, and timed out commands', async () => {
  const service = createBridgeService({ port: 0, extensionId, commandTimeoutMs: 40 });
  const port = await service.start();
  let extension;
  try {
    const url = `http://127.0.0.1:${port}/ping`;
    const validHeaders = { 'X-DUYA-BROWSER': service.token };
    assert.equal((await fetch(url, { headers: { 'X-DUYA-BROWSER': 'wrong' } })).status, 403);
    assert.equal((await fetch(url, { headers: { ...validHeaders, Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(url, { method: 'OPTIONS', headers: validHeaders })).status, 403);

    const bad = await ExtensionSocket.connect(port);
    const untrusted = bad.client;
    untrusted.send({ type: 'hello', name: 'Other extension', extensionId });
    assert.deepEqual(await untrusted.nextMessage(), { type: 'hello_ack', ok: false, reason: 'untrusted_extension' });
    untrusted.close();
    const stillDisconnected = await fetch(url, { headers: validHeaders });
    assert.equal(stillDisconnected.status, 200);
    assert.equal((await stillDisconnected.json()).extensionConnected, false);
    const unavailable = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST', headers: { ...validHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'without-extension' }),
    });
    assert.equal(unavailable.status, 503);

    const opened = await ExtensionSocket.connect(port);
    extension = opened.client;
    extension.send({ type: 'hello', name: 'DUYA Browser Bridge', version: '1.5.9', extensionId });
    assert.deepEqual(await extension.nextMessage(), { type: 'hello_ack', ok: true });

    const first = fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST', headers: { ...validHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'duplicate', action: 'tabs', op: 'list' }),
    });
    assert.equal((await extension.nextMessage()).id, 'duplicate');
    const duplicate = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST', headers: { ...validHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'duplicate', action: 'tabs', op: 'list' }),
    });
    assert.equal(duplicate.status, 409);
    extension.send({ id: 'duplicate', ok: true, data: [] });
    assert.equal((await first).status, 200);

    const timeout = fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST', headers: { ...validHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'slow', action: 'screenshot' }),
    });
    assert.equal((await extension.nextMessage()).id, 'slow');
    assert.equal((await timeout).status, 408);
  } finally {
    extension?.close();
    await service.close();
  }
});

test('replacing the connected extension rejects its in-flight command and preserves the new session', async () => {
  const service = createBridgeService({ port: 0, extensionId });
  const port = await service.start();
  let first;
  let second;
  try {
    first = (await ExtensionSocket.connect(port)).client;
    first.send({ type: 'hello', name: 'DUYA Browser Bridge', version: '1.5.9', extensionId });
    assert.deepEqual(await first.nextMessage(), { type: 'hello_ack', ok: true });

    const pending = fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'X-DUYA-BROWSER': service.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'replaced-command', action: 'screenshot' }),
    });
    assert.equal((await first.nextMessage()).id, 'replaced-command');

    second = (await ExtensionSocket.connect(port)).client;
    second.send({ type: 'hello', name: 'DUYA Browser Bridge', version: '1.5.9', extensionId });
    assert.deepEqual(await second.nextMessage(), { type: 'hello_ack', ok: true });
    const replaced = await pending;
    assert.equal(replaced.status, 400);
    assert.match((await replaced.json()).error, /connection replaced/i);
    assert.equal(first.socket.destroyed, false);

    const health = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { 'X-DUYA-BROWSER': service.token } });
    assert.equal((await health.json()).extensionConnected, true);
  } finally {
    first?.close();
    second?.close();
    await service.close();
  }
});
