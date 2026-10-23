'use strict';

// Small, dependency-free HTTP/WebSocket relay for the Browser Bridge extension.
// The extension owns browser actions; this service owns only its local transport.
const crypto = require('node:crypto');
const http = require('node:http');

const EXPECTED_EXTENSION_NAME = 'DUYA Browser Bridge';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function frame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function createBridgeService({
  port = Number.parseInt(process.env.DUYA_BROWSER_BRIDGE_PORT || '19826', 10),
  extensionId = process.env.DUYA_BROWSER_EXTENSION_ID || '',
  commandTimeoutMs = 120_000,
  handshakeTimeoutMs = 5_000,
} = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const pending = new Map();
  const upgradedSockets = new Set();
  let extension = null;
  let extensionInfo = null;
  let closed = false;

  function rejectPending(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(error));
    }
    pending.clear();
  }

  function sendExtension(message) {
    if (!extension || extension.destroyed) throw new Error('Browser Bridge extension is not connected. Install and connect the extension shipped with this plugin.');
    extension.write(frame(JSON.stringify(message)));
  }

  function handleExtensionMessage(socket, message) {
    let value;
    try { value = JSON.parse(message.toString('utf8')); } catch { return; }
    if (value?.type === 'hello') {
      const originId = socket.extensionOriginId;
      const claimedId = typeof value.extensionId === 'string' ? value.extensionId : '';
      const valid = value.name === EXPECTED_EXTENSION_NAME && originId && claimedId === originId && (!extensionId || extensionId === originId);
      if (!valid) {
        socket.write(frame(JSON.stringify({ type: 'hello_ack', ok: false, reason: 'untrusted_extension' })));
        socket.end(frame('', 0x8));
        return;
      }
      if (extension && extension !== socket) {
        rejectPending('Browser Bridge extension connection replaced.');
        extension.end(frame('', 0x8));
      }
      extension = socket;
      extensionInfo = { id: originId, name: value.name, version: typeof value.version === 'string' ? value.version : null };
      socket.verified = true;
      socket.write(frame(JSON.stringify({ type: 'hello_ack', ok: true })));
      return;
    }
    if (!socket.verified) return;
    if (value?.type === 'log' || value?.type === 'blocked_domains') return;
    const waiter = pending.get(value?.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(value.id);
    waiter.resolve(value);
  }

  function attachWebSocket(socket, origin, initialData) {
    const originMatch = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || '');
    if (!originMatch || (extensionId && extensionId !== originMatch[1])) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.extensionOriginId = originMatch[1];
    socket.verified = false;
    socket.frameBuffer = Buffer.alloc(0);
    socket.fragments = [];
    socket.fragmentOpcode = 0;

    const consume = (chunk) => {
      socket.frameBuffer = Buffer.concat([socket.frameBuffer, chunk]);
      while (socket.frameBuffer.length >= 2) {
        const first = socket.frameBuffer[0];
        const second = socket.frameBuffer[1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (socket.frameBuffer.length < 4) return;
          length = socket.frameBuffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (socket.frameBuffer.length < 10) return;
          const extended = socket.frameBuffer.readBigUInt64BE(2);
          if (extended > BigInt(MAX_FRAME_BYTES)) { socket.destroy(); return; }
          length = Number(extended);
          offset = 10;
        }
        if (length > MAX_FRAME_BYTES) { socket.destroy(); return; }
        if (!masked) { socket.destroy(); return; }
        if (socket.frameBuffer.length < offset + 4 + length) return;
        const mask = socket.frameBuffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(socket.frameBuffer.subarray(offset, offset + length));
        socket.frameBuffer = socket.frameBuffer.subarray(offset + length);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];

        if (opcode === 0x8) { socket.end(frame('', 0x8)); return; }
        if (opcode === 0x9) { socket.write(frame(payload, 0xA)); continue; }
        if (opcode === 0xA) continue;
        if (opcode === 0x1 || opcode === 0x2) {
          socket.fragments = [payload];
          socket.fragmentOpcode = opcode;
          if (first & 0x80) {
            if (opcode === 0x1) handleExtensionMessage(socket, payload);
            socket.fragments = [];
            socket.fragmentOpcode = 0;
          }
          continue;
        }
        if (opcode === 0x0 && socket.fragmentOpcode) {
          socket.fragments.push(payload);
          const combinedSize = socket.fragments.reduce((size, part) => size + part.length, 0);
          if (combinedSize > MAX_FRAME_BYTES) { socket.destroy(); return; }
          if (first & 0x80) {
            const combined = Buffer.concat(socket.fragments, combinedSize);
            if (socket.fragmentOpcode === 0x1) handleExtensionMessage(socket, combined);
            socket.fragments = [];
            socket.fragmentOpcode = 0;
          }
        }
      }
    };

    socket.on('data', consume);
    const disconnect = () => {
      if (extension === socket) {
        extension = null;
        extensionInfo = null;
        rejectPending('Browser Bridge extension disconnected.');
      }
    };
    socket.on('end', disconnect);
    socket.on('close', disconnect);
    socket.on('error', () => {});
    if (initialData?.length) consume(initialData);
    setTimeout(() => {
      if (!socket.destroyed && !socket.verified) socket.destroy();
    }, handshakeTimeoutMs).unref();
  }

  function authenticate(req) {
    return !req.headers.origin && req.headers['x-duya-browser'] === token;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 403, { ok: false, error: 'Cross-origin requests are not supported.' });
    if (!authenticate(req)) return json(res, 403, { ok: false, error: 'Browser plugin service authorization failed.' });
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/ping') {
      return json(res, 200, { ok: true, extensionConnected: Boolean(extension && extension.verified), extension: extensionInfo });
    }
    if (req.method !== 'POST' || url.pathname !== '/command') return json(res, 404, { ok: false, error: 'Not found.' });
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(res, 413, { ok: false, error: 'Request body exceeds 1 MB.' });
      }
      const command = JSON.parse(raw || '{}');
      if (typeof command.id !== 'string' || !command.id) return json(res, 400, { ok: false, error: 'Missing command id.' });
      if (!extension || !extension.verified) return json(res, 503, { id: command.id, ok: false, error: 'Browser Bridge extension is not connected.' });
      if (pending.has(command.id)) return json(res, 409, { id: command.id, ok: false, error: 'Duplicate command id already pending.' });
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(command.id); reject(new Error(`Browser Bridge command timed out after ${Math.ceil(commandTimeoutMs / 1000)} seconds.`)); }, commandTimeoutMs);
        pending.set(command.id, { resolve, reject, timer });
        try { sendExtension(command); } catch (error) { clearTimeout(timer); pending.delete(command.id); reject(error); }
      });
      return json(res, result?.ok === false ? 400 : 200, result);
    } catch (error) {
      return json(res, error instanceof Error && error.message.includes('timed out') ? 408 : 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const key = req.headers['sec-websocket-key'];
    const originMatch = /^chrome-extension:\/\/([a-p]{32})$/.exec(req.headers.origin || '');
    const connectionTokens = String(req.headers.connection || '').toLowerCase().split(',').map((part) => part.trim());
    const validKey = typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
    if (url.pathname !== '/ext' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !connectionTokens.includes('upgrade') || req.headers['sec-websocket-version'] !== '13' || !validKey) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!originMatch || (extensionId && extensionId !== originMatch[1])) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    attachWebSocket(socket, req.headers.origin, head);
  });

  return {
    token,
    async start() {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return server.address().port;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (extension && !extension.destroyed) extension.end(frame('', 0x8));
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
      rejectPending('Browser plugin service stopped.');
      // Keep-alive HTTP requests from fetch clients can otherwise make
      // server.close() wait indefinitely while the MCP process is exiting.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createBridgeService };
