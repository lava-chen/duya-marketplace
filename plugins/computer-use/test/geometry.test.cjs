'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseDisplayMetrics, toDriverCoordinates } = require('../geometry.cjs');

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

test('converts a logical point into physical pixels for a scaled display', () => {
  const metrics = parseDisplayMetrics({ screen: { logical_width: 1920, scale_factor: 2, coordinate_space: 'logical' } });
  const point = toDriverCoordinates({ x: 10, y: 20 }, metrics);
  assert.deepEqual({ x: point.x, y: point.y }, { x: 20, y: 40 });
  assert.equal(point.converted, true);
  assert.equal(point.space, 'physical');
});

test('converts against the monitor that owns the point', () => {
  const metrics = parseDisplayMetrics({
    coordinate_space: 'logical',
    monitors: [
      { id: 'builtin', x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
      { id: 'side', x: 1920, y: 0, width: 2560, height: 1440, scale: 2 },
    ],
  });
  const point = toDriverCoordinates({ x: 2000, y: 100 }, metrics);
  assert.deepEqual({ x: point.x, y: point.y }, { x: 2080, y: 200 });
  assert.equal(point.monitor, 'side');
});

test('passes coordinates through when the observation does not declare a space', () => {
  const metrics = parseDisplayMetrics({ windows: [{ window_id: 1, pid: 2, title: 'Editor' }] });
  const point = toDriverCoordinates({ x: 11, y: 22 }, metrics);
  assert.deepEqual({ x: point.x, y: point.y }, { x: 11, y: 22 });
  assert.equal(point.converted, false);
  assert.equal(point.space, 'driver-native');
});

test('ignores a point that is not a coordinate pair', () => {
  assert.equal(toDriverCoordinates(null, parseDisplayMetrics({})), null);
  assert.equal(toDriverCoordinates({ x: 1 }, parseDisplayMetrics({})), null);
});
