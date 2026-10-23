import test from "node:test";
import assert from "node:assert/strict";
import { decodeToolResult } from "../src/renderer/decode-tool-result.mjs";

test("uses structured MCP data when the host also includes a serialized result", () => {
  const data = { canvas: { id: "canvas-1" }, elements: [{ id: "element-1" }] };
  const response = {
    ok: true,
    result: {
      result: JSON.stringify(data),
      structured: data,
    },
  };
  assert.deepEqual(decodeToolResult(response, "canvas_get_snapshot"), data);
});

test("parses serialized MCP result when structured data is absent", () => {
  const data = { value: "persisted" };
  assert.deepEqual(decodeToolResult({ ok: true, result: { result: JSON.stringify(data) } }), data);
});

test("throws the tool error instead of returning an error-shaped result", () => {
  assert.throws(
    () => decodeToolResult({ ok: true, result: { isError: true, content: [{ type: "text", text: "permission denied" }] } }, "canvas_create"),
    /permission denied/,
  );
});
