'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkAppAccess, parsePolicy, validateKeyCombo, validateText } = require('../policy.cjs');

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

test('access policy environment parser validates shape and defaults explicit config to deny', () => {
  assert.deepEqual(parsePolicy(undefined), { default_access: 'allow', allowed_apps: [], denied_apps: [] });
  assert.deepEqual(parsePolicy('{"allowed_apps":["chrome"]}'), { default_access: 'deny', allowed_apps: ['chrome'], denied_apps: [] });
  assert.throws(() => parsePolicy('{bad'), /JSON/);
  assert.throws(() => parsePolicy('{"allowed_apps":"chrome"}'), /must be JSON/);
});
