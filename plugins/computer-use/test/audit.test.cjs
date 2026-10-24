'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createAuditor } = require('../audit.cjs');

async function tempFile(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'audit.jsonl');
}

function collect(stderr) {
  return { write: (text) => stderr.push(text) };
}

test('a record carries the call identity, tool, target, result and policy conclusion', async (t) => {
  const file = await tempFile(t);
  const auditor = createAuditor({ file });
  const outcome = await auditor.record({
    callId: 'c_1234abcd',
    tool: 'click',
    tier: 'write',
    generation: 7,
    target: { id: '2', pid: 202, title: 'Allowed App', app: 'allowed.exe', processName: 'allowed.exe' },
    result: 'allowed',
    policy: { decision: 'allow', rule: 'allowed-app', reason: null },
    durationMs: 12,
    args: { x: 10, y: 20 },
  });
  assert.equal(outcome.ok, true);

  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const entry = lines[0];
  assert.equal(entry.callId, 'c_1234abcd');
  assert.equal(entry.tool, 'click');
  assert.equal(entry.tier, 'write');
  assert.equal(entry.generation, 7);
  assert.equal(entry.target.windowId, '2');
  assert.equal(entry.target.pid, 202);
  assert.equal(entry.result, 'allowed');
  assert.equal(entry.policy.rule, 'allowed-app');
  assert.equal(entry.durationMs, 12);
  assert.ok(entry.ts);
});

test('typed text is redacted in the audit trail', async (t) => {
  const file = await tempFile(t);
  const auditor = createAuditor({ file });
  await auditor.record({ callId: 'c_1', tool: 'type_text', result: 'allowed', args: { text: 'secret password', x: 3 } });
  const entry = JSON.parse((await readFile(file, 'utf8')).trim());
  assert.equal(entry.args.text, '[redacted:15 chars]');
  assert.equal(entry.args.x, 3);
});

test('the audit log rotates when it grows past the size limit', async (t) => {
  const file = await tempFile(t);
  const auditor = createAuditor({ file, maxBytes: 400, keep: 2 });
  for (let index = 0; index < 12; index++) {
    await auditor.record({ callId: `c_${index}`, tool: 'click', result: 'allowed', args: { x: index, note: 'x'.repeat(60) } });
  }
  const files = await readdir(path.dirname(file));
  assert.ok(files.includes('audit.jsonl.1'), files.join(','));
  assert.ok(!files.includes('audit.jsonl.3'), files.join(','));
});

test('a failing audit log degrades to memory instead of throwing', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'computer-use-audit-broken-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocker = path.join(directory, 'audit-file');
  await writeFile(blocker, 'not a directory', 'utf8');
  const stderr = [];
  const auditor = createAuditor({ file: path.join(blocker, 'audit.jsonl'), stderr: collect(stderr) });

  const outcome = await auditor.record({ callId: 'c_1', tool: 'click', result: 'allowed', args: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.degraded, true);
  assert.equal(auditor.degraded(), true);
  assert.match(stderr.join(''), /audit write failed/i);
  assert.equal(auditor.recent().length, 1);
  assert.equal(auditor.recent()[0].callId, 'c_1');
});
