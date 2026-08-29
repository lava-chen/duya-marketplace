#!/usr/bin/env python3
"""Populate the duya-marketplace repo (plan 455 / plan 313).

- Copies the 9 builtin plugins from packages/plugin-core/src/plugins/builtin/
- Wraps every bundled skill (packages/agent/skills) as an installable plugin
- Adds connector plugins for app providers not yet covered
- Rewrites marketplace.json into the plan-455 catalog schema
"""
import json
import re
import shutil
from pathlib import Path

SRC = Path("E:/Projects/duya")
MKT = Path("E:/Projects/duya-marketplace/duya-marketplace")
PLUGINS = MKT / "plugins"

BUILTINS = ["documents", "github", "notion", "obsidian", "pdf",
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


def write_plugin_manifest(plugin_dir: Path, manifest: dict):
    d = plugin_dir / ".duya-plugin"
    d.mkdir(parents=True, exist_ok=True)
    (d / "plugin.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# 1. Builtin plugins ---------------------------------------------------------
for name in BUILTINS:
    src = SRC / "packages/plugin-core/src/plugins/builtin" / name
    dst = PLUGINS / name
    if dst.exists():
        shutil.rmtree(dst)
    copytree(src, dst)
    print(f"builtin: {name}")

# 2. Bundled skills -> per-skill plugins --------------------------------------
entries = []  # (name, category, auth_on_install)

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
        if cat_dir.name == "voice-setup":
            category = "productivity"
        else:
            category = SKILL_CATEGORY_TO_PLUGIN_CATEGORY[cat_dir.name]
        dst = PLUGINS / "skills" / skill_name
        if dst.exists():
            shutil.rmtree(dst)
        dst.mkdir(parents=True)
        shutil.copytree(skill_src, dst / "skills" / skill_name,
                        ignore=IGNORE_SHUTIL)
        write_plugin_manifest(dst, {
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
        entries.append((f"skills/{skill_name}", skill_name, category, "on_use"))
        print(f"skill: {skill_name} ({cat_dir.name})")

# 3. Connector plugins ---------------------------------------------------------
for provider, info in CONNECTORS.items():
    dst = PLUGINS / provider
    if dst.exists():
        shutil.rmtree(dst)
    (dst / "apps").mkdir(parents=True)
    write_plugin_manifest(dst, {
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
    (dst / "apps" / "connections.json").write_text(
        json.dumps([{
            "id": provider,
            "provider": provider,
            "scopes": [],
            "toolsets": [],
            "required": True,
        }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"connector: {provider}")

# 4. Catalog entries for every plugin dir --------------------------------------
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
plugin_dirs = [d for d in sorted(PLUGINS.iterdir())
               if d.is_dir() and not d.name.startswith(".") and d.name != "skills"]
# Skill plugins live one level deeper (plugins/skills/<name>/).
skills_root = PLUGINS / "skills"
if skills_root.is_dir():
    plugin_dirs += [d for d in sorted(skills_root.iterdir())
                    if d.is_dir() and not d.name.startswith(".")]
for plugin_dir in plugin_dirs:
    rel = f"./plugins/{plugin_dir.relative_to(PLUGINS).as_posix()}"
    category = plugin_category(plugin_dir, "other")
    # on_install when the plugin requires an app connection at setup time
    auth = "on_use"
    conn = plugin_dir / "apps" / "connections.json"
    if conn.exists():
        try:
            decls = json.loads(conn.read_text(encoding="utf-8"))
            if isinstance(decls, list) and any(
                    isinstance(d, dict) and d.get("required") for d in decls):
                auth = "on_install"
        except Exception:
            pass
    catalog.append({
        "name": plugin_dir.name,
        "source": {"source": "local", "path": rel},
        "policy": {"installation": "available", "authentication": auth},
        "category": category,
    })

manifest = {
    "name": "duya-official",
    "interface": {"displayName": "DUYA Official"},
    "plugins": catalog,
}
(MKT / "marketplace.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"marketplace.json: {len(catalog)} entries")
