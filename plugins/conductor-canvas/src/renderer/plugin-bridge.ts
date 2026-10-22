const CHANNEL = "duya.plugin-app";
type ToolEntry = { toolId: string; toolName: string; serverName?: string };

class PluginBridge {
  private tools: ToolEntry[] = [];
  private bound = false;

  private request(method: string, extra: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `canvas-${crypto.randomUUID()}`;
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("Canvas App host request timed out."));
      }, 45_000);
      const receive = (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.channel !== CHANNEL || data.id !== id) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", receive);
        if (data.ok === false) reject(new Error(data.result?.message || data.error || "Canvas App host request failed."));
        else resolve(data);
      };
      window.addEventListener("message", receive);
      const documentToken = window.location.pathname.split("/").filter(Boolean)[0];
      window.parent.postMessage({ channel: CHANNEL, id, method, documentToken, ...extra }, "*");
    });
  }

  async bind(): Promise<void> {
    if (this.bound) return;
    const response = await this.request("bind");
    if (response.ok === false) throw new Error(response.error || "Could not connect the Canvas plugin service.");
    const result = response.result || {};
    this.tools = Array.isArray(result.tools) ? result.tools : [];
    this.bound = true;
  }

  async revoke(): Promise<void> {
    this.bound = false;
    this.tools = [];
    try { await this.request("unbind"); } catch { /* host may already have revoked the App */ }
  }

  async call<T = any>(toolName: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.bound) await this.bind();
    const tool = this.tools.find((item) => item.toolName === toolName);
    if (!tool) throw new Error(`Canvas capability does not grant ${toolName}.`);
    const response = await this.request("invoke", { toolId: tool.toolId, arguments: args });
    const outer = response.result || {};
    if (response.ok === false || outer.error) throw new Error(outer.error?.message || outer.message || `Canvas tool ${toolName} failed.`);
    let value = outer.result ?? outer.structuredContent ?? outer.structured ?? outer;
    if (value && Array.isArray(value.content)) {
      const text = value.content.find((item: any) => item.type === "text")?.text;
      if (typeof text === "string") {
        try { value = JSON.parse(text); } catch { if (value.isError) throw new Error(text); }
      }
    }
    if (value?.isError) throw new Error(value.content?.[0]?.text || `Canvas tool ${toolName} failed.`);
    return value as T;
  }

  get isBound(): boolean { return this.bound; }
}

export const pluginBridge = new PluginBridge();
