'use strict';
const zlib = require('node:zlib');

// The 8-byte PNG signature that opens every valid file.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Sample counts per PNG colour type; only 8-bit depths are handled here.
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

// CRC table for the PNG chunk checksums, built once at load time.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function isPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length) return false;
  return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

function readChunks(buffer) {
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`PNG chunk ${type} is truncated`);
    const body = buffer.subarray(offset + 4, dataEnd);
    const expected = buffer.readUInt32BE(dataEnd);
    if (crc32(body) !== expected) throw new Error(`PNG chunk ${type} has a bad CRC`);
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (!chunks.length) throw new Error('PNG file contains no chunks');
  return chunks;
}

// Paeth predictor used by filter type 4, picking the neighbour closest to the linear estimate.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[previousStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[previousStart + x - bytesPerPixel] : 0;
      const value = raw[source + x];
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: throw new Error(`PNG uses an unsupported scanline filter ${filter}`);
      }
      out[rowStart + x] = restored & 0xff;
    }
    source += stride;
  }
  return out;
}

// Widen a decoded scanline buffer into the RGBA8 layout the rest of the plugin expects.
function toRgba(samples, width, height, colorType) {
  const pixels = Buffer.alloc(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const target = i * 4;
    if (colorType === 0) {
      const grey = samples[i];
      pixels[target] = grey;
      pixels[target + 1] = grey;
      pixels[target + 2] = grey;
      pixels[target + 3] = 255;
    } else if (colorType === 2) {
      pixels[target] = samples[i * 3];
      pixels[target + 1] = samples[i * 3 + 1];
      pixels[target + 2] = samples[i * 3 + 2];
      pixels[target + 3] = 255;
    } else if (colorType === 4) {
      const grey = samples[i * 2];
      pixels[target] = grey;
      pixels[target + 1] = grey;
      pixels[target + 2] = grey;
      pixels[target + 3] = samples[i * 2 + 1];
    } else {
      pixels[target] = samples[i * 4];
      pixels[target + 1] = samples[i * 4 + 1];
      pixels[target + 2] = samples[i * 4 + 2];
      pixels[target + 3] = samples[i * 4 + 3];
    }
  }
  return pixels;
}

function decodePng(buffer) {
  if (!isPng(buffer)) throw new Error('Input is not a PNG file');
  const chunks = readChunks(buffer);
  const header = chunks.find((entry) => entry.type === 'IHDR');
  if (!header) throw new Error('PNG file has no IHDR chunk');
  if (header.data.length < 13) throw new Error('PNG IHDR chunk is malformed');
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const bitDepth = header.data[8];
  const colorType = header.data[9];
  const interlace = header.data[12];
  if (interlace !== 0) throw new Error('PNG is interlaced; only non-interlaced images are supported');
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not supported; only 8-bit images are`);
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw new Error(`PNG colour type ${colorType} is not supported`);
  if (!width || !height) throw new Error('PNG image has zero dimensions');
  const idat = chunks.filter((entry) => entry.type === 'IDAT');
  if (!idat.length) throw new Error('PNG file has no IDAT data');
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat.map((entry) => entry.data)));
  } catch (cause) {
    throw new Error(`PNG image data could not be inflated: ${cause.message}`);
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`PNG image data has an unexpected length of ${raw.length} bytes`);
  }
  const samples = unfilter(raw, width, height, channels);
  return { width, height, channels: 4, pixels: toRgba(samples, width, height, colorType) };
}

function encodePng({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PNG output needs positive integer width and height');
  }
  if (!Buffer.isBuffer(pixels) || pixels.length !== width * height * 4) {
    throw new Error(`PNG output needs ${width * height * 4} bytes of RGBA pixels`);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method: adaptive
  header[12] = 0; // interlace: none
  // Filter type 0 keeps the encoded stream simple and lets the decoder stay predictable.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (width * 4 + 1);
    raw[target] = 0;
    pixels.copy(raw, target + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function cropPng(buffer, { x, y, width, height } = {}) {
  const image = decodePng(buffer);
  const requested = [x, y, width, height];
  if (requested.some((value) => !Number.isFinite(value))) {
    throw new Error('PNG crop region needs finite numeric bounds');
  }
  const startX = Math.max(0, Math.min(Math.trunc(x), image.width));
  const startY = Math.max(0, Math.min(Math.trunc(y), image.height));
  const endX = Math.max(startX, Math.min(startX + Math.trunc(width), image.width));
  const endY = Math.max(startY, Math.min(startY + Math.trunc(height), image.height));
  const cropWidth = endX - startX;
  const cropHeight = endY - startY;
  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error(`PNG crop region is empty for a ${image.width}x${image.height} image`);
  }
  const cropped = Buffer.alloc(cropWidth * cropHeight * 4);
  for (let row = 0; row < cropHeight; row += 1) {
    const sourceStart = ((startY + row) * image.width + startX) * 4;
    image.pixels.copy(cropped, row * cropWidth * 4, sourceStart, sourceStart + cropWidth * 4);
  }
  return encodePng({ width: cropWidth, height: cropHeight, pixels: cropped });
}

module.exports = { decodePng, encodePng, cropPng, isPng };
