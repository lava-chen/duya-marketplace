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
operations use only the MCP tools declared by this plugin and the plugin App
`bind` / `invoke` protocol. The editor also supports table cells, presentation,
and local image/file uploads.

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
in `${DUYA_PLUGIN_DATA}/assets`, and project data under the same plugin-owned
data root. The agent and Mini App use separate MCP processes; cross-process
locks protect updates to the canvas store and each project database.

The plugin service does not read the former Conductor database. To migrate
existing data explicitly, run:

```sh
node plugins/conductor-canvas/legacy-export.cjs /path/to/duya-main.db /path/to/canvases.json [path/to/conductor-assets]
```

Then use **Import** in the Canvas App to select `canvases.json`. The exporter
opens the SQLite database read only, includes live WAL content, and refuses to
overwrite an existing output file. The importer preserves original element
fields and connector endpoint objects, remaps bundled assets into plugin
storage, and retains widgets and action history. Former dynamic widget code is
retained as data and is not executed. Keep the source database and asset
directory until the migrated copy has been reviewed.
