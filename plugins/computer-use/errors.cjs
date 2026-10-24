'use strict';

// Stable error contract for the Computer Use plugin.
//
// A failed call answers with an MCP error whose message is
//   <CODE>: <human message> (retry: <reobserve|retry|never>)
// The code and the retry hint are the contract: the code says what kind of
// failure it is, the retry hint says what the agent may do about it.

const RETRY_BY_CODE = Object.freeze({
  STALE_STATE: 'reobserve',
  ELEMENT_UNAVAILABLE: 'reobserve',
  PERMISSION_DENIED: 'never',
  NOT_AUTHORIZED: 'never',
  ACTION_UNAVAILABLE: 'never',
  INVALID_REQUEST: 'never',
  POLICY_DENIED: 'never',
  CONTROL_STOPPED: 'never',
  CONTROL_BUSY: 'never',
  VERSION_MISMATCH: 'never',
  DRIVER_UNAVAILABLE: 'retry',
  DRIVER_TIMEOUT: 'retry',
  INTERNAL: 'retry',
});

const CODES = Object.freeze(Object.keys(RETRY_BY_CODE));

class ComputerUseError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ComputerUseError';
    this.code = RETRY_BY_CODE[code] ? code : 'INTERNAL';
    this.retry = extra.retry || RETRY_BY_CODE[this.code] || 'never';
    this.outcome = extra.outcome || 'not_delivered';
    this.actionSent = extra.actionSent === true ? true : extra.actionSent === false ? false : null;
    this.dispatchStatus = extra.dispatchStatus || null;
    this.stateId = extra.stateId || null;
    this.rule = extra.rule || null;
    this.owner = extra.owner ?? null;
  }

  toMessage() {
    return `${this.code}: ${this.message} (retry: ${this.retry})`;
  }
}

// The driver speaks in prose. Map what it says onto the stable codes so the
// agent does not have to parse English.
function codeFromDriverMessage(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return 'INTERNAL';
  if (/version/.test(text) && /(older|minimum|require|mismatch)/.test(text)) return 'VERSION_MISMATCH';
  if (/timed out|timeout/.test(text)) return 'DRIVER_TIMEOUT';
  if (/permission|denied|not authorized|unauthorized|accessibility/.test(text)) return 'PERMISSION_DENIED';
  if (/stale|superseded|expired|out of date/.test(text)) return 'STALE_STATE';
  if (/element|not found|no longer/.test(text)) return 'ELEMENT_UNAVAILABLE';
  if (/unavailable|not supported|unsupported|cannot perform/.test(text)) return 'ACTION_UNAVAILABLE';
  if (/invalid|unknown argument|required/.test(text)) return 'INVALID_REQUEST';
  if (/could not start|exited|not installed|no such file|spawn/.test(text)) return 'DRIVER_UNAVAILABLE';
  return 'INTERNAL';
}

// Read the driver's own receipt, whatever shape it uses. The Cua Driver
// reports an action outcome next to the result; the keys are matched
// case-insensitively and in both the structured and the text payload.
const RECEIPT_KEYS = {
  actionSent: ['action_sent', 'actionSent', 'sent'],
  dispatchStatus: ['dispatch_status', 'dispatchStatus'],
  stateId: ['state_id', 'stateId'],
  frameId: ['frame_id', 'frameId'],
  outcome: ['action_outcome', 'actionOutcome', 'outcome'],
};

function pick(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    if (keys.some((candidate) => candidate.toLowerCase() === lower)) return value;
  }
  return undefined;
}

function textBlocks(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string');
}

function receiptFrom(result) {
  const candidates = [];
  if (result && typeof result === 'object') candidates.push(result);
  if (result?.structuredContent && typeof result.structuredContent === 'object') candidates.push(result.structuredContent);
  // A failed call keeps its receipt next to the error: the driver reports
  // whether the action may already have landed in error.data.
  if (result?.error?.data && typeof result.error.data === 'object') candidates.push(result.error.data);
  for (const block of textBlocks(result)) {
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === 'object') {
        candidates.push(parsed);
        if (parsed.action_outcome && typeof parsed.action_outcome === 'object') candidates.push(parsed.action_outcome);
      }
    } catch { /* a plain text payload carries no receipt */ }
  }
  const merged = {};
  for (const candidate of candidates) {
    for (const [field, keys] of Object.entries(RECEIPT_KEYS)) {
      if (merged[field] === undefined) {
        const value = pick(candidate, keys);
        if (value !== undefined) merged[field] = value;
      }
    }
  }
  return merged;
}

module.exports = {
  CODES,
  ComputerUseError,
  RETRY_BY_CODE,
  codeFromDriverMessage,
  receiptFrom,
};
