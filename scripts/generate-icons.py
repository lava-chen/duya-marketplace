#!/usr/bin/env python3
"""Generate icon assets + defaultPrompt for the duya-marketplace plugins.

Sources (no letter-mark placeholders):
- Provider brand glyphs extracted from duya's connector-icons.tsx
  (simple-icons CC0 / gilbarbara logos CC0 path data), pinned colors.
- simple-icons (CC0) glyphs fetched from cdn.simpleicons.org for bilibili,
  youtube, X, arXiv, Apple, PostgreSQL, Playwright; WeChat from duya's
  public/icons/wechat.svg (same simple-icons path).
- Tabler icons (MIT, duya's UI icon set) for duya-internal capabilities
  (agent-create, plugin-development, skill-creator, research-paper-writing,
  voice-setup, conductor-canvas-control, design-suite, literature).

Also writes interface.icon (+ brandColor) and interface.defaultPrompt
(codex parity: max 3 prompts, <=128 chars each) into plugin manifests.
Idempotent: always rewrites generated assets; never touches other files.
"""
import json
import re
from pathlib import Path

MKT = Path("E:/Projects/duya-marketplace/duya-marketplace")
PLUGINS = MKT / "plugins"
TABLER_JSON = Path("E:/Projects/duya-marketplace/.icon-tmp/tabler-paths.json")
DUYA_WECHAT = Path("E:/Projects/duya/public/icons/wechat.svg")

# --------------------------------------------------------------------------
# Provider brand glyphs (from duya connector-icons.tsx)
# --------------------------------------------------------------------------


def svg_single(view_box: str, fill: str, path_d: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}">'
        f'<path fill="{fill}" d="{path_d}"/></svg>'
    )


GOOGLE_D = "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
FIGMA_D = "M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z"
SUPABASE_D = "M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"
SENTRY_D = "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"
VERCEL_D = "m12 1.608 12 20.784H0Z"
LINEAR_D = "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"
NOTION_D = "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
GITHUB_D = "M8 1.3a6.665 6.665 0 0 1 5.413 10.56 6.677 6.677 0 0 1-3.288 2.432c-.333.067-.458-.142-.458-.316 0-.226.008-.942.008-1.834 0-.625-.208-1.025-.45-1.233 1.483-.167 3.042-.734 3.042-3.292a2.58 2.58 0 0 0-.684-1.792c.067-.166.3-.85-.066-1.766 0 0-.559-.184-1.834.683a6.186 6.186 0 0 0-1.666-.225c-.567 0-1.134.075-1.667.225-1.275-.858-1.833-.683-1.833-.683-.367.916-.134 1.6-.067 1.766a2.594 2.594 0 0 0-.683 1.792c0 2.55 1.55 3.125 3.033 3.292-.192.166-.367.458-.425.891-.383.175-1.342.459-1.942-.55-.125-.2-.5-.691-1.025-.683-.558.008-.225.317.009.442.283.158.608.75.683.941.133.376.567 1.092 2.242.784 0 .558.008 1.083.008 1.242 0 .174-.125.374-.458.316a6.662 6.662 0 0 1-4.559-6.325A6.665 6.665 0 0 1 8 1.3Z"

SLACK_PATHS = [
    ("M53.8412698,161.320635 C53.8412698,176.152381 41.8539683,188.139683 27.0222222,188.139683 C12.1904762,188.139683 0.203174603,176.152381 0.203174603,161.320635 C0.203174603,146.488889 12.1904762,134.501587 27.0222222,134.501587 L53.8412698,134.501587 L53.8412698,161.320635 Z M67.2507937,161.320635 C67.2507937,146.488889 79.2380952,134.501587 94.0698413,134.501587 C108.901587,134.501587 120.888889,146.488889 120.888889,161.320635 L120.888889,228.368254 C120.888889,243.2 108.901587,255.187302 94.0698413,255.187302 C79.2380952,255.187302 67.2507937,243.2 67.2507937,228.368254 L67.2507937,161.320635 Z", "#E01E5A"),
    ("M94.0698413,53.6380952 C79.2380952,53.6380952 67.2507937,41.6507937 67.2507937,26.8190476 C67.2507937,11.9873016 79.2380952,0 94.0698413,0 C108.901587,0 120.888889,11.9873016 120.888889,26.8190476 L120.888889,53.6380952 L94.0698413,53.6380952 Z M94.0698413,67.2507937 C108.901587,67.2507937 120.888889,79.2380952 120.888889,94.0698413 C120.888889,108.901587 108.901587,120.888889 94.0698413,120.888889 L26.8190476,120.888889 C11.9873016,120.888889 0,108.901587 0,94.0698413 C0,79.2380952 11.9873016,67.2507937 26.8190476,67.2507937 L94.0698413,67.2507937 Z", "#36C5F0"),
    ("M201.549206,94.0698413 C201.549206,79.2380952 213.536508,67.2507937 228.368254,67.2507937 C243.2,67.2507937 255.187302,79.2380952 255.187302,94.0698413 C255.187302,108.901587 243.2,120.888889 228.368254,120.888889 L201.549206,120.888889 L201.549206,94.0698413 Z M188.139683,94.0698413 C188.139683,108.901587 176.152381,120.888889 161.320635,120.888889 C146.488889,120.888889 134.501587,108.901587 134.501587,94.0698413 L134.501587,26.8190476 C134.501587,11.9873016 146.488889,0 161.320635,0 C176.152381,0 188.139683,11.9873016 188.139683,26.8190476 L188.139683,94.0698413 Z", "#2EB67D"),
    ("M161.320635,201.549206 C176.152381,201.549206 188.139683,213.536508 188.139683,228.368254 C188.139683,243.2 176.152381,255.187302 161.320635,255.187302 C146.488889,255.187302 134.501587,243.2 134.501587,228.368254 L134.501587,201.549206 L161.320635,188.139683 Z M161.320635,188.139683 C146.488889,188.139683 134.501587,176.152381 134.501587,161.320635 C134.501587,146.488889 146.488889,134.501587 161.320635,134.501587 L228.571429,134.501587 C243.403175,134.501587 255.390476,146.488889 255.390476,161.320635 C255.390476,176.152381 243.403175,188.139683 228.571429,188.139683 L161.320635,188.139683 Z", "#ECB22E"),
]


