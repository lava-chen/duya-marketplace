#!/usr/bin/env python3
"""Populate the duya-marketplace repo (plan 455 / plan 313 / plan 455-open-connector-registry).

- Copies builtin plugins from packages/plugin-core/src/plugins/builtin/
  (skipping github/notion — superseded by the richer plan-313 packs
  github-development / notion-knowledge, which receive their app declarations)
- Wraps every bundled skill (packages/agent/skills) as an installable plugin,
  flat under plugins/<skill-name>/
- Adds connector plugins for app providers without a dedicated plugin
- App declarations use <pluginDir>/.app.json (plan 455-open-connector-registry
  D3, codex PluginAppFile parity — reference-style subset {apps: {name: {id}}})
- Rewrites marketplace.json into the plan-455 catalog schema
"""
import json
import re
import shutil
from pathlib import Path

SRC = Path("E:/Projects/duya")
MKT = Path("E:/Projects/duya-marketplace/duya-marketplace")
PLUGINS = MKT / "plugins"

# Builtin plugins mirrored into the marketplace. github/notion are excluded:
# the plan-313 packs github-development / notion-knowledge supersede them and
# carry their app connections via .app.json.
BUILTINS = ["documents", "obsidian", "pdf",
            "presentations", "spreadsheets", "wecom", "zotero"]

CONNECTORS = {
    "google": {
        "displayName": "Google Workspace",
        "description": "Google Drive, Calendar, and Gmail connector via OAuth. Provides the 'google' app connection for plugins that read files, events, or mail.",
        "category": "productivity",
        "keywords": ["google", "drive", "calendar", "gmail", "oauth"],
    },
    "slack": {
        "displayName": "Slack",
        "description": "Slack workspace connector via OAuth. Provides the 'slack' app connection for plugins that post or read channel messages.",
        "category": "communication",
        "keywords": ["slack", "chat", "channels", "oauth"],
    },
    "microsoft365": {
        "displayName": "Microsoft 365",
        "description": "Microsoft 365 connector via OAuth. Provides the 'microsoft365' app connection for plugins that work with Outlook, OneDrive, or Teams content.",
        "category": "productivity",
        "keywords": ["microsoft365", "office", "outlook", "onedrive", "teams", "oauth"],
    },
}

SKILL_CATEGORY_TO_PLUGIN_CATEGORY = {
    "agentic": "development",
    "apple": "productivity",
    "development": "development",
    "media": "media",
    "research": "research",
}

# Plugins whose app connection should be prompted at install time
# (catalog policy.authentication = on_install).
AUTH_ON_INSTALL = {
    "figma-design", "linear-project-execution", "notion-knowledge",
    "sentry-debugging", "supabase-development", "vercel-deployment",
    "github-development", "google", "slack", "microsoft365",
}

# App declarations per plugin (plan 455-open-connector-registry D3:
# <pluginDir>/.app.json, codex PluginAppFile reference-style subset).
APP_DECLARATIONS = {
    "figma-design": {"figma": "figma"},
    "linear-project-execution": {"linear": "linear"},
    "notion-knowledge": {"notion": "notion"},
    "sentry-debugging": {"sentry": "sentry"},
    "supabase-development": {"supabase": "supabase"},
    "vercel-deployment": {"vercel": "vercel"},
    "github-development": {"github": "github"},
    # design-suite's apps are optional integrations (previously
    # required: false) — stays authentication: on_use.
    "design-suite": {
        "figma": "figma",
        "slack": "slack",
        "linear": "linear",
        "notion": "notion",
        "google-calendar": "google",
    },
    "google": {"google": "google"},
    "slack": {"slack": "slack"},
    "microsoft365": {"microsoft365": "microsoft365"},
}

IGNORE_SHUTIL = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")


def parse_frontmatter(skill_md: Path) -> dict:
    text = skill_md.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    meta = {}
    if m:
        for line in m.group(1).splitlines():
            km = re.match(r"^([a-zA-Z-]+):\s*(.*)$", line)
            if km and not line.startswith((" ", "\t")):
                meta[km.group(1)] = km.group(2).strip()
    return meta


def copytree(src: Path, dst: Path):
    shutil.copytree(src, dst, ignore=IGNORE_SHUTIL, dirs_exist_ok=True)


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


def write_app_declaration(plugin_dir: Path, apps: dict):
    """Reference-style .app.json: {apps: {<name>: {id: <connectorId>}}}."""
    write_json(plugin_dir / ".app.json", {
        "apps": {name: {"id": cid} for name, cid in sorted(apps.items())},
    })


def remove_stale_apps_dir(plugin_dir: Path):
    """Retire the legacy apps/connections.json layout (plan 455 D3)."""
    legacy = plugin_dir / "apps"
    if legacy.is_dir():
        shutil.rmtree(legacy)


