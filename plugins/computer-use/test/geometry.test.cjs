'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const geometry = require('../geometry.cjs');
const { parseDisplayMetrics } = geometry;

test('reads a scale factor and a logical coordinate space from an observation', () => {
  const metrics = parseDisplayMetrics({ content: [{ type: 'text', text: JSON.stringify({
    screen: { logical_width: 1920, logical_height: 1080, scale_factor: 1.5, dpi: 144 },
  }) }] });
  assert.equal(metrics.scale, 1.5);
  assert.equal(metrics.coordinateSpace, 'logical');
});

test('derives the scale from a raw dpi value', () => {
  const metrics = parseDisplayMetrics({ dpi: 120, pixel_width: 2560 });
  assert.equal(metrics.scale, 1.25);
  assert.equal(metrics.coordinateSpace, 'physical');
});

test('keeps an unknown coordinate space when the observation does not declare one', () => {
  const metrics = parseDisplayMetrics({ windows: [{ window_id: 1, pid: 2, title: 'Editor' }] });
  assert.equal(metrics.coordinateSpace, 'unknown');
  assert.equal(metrics.scale, null);
});

test('collects monitor origins and per monitor scale', () => {
  const metrics = parseDisplayMetrics({
    monitors: [
      { id: 'builtin', x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
      { id: 'side', x: 1920, y: -200, width: 2560, height: 1440, scale: 1.5 },
    ],
    coordinate_space: 'logical',
  });
  assert.equal(metrics.monitors.length, 2);
  assert.equal(metrics.monitors[1].origin.x, 1920);
  assert.equal(metrics.monitors[1].origin.y, -200);
  assert.equal(metrics.monitors[1].scale, 1.5);
  assert.equal(metrics.coordinateSpace, 'logical');
});

test('the plugin never rescales coordinates', () => {
  // Coordinates are capture pixels: the driver owns the mapping. A conversion
  // helper coming back would silently move every click on a scaled display.
  assert.deepEqual(Object.keys(geometry), ['parseDisplayMetrics']);
  assert.equal(geometry.toDriverCoordinates, undefined);
});

test('the display metrics only report what the observation declares', () => {
  const metrics = parseDisplayMetrics({
    coordinate_space: 'logical',
    monitors: [
      { id: 'builtin', x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
      { id: 'side', x: 1920, y: 0, width: 2560, height: 1440, scale: 2 },
    ],
  });
  assert.equal(metrics.monitors.length, 2);
  assert.equal(metrics.monitors[1].origin.x, 1920);
  assert.equal(metrics.monitors[1].scale, 2);
  assert.equal(metrics.coordinateSpace, 'logical');
  assert.equal(metrics.scale, 1);
});