def svg_slack() -> str:
    paths = "".join(f'<path fill="{fill}" d="{d}"/>' for d, fill in SLACK_PATHS)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{paths}</svg>'


def svg_microsoft() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 110">'
        '<polygon fill="#F1511B" points="51.94 51.94 0 51.94 0 0 51.94 0"/>'
        '<polygon fill="#80CC28" points="109.29 51.94 57.35 51.94 57.35 0 109.29 0"/>'
        '<polygon fill="#00ADEF" points="51.94 109.31 0 109.31 0 57.37 51.94 57.37"/>'
        '<polygon fill="#FBBC09" points="109.29 109.31 57.35 109.31 57.35 57.37 109.29 57.37"/>'
        "</svg>"
    )


PROVIDER_SVGS = {
    "google": svg_single("0 0 24 24", "#4285F4", GOOGLE_D),
    "figma": svg_single("0 0 24 24", "#F24E1E", FIGMA_D),
    "supabase": svg_single("0 0 24 24", "#3FCF8E", SUPABASE_D),
    "sentry": svg_single("0 0 24 24", "#7B1CFF", SENTRY_D),
    "vercel": svg_single("0 0 24 24", "#111111", VERCEL_D),
    "notion": svg_single("0 0 24 24", "#111111", NOTION_D),
    "linear": svg_single("0 0 24 24", "#5E6AD2", LINEAR_D),
    "github": svg_single("0 0 16 16", "#24292F", GITHUB_D),
    "slack": svg_slack(),
    "microsoft365": svg_microsoft(),
}

PROVIDER_BRAND = {
    "google": "#4285F4", "figma": "#F24E1E", "supabase": "#3FCF8E",
    "sentry": "#7B1CFF", "vercel": "#111111", "notion": "#111111",
    "linear": "#5E6AD2", "github": "#24292F", "slack": "#E01E5A",
    "microsoft365": "#00ADEF", "wecom": "#2BAD13",
}

PACK_PROVIDER = {
    "figma-design": "figma",
    "github-development": "github",
    "notion-knowledge": "notion",
    "linear-project-execution": "linear",
    "sentry-debugging": "sentry",
    "supabase-development": "supabase",
    "vercel-deployment": "vercel",
}

# --------------------------------------------------------------------------
# simple-icons (CC0) glyphs fetched from cdn.simpleicons.org, plus WeChat
# from duya's public/icons/wechat.svg. Keyed by plugin name.
# --------------------------------------------------------------------------
SIMPLE_ICONS_DIR = Path("E:/Projects/duya-marketplace/.icon-tmp")
SIMPLE_ICON_FILES = {
    "apple-notes": "apple.svg",
    "apple-reminders": "apple.svg",
    "findmy": "apple.svg",
    "imessage": "apple.svg",
    "bilibili": "bilibili.svg",
    "youtube": "youtube.svg",
    "twitter": "x.svg",
    "arxiv": "arxiv.svg",
    "postgres-readonly": "postgresql.svg",
    "playwright-web-operator": "playwright.svg",
}
SIMPLE_ICON_BRAND = {
    "apple-notes": "#000000", "apple-reminders": "#000000",
    "findmy": "#000000", "imessage": "#000000",
    "bilibili": "#00A1D6", "youtube": "#FF0000", "twitter": "#000000",
    "arxiv": "#B31B1B", "postgres-readonly": "#4169E1",
    "playwright-web-operator": "#2EAD33",
}

# duya-internal capabilities -> Tabler icons (MIT), duya's UI icon set.
TABLER_ICONS = {
    "agent-create": "IconRobot",
    "plugin-development": "IconPuzzle",
    "skill-creator": "IconSparkles",
    "research-paper-writing": "IconWriting",
    "voice-setup": "IconMicrophone",
    "conductor-canvas-control": "IconChalkboard",
    "design-suite": "IconPalette",
    "literature": "IconBook",
}
TABLER_COLOR = "#4F46E5"


