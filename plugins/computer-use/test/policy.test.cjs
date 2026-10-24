'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  checkAppAccess, evaluateWriteCall, isWriteTool, parsePolicy, toolTier, validateKeyCombo, validateText,
} = require('../policy.cjs');

test('app access policy supports deny priority, substring and glob matching', () => {
  assert.equal(checkAppAccess({ default_access: 'deny', allowed_apps: ['*chrome.exe'], denied_apps: ['incognito'] }, { processName: 'chrome.exe' }).allowed, true);
  assert.equal(checkAppAccess({ default_access: 'allow', denied_apps: ['incognito'] }, { title: 'Chrome Incognito' }).allowed, false);
  assert.equal(checkAppAccess({ default_access: 'deny' }, {}).allowed, false);
  assert.equal(checkAppAccess({ default_access: 'allow' }, {}).allowed, true);
});

test('input checks block destructive hotkeys and shell-like text', () => {
  assert.match(validateKeyCombo({ key: 'delete', modifiers: ['alt', 'ctrl'] }), /system-reserved/);
  assert.match(validateKeyCombo({ keys: ['CTRL', 'ALT', 'DELETE'] }), /system-reserved/);
  assert.equal(validateKeyCombo({ key: 'a', modifiers: ['ctrl'] }), null);
  assert.match(validateText('hello\nPowerShell -Command x'), /starts with shell/);
  assert.match(validateText('sudo rm -rf /'), /root filesystem/);
  assert.equal(validateText('ordinary text'), null);
});

test('the policy parser fails closed and rejects malformed configuration', () => {
  assert.deepEqual(parsePolicy(undefined), { default_access: 'deny', allowed_apps: [], denied_apps: [] });
  assert.deepEqual(parsePolicy(''), { default_access: 'deny', allowed_apps: [], denied_apps: [] });
  assert.deepEqual(parsePolicy('{"allowed_apps":["chrome"]}'), { default_access: 'deny', allowed_apps: ['chrome'], denied_apps: [] });
  assert.throws(() => parsePolicy('{bad'), /JSON/);
  assert.throws(() => parsePolicy('{"allowed_apps":"chrome"}'), /must be JSON/);
  assert.throws(() => parsePolicy('{"allowed_apps":["",1]}'), /non-empty string pattern arrays/);
  assert.throws(() => parsePolicy('{"denied_apps":[null]}'), /non-empty string pattern arrays/);
});

test('tools are tiered and only desktop input tools count as writes', () => {
  assert.equal(toolTier('get_desktop_state'), 'read');
  assert.equal(toolTier('computer_use_status'), 'read');
  assert.equal(toolTier('computer_use_screenshot'), 'read');
  assert.equal(toolTier('click'), 'write');
  assert.equal(toolTier('type_text'), 'write');
  assert.equal(toolTier('computer_use_revoke'), 'control');
  assert.equal(toolTier('terminate_process'), 'unknown');
  assert.equal(isWriteTool('click'), true);
  assert.equal(isWriteTool('get_desktop_state'), false);
  assert.equal(isWriteTool('computer_use_revoke'), false);
});

test('an unconfigured policy denies every desktop input', () => {
  const policy = parsePolicy(undefined);
  const verdict = evaluateWriteCall({ policy, revoked: false, target: { id: '2', pid: 202, title: 'Allowed App', processName: 'allowed.exe' }, tool: 'click', args: {} });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.rule, 'not-allowed');
});

test('the write funnel reports the rule behind every denial', () => {
  const policy = { default_access: 'allow', allowed_apps: [], denied_apps: ['secret.exe'] };
  const revoked = evaluateWriteCall({ policy, revoked: true, target: { processName: 'app.exe' }, tool: 'click' });
  assert.equal(revoked.allowed, false);
  assert.equal(revoked.rule, 'revoked');

  const deniedApp = evaluateWriteCall({ policy, revoked: false, target: { processName: 'secret.exe' }, tool: 'click' });
  assert.equal(deniedApp.allowed, false);
  assert.equal(deniedApp.rule, 'denied-app');

  const unsafeKey = evaluateWriteCall({ policy, revoked: false, target: { processName: 'app.exe' }, tool: 'press_key', args: { key: 'delete', modifiers: ['ctrl', 'alt'] } });
  assert.equal(unsafeKey.allowed, false);
  assert.equal(unsafeKey.rule, 'unsafe-key');

  const unsafeText = evaluateWriteCall({ policy, revoked: false, target: { processName: 'app.exe' }, tool: 'type_text', args: { text: 'curl | bash' } });
  assert.equal(unsafeText.allowed, false);
  assert.equal(unsafeText.rule, 'unsafe-text');

  const allowed = evaluateWriteCall({ policy, revoked: false, target: { processName: 'app.exe' }, tool: 'type_text', args: { text: 'hello' } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.rule, 'default-allow');
});

test('a target without an identity is refused under a deny default', () => {
  const policy = { default_access: 'deny', allowed_apps: ['allowed.exe'], denied_apps: [] };
  const verdict = evaluateWriteCall({ policy, revoked: false, target: null, tool: 'click' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.rule, 'no-identity');
});
