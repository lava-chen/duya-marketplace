'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CODES, ComputerUseError, RETRY_BY_CODE, codeFromDriverMessage, receiptFrom } = require('../errors.cjs');

test('every code carries a retry hint', () => {
  assert.deepEqual(Object.keys(RETRY_BY_CODE).sort(), [...CODES].sort());
  for (const code of CODES) {
    assert.ok(['reobserve', 'retry', 'never'].includes(RETRY_BY_CODE[code]), `${code} has no usable retry hint`);
  }
});

test('the error message carries the code and the retry hint', () => {
  const error = new ComputerUseError('STALE_STATE', 'The observation is expired.');
  assert.match(error.toMessage(), /^STALE_STATE: The observation is expired\. \(retry: reobserve\)$/);
  assert.equal(error.code, 'STALE_STATE');
  assert.equal(error.retry, 'reobserve');
});

test('an unknown code degrades to INTERNAL instead of leaking', () => {
  const error = new ComputerUseError('NOT_A_CODE', 'something went wrong');
  assert.equal(error.code, 'INTERNAL');
  assert.equal(error.retry, 'retry');
});

test('the action sent flag only ever holds true, false or null', () => {
  assert.equal(new ComputerUseError('INTERNAL', 'x', { actionSent: true }).actionSent, true);
  assert.equal(new ComputerUseError('INTERNAL', 'x', { actionSent: false }).actionSent, false);
  assert.equal(new ComputerUseError('INTERNAL', 'x', { actionSent: 'yes' }).actionSent, null);
  assert.equal(new ComputerUseError('INTERNAL', 'x').actionSent, null);
});

test('the driver prose is mapped onto the stable codes', () => {
  assert.equal(codeFromDriverMessage('the driver is older than the minimum version'), 'VERSION_MISMATCH');
  assert.equal(codeFromDriverMessage('the call timed out'), 'DRIVER_TIMEOUT');
  assert.equal(codeFromDriverMessage('permission denied by the operating system'), 'PERMISSION_DENIED');
  assert.equal(codeFromDriverMessage('that snapshot is stale'), 'STALE_STATE');
  assert.equal(codeFromDriverMessage('the element was not found'), 'ELEMENT_UNAVAILABLE');
  assert.equal(codeFromDriverMessage('double click is not supported'), 'ACTION_UNAVAILABLE');
  assert.equal(codeFromDriverMessage('invalid argument for the tool'), 'INVALID_REQUEST');
  assert.equal(codeFromDriverMessage('could not start the driver'), 'DRIVER_UNAVAILABLE');
  assert.equal(codeFromDriverMessage('the sky is falling'), 'INTERNAL');
  assert.equal(codeFromDriverMessage(''), 'INTERNAL');
});

test('the receipt is read from the structured payload', () => {
  const receipt = receiptFrom({ structuredContent: { action_sent: true, dispatch_status: 'possibly_sent' } });
  assert.equal(receipt.actionSent, true);
  assert.equal(receipt.dispatchStatus, 'possibly_sent');
});

test('the receipt is read from a JSON text payload', () => {
  const receipt = receiptFrom({ content: [{ type: 'text', text: JSON.stringify({ action_outcome: { action_sent: false, dispatch_status: 'not_sent' } }) }] });
  assert.equal(receipt.actionSent, false);
  assert.equal(receipt.dispatchStatus, 'not_sent');
});

test('the receipt is read from the data of a failed call', () => {
  const receipt = receiptFrom({ error: { code: -32000, message: 'the driver lost the connection', data: { action_sent: true, dispatch_status: 'possibly_sent' } } });
  assert.equal(receipt.actionSent, true);
  assert.equal(receipt.dispatchStatus, 'possibly_sent');
});

test('the receipt accepts the camel case spelling of the keys', () => {
  const receipt = receiptFrom({ structuredContent: { actionSent: true, dispatchStatus: 'sent' } });
  assert.equal(receipt.actionSent, true);
  assert.equal(receipt.dispatchStatus, 'sent');
});

test('a payload without a receipt yields no fields', () => {
  assert.deepEqual(receiptFrom(null), {});
  assert.deepEqual(receiptFrom({ content: [{ type: 'text', text: 'nothing here' }] }), {});
});