def svg_tabler(paths: list[str]) -> str:
    body = "".join(f'<path d="{d}"/>' for d in paths)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        f'fill="none" stroke="{TABLER_COLOR}" stroke-width="2" '
        f'stroke-linecap="round" stroke-linejoin="round">{body}</svg>'
    )


DEFAULT_PROMPTS = {
    "github-development": [
        "Summarize open PRs awaiting my review",
        "Investigate the failing CI run on main",
        "Draft release notes for the last tag",
    ],
    "figma-design": [
        "Extract design context from the login screen",
        "Map this Figma component to code",
        "Verify the implementation against the design",
    ],
    "notion-knowledge": [
        "Search my Notion for the onboarding doc",
        "Turn this conversation into meeting notes",
        "Find spec pages that are missing owners",
    ],
    "linear-project-execution": [
        "Triage my open Linear issues",
        "Turn this spec into implementable issues",
        "Show sprint progress and risks",
    ],
    "sentry-debugging": [
        "Investigate the latest Sentry error",
        "Trace this stacktrace back to code",
        "Find regressions since the last release",
    ],
    "supabase-development": [
        "Review my Supabase migrations",
        "Audit RLS policies on public tables",
        "Draft an edge function for webhooks",
    ],
    "vercel-deployment": [
        "Diagnose the last failed deployment",
        "Validate the newest preview URL",
        "Summarize production changes this week",
    ],
    "google": [
        "Find my latest Drive documents",
        "Summarize today's calendar events",
        "Search mail for unread invoices",
    ],
    "slack": [
        "Summarize unread messages in #dev",
        "Post this update to the team channel",
        "Find the thread about the outage",
    ],
    "microsoft365": [
        "Summarize my unread Outlook mail",
        "Find files I shared this week",
        "List today's meetings and attendees",
    ],
    "qq-mail": [
        "Summarize unread mail in my QQ inbox",
        "Search messages from a specific contact",
        "Draft a reply to the latest invoice email",
    ],
    "tencent-docs": [
        "Search my Tencent docs for the roadmap",
        "Summarize this shared document",
        "Create a doc from this conversation",
    ],
}

TABLER_PATHS = json.loads(TABLER_JSON.read_text(encoding="utf-8"))


def resolve_icon(name: str) -> tuple[str, str | None]:
    """Return (svg, brandColor) for a plugin."""
    if name in PROVIDER_SVGS:
        return PROVIDER_SVGS[name], PROVIDER_BRAND.get(name)
    if name in PACK_PROVIDER:
        p = PACK_PROVIDER[name]
        return PROVIDER_SVGS[p], PROVIDER_BRAND.get(p)
    if name in SIMPLE_ICON_FILES:
        svg = (SIMPLE_ICONS_DIR / SIMPLE_ICON_FILES[name]).read_text(encoding="utf-8")
        # normalize: ensure xmlns present (simple-icons includes it)
        return svg, SIMPLE_ICON_BRAND.get(name)
    if name == "weixin-mp":
        return DUYA_WECHAT.read_text(encoding="utf-8"), "#07C160"
    if name in TABLER_ICONS:
        return svg_tabler(TABLER_PATHS[TABLER_ICONS[name]]), TABLER_COLOR
    raise SystemExit(f"no icon mapping for plugin: {name}")


def write_icon(plugin_dir: Path, svg: str, brand: str | None, prompts=None):
    manifest_path = plugin_dir / ".duya-plugin" / "plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    iface = manifest.setdefault("interface", {})

    asset_path = plugin_dir / "assets" / "icon.svg"
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    asset_path.write_text(svg, encoding="utf-8")
    iface["icon"] = "./assets/icon.svg"
    if brand:
        iface["brandColor"] = brand
    if prompts:
        iface["defaultPrompt"] = prompts
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


LETTER_MARK_SIGNATURE = '<rect width="64" height="64" rx="14"'


def has_own_icon(plugin_dir: Path) -> bool:
    """Builtin-derived plugins ship their own icon asset + declaration.
    Letter-mark placeholders from an earlier run do NOT count as own."""
    manifest_path = plugin_dir / ".duya-plugin" / "plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("interface", {}).get("icon"):
        return False
    for ext in (".svg", ".png"):
        asset = plugin_dir / "assets" / f"icon{ext}"
        if not asset.exists():
            continue
        if asset.suffix == ".svg":
            head = asset.read_text(encoding="utf-8")[:200]
            if LETTER_MARK_SIGNATURE in head:
                return False
        return True
    return False


# wecom builtin ships its own assets/icon.svg — keep it, only ensure mapping.
processed = 0
for plugin_dir in sorted(PLUGINS.iterdir()):
    if not plugin_dir.is_dir() or plugin_dir.name.startswith("."):
        continue
    name = plugin_dir.name
    if has_own_icon(plugin_dir):
        print(f"kept own icon: {name}")
        processed += 1
        continue
    svg, brand = resolve_icon(name)
    write_icon(plugin_dir, svg, brand, DEFAULT_PROMPTS.get(name))
    processed += 1

print(f"icons/defaultPrompt written for {processed} plugins")
