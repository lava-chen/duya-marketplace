'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createScreenshotService } = require('../screenshot.cjs');
const { decodePng, encodePng } = require('../png.cjs');
const { createManualClock } = require('./helpers/manual-clock.cjs');

function makePng(width = 8, height = 6) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = x * 10;
      pixels[offset + 1] = y * 10;
      pixels[offset + 2] = 128;
      pixels[offset + 3] = 255;
    }
  }
  return encodePng({ width, height, pixels });
}

function driverResult(png = makePng()) {
  return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
}

test('a capture returns the driver image with its dimensions', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  const capture = await service.capture({ result: driverResult() });
  assert.equal(capture.mimeType, 'image/png');
  assert.equal(capture.width, 8);
  assert.equal(capture.height, 6);
  assert.equal(capture.cropped, false);
  assert.equal(capture.cached, false);
});

test('a region crops the captured image', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  const capture = await service.capture({ result: driverResult(), region: { x: 2, y: 1, width: 3, height: 2 } });
  assert.equal(capture.cropped, true);
  assert.equal(capture.width, 3);
  assert.equal(capture.height, 2);
  const decoded = decodePng(Buffer.from(capture.data, 'base64'));
  assert.equal(decoded.width, 3);
  assert.equal(decoded.pixels[0], 20);
  assert.equal(decoded.pixels[1], 10);
});

test('a region outside the captured image is refused', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  await assert.rejects(
    () => service.capture({ result: driverResult(), region: { x: 20, y: 20, width: 4, height: 4 } }),
    /outside the captured image/,
  );
});

test('a repeated capture inside the freshness window is served from the cache', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  const first = await service.capture({ result: driverResult() });
  await clock.advance(4000);
  const second = await service.capture({ result: driverResult() });
  assert.equal(second.cached, true);
  assert.equal(second.capturedAt, first.capturedAt);
  assert.equal(second.ageMs, 4000);
});

test('a capture older than the freshness window is captured again', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  const first = await service.capture({ result: driverResult() });
  await clock.advance(6000);
  const second = await service.capture({ result: driverResult() });
  assert.equal(second.cached, false);
  assert.ok(second.capturedAt > first.capturedAt);
});

test('an explicit refresh bypasses the cache', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  await service.capture({ result: driverResult() });
  const refreshed = await service.capture({ result: driverResult(), refresh: true });
  assert.equal(refreshed.cached, false);
});

test('a driver response without an image is refused', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  await assert.rejects(() => service.capture({ result: { content: [{ type: 'text', text: 'no image' }] } }), /did not return an image/);
});

test('a jpeg request against a png capture is refused instead of silently re-encoding', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  await assert.rejects(() => service.capture({ result: driverResult(), format: 'jpeg' }), /Cannot convert/);
});

test('a crop request against a non png capture is refused', async () => {
  const clock = createManualClock();
  const service = createScreenshotService({ clock });
  const jpeg = { content: [{ type: 'image', data: Buffer.from('fake').toString('base64'), mimeType: 'image/jpeg' }] };
  await assert.rejects(() => service.capture({ result: jpeg, region: { x: 0, y: 0, width: 2, height: 2 } }), /only supported for PNG/);
});
