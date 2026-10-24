'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const zlib = require('node:zlib');
const { cropPng, decodePng, encodePng, isPng } = require('../png.cjs');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

// Build a PNG from already-filtered scanlines so fixtures can exercise every filter type.
function buildPng({ width, height, colorType, raw, interlace = 0 }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = interlace;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function filterNoneRow(bytes) {
  return Buffer.concat([Buffer.from([0]), bytes]);
}

function makeRgbaImage(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = i * 7;
    pixels[i * 4 + 1] = i * 11;
    pixels[i * 4 + 2] = i * 13;
    pixels[i * 4 + 3] = i % 3 === 0 ? 0 : 255;
  }
  return pixels;
}

test('encodePng and decodePng round trip an RGBA image exactly', () => {
  const pixels = makeRgbaImage(5, 3);
  const encoded = encodePng({ width: 5, height: 3, pixels });
  const decoded = decodePng(encoded);
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.channels, 4);
  assert.equal(decoded.pixels.length, 5 * 3 * 4);
  assert.deepEqual(decoded.pixels, pixels);
});

test('encoded PNG starts with the signature and carries IHDR dimensions', () => {
  const encoded = encodePng({ width: 4, height: 2, pixels: Buffer.alloc(4 * 2 * 4) });
  assert.equal(isPng(encoded), true);
  assert.deepEqual(encoded.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(encoded.readUInt32BE(8), 13, 'first chunk length is the IHDR payload size');
  assert.equal(encoded.toString('latin1', 12, 16), 'IHDR');
  assert.equal(encoded.readUInt32BE(16), 4);
  assert.equal(encoded.readUInt32BE(20), 2);
  assert.equal(encoded[24], 8, 'bit depth');
  assert.equal(encoded[25], 6, 'colour type RGBA');
  assert.equal(encoded[28], 0, 'non-interlaced');
});

test('cropPng extracts the expected dimensions and pixel values', () => {
  const pixels = makeRgbaImage(4, 4);
  const cropped = cropPng(encodePng({ width: 4, height: 4, pixels }), { x: 1, y: 1, width: 2, height: 2 });
  const decoded = decodePng(cropped);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  const expected = Buffer.concat([
    pixels.subarray((1 * 4 + 1) * 4, (1 * 4 + 3) * 4),
    pixels.subarray((2 * 4 + 1) * 4, (2 * 4 + 3) * 4),
  ]);
  assert.deepEqual(decoded.pixels, expected);
});

test('cropPng clamps to the image edges and preserves alpha', () => {
  const pixels = makeRgbaImage(3, 2);
  const cropped = cropPng(encodePng({ width: 3, height: 2, pixels }), { x: 2, y: 1, width: 10, height: 10 });
  const decoded = decodePng(cropped);
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.deepEqual(decoded.pixels, pixels.subarray((1 * 3 + 2) * 4, (1 * 3 + 3) * 4));
  assert.equal(decoded.pixels[3], pixels[(1 * 3 + 2) * 4 + 3], 'alpha channel survives the crop');
});

test('cropPng rejects an empty region', () => {
  const encoded = encodePng({ width: 4, height: 4, pixels: Buffer.alloc(4 * 4 * 4) });
  assert.throws(() => cropPng(encoded, { x: 0, y: 0, width: 0, height: 4 }), /PNG crop region is empty/);
  assert.throws(() => cropPng(encoded, { x: 9, y: 0, width: 2, height: 2 }), /PNG crop region is empty/);
  assert.throws(() => cropPng(encoded, { x: 0, y: 0, width: 4, height: -1 }), /PNG crop region is empty/);
});

test('decoding a greyscale PNG expands the samples to RGBA', () => {
  const raw = Buffer.concat([
    filterNoneRow(Buffer.from([0, 85])),
    filterNoneRow(Buffer.from([170, 255])),
  ]);
  const decoded = decodePng(buildPng({ width: 2, height: 2, colorType: 0, raw }));
  assert.deepEqual(Array.from(decoded.pixels), [
    0, 0, 0, 255,
    85, 85, 85, 255,
    170, 170, 170, 255,
    255, 255, 255, 255,
  ]);
});

test('decoding a greyscale+alpha PNG keeps the alpha channel', () => {
  const raw = filterNoneRow(Buffer.from([10, 255, 20, 128]));
  const decoded = decodePng(buildPng({ width: 2, height: 1, colorType: 4, raw }));
  assert.deepEqual(Array.from(decoded.pixels), [10, 10, 10, 255, 20, 20, 20, 128]);
});

test('decoding an RGB PNG expands to opaque RGBA', () => {
  const raw = filterNoneRow(Buffer.from([1, 2, 3]));
  const decoded = decodePng(buildPng({ width: 1, height: 1, colorType: 2, raw }));
  assert.deepEqual(Array.from(decoded.pixels), [1, 2, 3, 255]);
});

test('decoding reverses all five PNG scanline filters', () => {
  // A 3x5 greyscale image whose rows use filter types 0..4 in turn.
  const rows = [
    { filter: 0, bytes: [10, 10, 10] },
    { filter: 1, bytes: [5, 5, 5] },
    { filter: 2, bytes: [1, 1, 1] },
    { filter: 3, bytes: [2, 2, 2] },
    { filter: 4, bytes: [3, 3, 3] },
  ];
  const raw = Buffer.concat(rows.map((row) => Buffer.from([row.filter, ...row.bytes])));
  const decoded = decodePng(buildPng({ width: 3, height: 5, colorType: 0, raw }));
  const grey = [10, 10, 10, 5, 10, 15, 6, 11, 16, 5, 10, 15, 8, 13, 18];
  const expected = grey.flatMap((value) => [value, value, value, 255]);
  assert.deepEqual(Array.from(decoded.pixels), expected);
});

test('decoding an interlaced PNG is rejected', () => {
  const raw = filterNoneRow(Buffer.from([0, 0, 0]));
  const interlaced = buildPng({ width: 1, height: 1, colorType: 0, raw, interlace: 1 });
  assert.throws(() => decodePng(interlaced), /interlaced/);
});

test('decoding garbage fails with a PNG error', () => {
  assert.equal(isPng(Buffer.from('definitely not a png')), false);
  assert.throws(() => decodePng(Buffer.from('definitely not a png')), /PNG/);
  assert.throws(() => decodePng(Buffer.alloc(0)), /PNG/);
});
