export function decodeToolResult(response, toolName = "plugin tool") {
  const fallbackError = `${toolName} failed.`;
  const errorMessage = (value) => {
    if (typeof value === "string") return value;
    return value?.message || value?.error?.message || value?.error || fallbackError;
  };
  const toolError = (value) => {
    if (!value || typeof value !== "object") return undefined;
    if (value.ok === false || value.isError || value.error) {
      const contentMessage = value.content?.find?.((item) => item.type === "text")?.text;
      return contentMessage || errorMessage(value);
    }
    return undefined;
  };

  const envelopeError = toolError(response);
  if (envelopeError) throw new Error(envelopeError);

  // The app bridge wraps the MCP ToolResult in `result`; some host versions
  // also expose the structured fields on the envelope itself. Prefer the
  // structured object at either level over the serialized `result` string.
  const outer = response?.result && typeof response.result === "object" ? response.result : response;
  const nestedError = toolError(outer);
  if (nestedError) throw new Error(nestedError);

  let value = response?.structured ?? response?.structuredContent
    ?? outer?.structured ?? outer?.structuredContent ?? outer?.result ?? response?.result ?? outer;
  const valueError = toolError(value);
  if (valueError) throw new Error(valueError);

  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }

  if (Array.isArray(value?.content)) {
    const text = value.content.find((item) => item.type === "text")?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch {
        if (value.isError) throw new Error(text || fallbackError);
      }
    }
  }
  return value;
}
