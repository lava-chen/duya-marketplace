'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseDriverObservation, selectTargetWindow } = require('../identity.cjs');

test('parses window identity from JSON encoded in MCP content text', () => {
  const observation = parseDriverObservation({ content: [{ type: 'text', text: JSON.stringify({ windows: [{ window_id: 9, title: 'Editor', process_name: 'editor.exe', is_active: true }] }) }] });
  assert.deepEqual(observation.active, { id: '9', pid: null, title: 'Editor', app: 'editor.exe', processName: 'editor.exe' });
});

test('only selects requested windows that were observed; title args cannot spoof physical foreground', () => {
  const observation = parseDriverObservation({ content: [{ type: 'text', text: JSON.stringify({ windows: [{ id: 1, pid: 11, title: 'Blocked' }, { id: 2, pid: 22, title: 'Allowed' }], active_window_id: 1 }) }] });
  assert.equal(selectTargetWindow(observation, { title: 'Allowed' }, 'click').title, 'Blocked');
  assert.equal(selectTargetWindow(observation, { window_id: 2, pid: 22, title: 'Blocked' }, 'set_value').title, 'Allowed');
  assert.equal(selectTargetWindow(observation, { window_id: 99 }, 'set_value'), null);
  assert.equal(selectTargetWindow(observation, { target: { kind: 'desktop' } }, 'click'), null);
});


test('parses Cua Driver 0.38 visible-window text rows and binds the PID/window ID pair', () => {
  const observation = parseDriverObservation({ content: [{ type: 'text', text: 'Visible windows (use these pid + window_id values in every tool call):\n- pid=55 window_id=9001 "Editor" 800x600 at (10,20)' }] });
  assert.equal(observation.windows.length, 1);
  assert.deepEqual(observation.windows[0], { id: '9001', pid: 55, title: 'Editor', app: null, processName: null });
  assert.equal(selectTargetWindow(observation, { pid: 55, window_id: 9001 }, 'click').title, 'Editor');
  assert.equal(selectTargetWindow(observation, { pid: 66, window_id: 9001 }, 'click'), null);
});
