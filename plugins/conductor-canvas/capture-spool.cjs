"use strict";

// File-backed rendezvous between the independently launched MCP server and
// the plugin renderer. Keep this module free of host/Core imports so the
// marketplace plugin owns the complete capture path.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const REQUEST_TTL_MS = 60_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REGION = 100_000;

function validId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function validateCapture(input) {
  if (!input || typeof input !== "object") throw new Error("Capture request must be an object.");
  if (typeof input.canvasId !== "string" || input.canvasId.length < 1 || input.canvasId.length > 256) {
    throw new Error("canvasId is required and must be at most 256 characters.");
  }
  if (!["viewport", "full", "element", "region"].includes(input.scope)) {
    throw new Error("scope must be viewport, full, element, or region.");
  }
  if (input.scope === "element" && (typeof input.elementId !== "string" || input.elementId.length > 256 || !input.elementId)) {
    throw new Error("element scope requires an elementId of at most 256 characters.");
  }
  if (input.scope === "region") {
    const r = input.region;
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0 || r.w > MAX_REGION || r.h > MAX_REGION) {
      throw new Error("region requires finite x/y and positive w/h no larger than 100000.");
    }
  }
  return {
    canvasId: input.canvasId,
    scope: input.scope,
    ...(input.elementId ? { elementId: input.elementId } : {}),
    ...(input.region ? { region: input.region } : {}),
  };
}

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temp, file);
}

function createCaptureSpool(directory) {
  const dir = path.resolve(directory);
  const paths = (id) => ({ request: path.join(dir, `${id}.request.json`), result: path.join(dir, `${id}.result.json`) });

  async function init() {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    await cleanup();
  }

  async function cleanup(now = Date.now()) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (!/^[0-9a-f-]{36}\.(request|result)\.json$/i.test(name)) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > REQUEST_TTL_MS) await fs.unlink(file).catch(() => {});
    }
  }

  async function createRequest(input, timeoutMs = 20_000) {
    await init();
    const requestId = crypto.randomUUID();
    const request = { requestId, ...validateCapture(input), createdAt: Date.now() };
    const files = paths(requestId);
    await atomicJson(files.request, request);
    try {
      const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1), 20_000);
      while (Date.now() < deadline) {
        const raw = await fs.readFile(files.result, "utf8").catch(() => null);
        if (raw) {
          const result = JSON.parse(raw);
          if (result.requestId !== requestId) throw new Error("Capture response ID mismatch.");
          if (result.error) throw new Error(String(result.error).slice(0, 2000));
          if (!result.image || typeof result.image.base64 !== "string") throw new Error("Renderer returned no screenshot.");
          const bytes = Buffer.from(result.image.base64, "base64");
          if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Screenshot exceeds the 12 MiB limit.");
          if (result.image.mimeType !== "image/png") throw new Error("Screenshot must be a PNG image.");
          return { requestId, canvasId: request.canvasId, image: { ...result.image, base64: bytes.toString("base64"), mimeType: "image/png" } };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("Canvas capture timed out after 20 seconds; open the Canvas app and select the requested canvas.");
    } finally {
      await fs.unlink(files.request).catch(() => {});
      await fs.unlink(files.result).catch(() => {});
    }
  }

  async function poll() {
    await init();
    const files = await fs.readdir(dir).catch(() => []);
    const requests = [];
    for (const name of files) {
      const match = name.match(/^([0-9a-f-]{36})\.request\.json$/i);
      if (!match) continue;
      try {
        const request = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
        if (validId(request.requestId) && request.requestId === match[1] && Date.now() - request.createdAt <= REQUEST_TTL_MS) requests.push(request);
      } catch { /* ignore partial/corrupt requests */ }
    }
    return { requests };
  }

  async function complete(input) {
    await init();
    if (!input || !validId(input.requestId)) throw new Error("A valid requestId is required.");
    const files = paths(input.requestId);
    const active = JSON.parse(await fs.readFile(files.request, "utf8").catch(() => "null"));
    if (!active || Date.now() - active.createdAt > REQUEST_TTL_MS) throw new Error("Capture request is no longer active.");
    const result = { requestId: input.requestId };
    if (input.error) result.error = String(input.error).slice(0, 2000);
    else {
      const image = input.image;
      if (!image || image.mimeType !== "image/png" || typeof image.base64 !== "string") throw new Error("Completion requires a PNG image.");
      const data = Buffer.from(image.base64, "base64");
      if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error("Screenshot exceeds the 12 MiB limit.");
      result.image = { base64: data.toString("base64"), mimeType: "image/png", width: Number(image.width), height: Number(image.height) };
      if (![result.image.width, result.image.height].every((n) => Number.isFinite(n) && n > 0 && n <= 20_000)) throw new Error("Screenshot dimensions are invalid.");
    }
    await atomicJson(files.result, result);
    return { accepted: true };
  }

  return { createRequest, poll, complete, cleanup };
}

module.exports = { createCaptureSpool, validateCapture, MAX_IMAGE_BYTES };
