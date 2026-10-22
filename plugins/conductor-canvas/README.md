# Conductor Canvas

Conductor Canvas is a marketplace plugin. This package owns the canvas model,
persistence, assets, project database, MCP tool set, and Mini App. It does not
import or call DUYA's built-in Conductor implementation.

**Migration status:** The plugin provides an independent canvas editor and MCP
backend. DUYA still contains its former Canvas implementation. Existing data is
copied only through the explicit exporter/importer below; installing the plugin
never reads or deletes the old database. See [migration boundary](MIGRATION.md).

## Mini App

The `canvas` Mini App provides a canvas library and a freeform editor. It
supports creating, selecting, renaming, and deleting canvases; adding native
elements; dragging and resizing elements; editing content, coordinates, and
colors; searching the library; refreshing; and zooming the board. Mini App
operations use only the MCP tools declared by this plugin and the normal DUYA
Plugin App `bind` / `invoke` protocol.
The editor also renders and edits table cells, provides a presentation view,
and uploads local image/file assets into the plugin data directory.
URL links can be captured as desktop or mobile head and full-page snapshots.
The `canvas_link_snapshot` tool launches the Canvas plugin's isolated managed
Chromium profile, stores the JPEG in the Canvas asset directory, and closes the
temporary tab. Chrome or Chromium is optional; when it is not on PATH, set
`CHROME_BIN` or `DUYA_BROWSER_EXECUTABLE` for the Canvas plugin runtime. The
managed Chromium transport is vendored in this plugin so Canvas remains
independently installable.

## MCP tools

- `canvas_manage`, `canvas_create`, `canvas_rename`, `canvas_update`, and
  `canvas_delete`: manage canvases and their saved metadata.
- `canvas_group_*`, `canvas_update_metadata`: organize canvases into groups and
  manage favorites and tags.
- `canvas_get_snapshot`, `canvas_list_elements`: read canvas content and native
  element fields.
- `canvas_execute_action`: apply Conductor actions for widgets, native
  elements, connectors, groups, and canvas rename.
- `canvas_project_database`: run typed source, property, record, view, and
  query commands against the plugin-owned per-project database.
- `canvas_settings_get`, `canvas_settings_set`: persist plugin settings across
  App and MCP restarts.
- `canvas_provider_status`, `canvas_provider_list`,
  `canvas_provider_configure`: configure the optional OpenAI-compatible refine
  provider. The status and model-list responses never include the API key.
- `canvas_refine_call`: send one widget data refinement request to the
  configured provider. The prompt and response validation live in this plugin.
- `canvas_export`, `canvas_import`: move canvases through portable JSON,
  including referenced assets.
- `canvas_import_bundle`: import collections exported by `legacy-export.cjs`,
  including groups, original element fields, action history, widgets, and
  referenced assets.
- `canvas_asset_put`, `canvas_asset_get`: store and read plugin-owned local
  assets by content hash. Each asset is limited to 5 MB.
- `canvas_create_element`, `canvas_move_element`, `canvas_resize_element`,
  `canvas_fill_content`, `canvas_style_element`, and `canvas_delete_element`:
  edit elements.
- `canvas_connect_elements`, `canvas_group_elements`,
  `canvas_ungroup_elements`: connect or group related elements.
- `canvas_find_empty_space`, `canvas_auto_layout`, `canvas_apply_layout`:
  arrange elements.
- `canvas_undo`, `canvas_redo`, and `canvas_get_knowledge`: reverse edits and
  return layout guidance.

Canvas data is stored in `${DUYA_PLUGIN_DATA}/canvases.json`, uploaded assets
in `${DUYA_PLUGIN_DATA}/assets`, settings (including provider credentials) in
`${DUYA_PLUGIN_DATA}/settings.json`, and project data under the same
plugin-owned data root. Private files are written with owner-only permissions.
The agent and Mini App use separate MCP processes; cross-process locks protect
updates to the canvas store, settings, and each project database. The optional
provider can also be configured through `CANVAS_OPENAI_BASE_URL`,
`CANVAS_OPENAI_MODEL`, and `CANVAS_OPENAI_API_KEY` environment variables.

The plugin service does not read the former Conductor database. To migrate
existing data explicitly, run:

```sh
node plugins/conductor-canvas/legacy-export.cjs /path/to/duya-main.db /path/to/canvases.json [path/to/conductor-assets]
```

Then use **Import** in the Canvas App to select `canvases.json`. The exporter
opens the SQLite database read only, includes live WAL content, and refuses to
overwrite an existing output file. For each canvas project path it also
exports the project database rows from `.duya/database.sqlite`. The importer
preserves source, property, record, and view IDs and the canvas project link,
preserves original element fields and connector endpoint objects, remaps
bundled assets into plugin storage, and retains widgets and action history.
Former dynamic widget code is retained as data and is not executed. Keep the
source databases and asset directory until the migrated copy has been reviewed.

Project database imports merge by stable row IDs or table keys, so importing
the same bundle again updates matching rows without duplicating them and keeps
rows from other imported projects. `bodyPath` is available on imported records.
The query response also exposes source-scoped raw legacy value rows,
`valueRefs`, `viewRecordPositions`, `relationEdges`, and events under
`legacyProjectDatabase`; imported views retain `quickFilters` in
`view.legacy.quickFilters`.

These legacy fields are retained according to the desktop engine's current
behavior. It has no `relation` property type or relation-edge query/write path;
unknown property types remain surfaced as text with their original type under
`property.legacy.originalType`, while raw relation edges stay available in the
query response. Multi-select values are read from `db_values.json_value` and
are duplicated into `db_value_refs` on writes; reads do not reconstruct them
from refs. The engine inserts view record positions when records are created,
but queries sort by requested property rules or record ID and do not apply
those positions. It stores quick filters as a schema column but does not map
or use them in view updates or queries.
