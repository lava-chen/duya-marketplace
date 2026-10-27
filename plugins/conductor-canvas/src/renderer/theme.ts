/**
 * Theme plumbing for the Canvas plugin App.
 *
 * The App runs in an opaque-origin sandboxed iframe, so duya's `data-theme`
 * attribute and its CSS variables never reach this document. The App
 * therefore carries its own copy of duya's token layer (styles/tokens.css)
 * and picks the matching block by setting `data-theme` on <html>.
 *
 * Two sources feed that attribute:
 *   1. The host (duya's renderer) pushes the theme it is rendering with.
 *      That is the authoritative value: duya's own setting may be "light"
 *      or "dark" regardless of the OS preference.
 *   2. Until the host pushes, the OS preference decides, so the App is
 *      never blank-white on a dark system.
 */

const CHANNEL = "duya.plugin-app";

export type CanvasTheme = "light" | "dark";

let hostTheme: CanvasTheme | null = null;

function documentToken(): string {
  return window.location.pathname.split("/").filter(Boolean)[0] ?? "";
}

function isTheme(value: unknown): value is CanvasTheme {
  return value === "light" || value === "dark";
}

/** Apply a theme to the document. Safe to call with the same value twice. */
export function applyTheme(theme: CanvasTheme): void {
  const root = document.documentElement;
  if (root.getAttribute("data-theme") === theme && root.style.colorScheme === theme) return;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

/**
 * Accept the host's theme push.
 *
 * The host posts `{ channel, type: "theme", documentToken, theme }`. The
 * document token check keeps a stale frame from a previous launch from
 * driving this document.
 */
function listenForHostTheme(): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as { channel?: string; type?: string; documentToken?: string; theme?: unknown } | null;
    if (!data || data.channel !== CHANNEL || data.type !== "theme") return;
    if (data.documentToken !== documentToken()) return;
    if (!isTheme(data.theme)) return;
    hostTheme = data.theme;
    applyTheme(hostTheme);
  });
}

/** Follow the OS preference until the host takes over. */
function followSystemTheme(): void {
  if (typeof window.matchMedia !== "function") return;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (hostTheme) return;
    applyTheme(query.matches ? "dark" : "light");
  };
  if (typeof query.addEventListener === "function") query.addEventListener("change", onChange);
  else if (typeof query.addListener === "function") query.addListener(onChange);
}

/**
 * Install the theme listeners. Call this before the first paint so the
 * document already carries a `data-theme` when the App renders.
 */
export function initTheme(): void {
  listenForHostTheme();
  followSystemTheme();
  const root = document.documentElement;
  if (!isTheme(root.getAttribute("data-theme"))) {
    const prefersDark = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "dark" : "light");
  }
}