# 1. Builtin plugins ---------------------------------------------------------
for name in BUILTINS:
    src = SRC / "packages/plugin-core/src/plugins/builtin" / name
    dst = PLUGINS / name
    if dst.exists():
        shutil.rmtree(dst)
    copytree(src, dst)
    print(f"builtin: {name}")

# 2. Bundled skills -> per-skill plugins (flat under plugins/) ---------------
for cat_dir in sorted((SRC / "packages/agent/skills").iterdir()):
    if not cat_dir.is_dir() or cat_dir.name.startswith("."):
        continue
    if cat_dir.name == "voice-setup":
        skill_jobs = [("voice-setup", cat_dir)]
    else:
        skill_jobs = [(d.name, d) for d in sorted(cat_dir.iterdir())
                      if d.is_dir() and (d / "SKILL.md").exists()]
    for skill_name, skill_src in skill_jobs:
        meta = parse_frontmatter(skill_src / "SKILL.md")
        version = meta.get("version", "0.1.0")
        description = meta.get("description", f"DUYA skill: {skill_name}")
        category = ("productivity" if cat_dir.name == "voice-setup"
                    else SKILL_CATEGORY_TO_PLUGIN_CATEGORY[cat_dir.name])
        dst = PLUGINS / skill_name
        if dst.exists():
            shutil.rmtree(dst)
        dst.mkdir(parents=True)
        shutil.copytree(skill_src, dst / "skills" / skill_name,
                        ignore=IGNORE_SHUTIL)
        write_json(dst / ".duya-plugin" / "plugin.json", {
            "name": skill_name,
            "version": version,
            "description": description,
            "author": {"name": "DUYA Team", "url": "https://github.com/lava-chen/duya"},
            "license": "MIT",
            "keywords": [skill_name, "skill", cat_dir.name],
            "interface": {
                "displayName": skill_name,
                "shortDescription": description[:120],
                "longDescription": meta.get("when-to-use", description),
                "category": category,
            },
        })
        print(f"skill: {skill_name} ({cat_dir.name})")

# Remove the previous nested packaging (plugins/skills/) if present.
if (PLUGINS / "skills").is_dir():
    shutil.rmtree(PLUGINS / "skills")
    print("removed stale plugins/skills/ nesting")

# 3. Connector plugins ---------------------------------------------------------
for provider, info in CONNECTORS.items():
    dst = PLUGINS / provider
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    write_json(dst / ".duya-plugin" / "plugin.json", {
        "name": provider,
        "version": "0.1.0",
        "description": info["description"],
        "author": {"name": "DUYA Team", "url": "https://github.com/lava-chen/duya"},
        "license": "MIT",
        "keywords": info["keywords"],
        "interface": {
            "displayName": info["displayName"],
            "shortDescription": info["description"][:120],
            "longDescription": info["description"],
            "category": info["category"],
        },
    })
    write_app_declaration(dst, APP_DECLARATIONS[provider])
    print(f"connector: {provider}")

# 4. App declarations for plan-313 packs (+ dedupe bookkeeping) ---------------
for name, apps in APP_DECLARATIONS.items():
    plugin_dir = PLUGINS / name
    if plugin_dir.is_dir() and name not in CONNECTORS:
        write_app_declaration(plugin_dir, apps)
        remove_stale_apps_dir(plugin_dir)
        print(f"app declaration: {name} -> {sorted(apps)}")# Remove superseded duplicate plugins (builtin github/notion are replaced by
# the plan-313 packs github-development / notion-knowledge).
for dup in ("github", "notion"):
    dup_dir = PLUGINS / dup
    if dup_dir.is_dir():
        shutil.rmtree(dup_dir)
        print(f"removed duplicate: {dup} (superseded by plan-313 pack)")

# 5. Catalog entries for every plugin dir --------------------------------------
def plugin_category(plugin_dir: Path, fallback: str) -> str:
    mf = plugin_dir / ".duya-plugin" / "plugin.json"
    try:
        data = json.loads(mf.read_text(encoding="utf-8"))
        cat = (data.get("interface") or {}).get("category")
        if cat:
            return cat
    except Exception:
        pass
    return fallback


catalog = []
for plugin_dir in sorted(PLUGINS.iterdir()):
    if not plugin_dir.is_dir() or plugin_dir.name.startswith("."):
        continue
    rel = f"./plugins/{plugin_dir.name}"
    category = plugin_category(plugin_dir, "other")
    auth = "on_install" if plugin_dir.name in AUTH_ON_INSTALL else "on_use"
    catalog.append({
        "name": plugin_dir.name,
        "source": {"source": "local", "path": rel},
        "policy": {"installation": "available", "authentication": auth},
        "category": category,
    })

write_json(MKT / "marketplace.json", {
    "name": "duya-official",
    "interface": {"displayName": "DUYA Official"},
    "plugins": catalog,
})
print(f"marketplace.json: {len(catalog)} entries")
