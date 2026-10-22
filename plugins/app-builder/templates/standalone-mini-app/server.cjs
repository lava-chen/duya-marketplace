#!/usr/bin/env node
'use strict';

// Replace this MCP implementation with your own app logic. The App and the
// agent may each start a process, so share data through the plugin data dir.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const storePath = process.env.NOTES_STORE;
if (!storePath) throw new Error('NOTES_STORE is required');
const lockPath = `${storePath}.lock`;

async function locked(action) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  let fd;
  for (let attempt = 0; attempt < 400; attempt++) {
    try { fd = fs.openSync(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 60_000) { fs.unlinkSync(lockPath); continue; }
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (fd === undefined) throw new Error('Notes store is busy');
  try { return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}

function readNotes() {
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

const tools = [
  { name: 'notes_list', description: 'List all notes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'notes_add', description: 'Add a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
];

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '0.1.0' } });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  try {
    const value = await locked(() => {
      const notes = readNotes();
      if (message.params?.name === 'notes_list') return { notes };
      if (message.params?.name !== 'notes_add') throw new Error('Unknown tool');
      const content = message.params?.arguments?.text;
      if (typeof content !== 'string' || !content.trim() || content.length > 1000) throw new Error('text must contain 1 to 1000 characters');
      const note = { id: randomUUID(), text: content.trim(), createdAt: new Date().toISOString() };
      notes.push(note);
      const temp = `${storePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(notes), { mode: 0o600 });
      fs.renameSync(temp, storePath);
      return { note };
    });
    return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  } catch (error) {
    return reply({ content: [{ type: 'text', text: error.message }], isError: true });
  }
}

let input = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const index = input.indexOf('\n');
    const line = input.slice(0, index); input = input.slice(index + 1);
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      try { const response = await handle(JSON.parse(line)); if (response) process.stdout.write(`${JSON.stringify(response)}\n`); }
      catch (error) { process.stderr.write(`${error.message}\n`); }
    });
  }
});
