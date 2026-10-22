# Conductor Canvas

Conductor Canvas is a standalone DUYA marketplace plugin. The plugin package
owns the canvas model, persistence, MCP tool set, and Mini App; it does not
import or call DUYA's built-in Conductor implementation.

## Mini App

The `canvas` Mini App provides a canvas library and a 40 × 30 grid editor. It
supports creating, selecting, renaming, and deleting canvases; adding native
elements; dragging and resizing elements; editing content, coordinates, and
colors; searching the library; refreshing; and zooming the board. Mini App
operations use only the MCP tools declared by this plugin and the normal DUYA
Plugin App `bind` / `invoke` protocol.

## MCP tools

- `canvas_manage`: list, read the selected canvas, and switch selection.
- `canvas_create`, `canvas_rename`, `canvas_delete`: manage canvas lifecycle.
- `canvas_group_*`, `canvas_update_metadata`: organize canvases with
  groups, favorites, and tags.
- `canvas_get_snapshot`, `canvas_list_elements`: read canvas content.
- `canvas_export`, `canvas_import`: move canvases through portable JSON,
  including snapshots exported from the previous DUYA Conductor format.
- `canvas_create_element`, `canvas_move_element`, `canvas_resize_element`,
  `canvas_fill_content`, `canvas_style_element`, `canvas_delete_element`:
  edit elements.
- `canvas_connect_elements`: create a relationship line between two elements.
- `canvas_group_elements`, `canvas_ungroup_elements`: group related elements.
- `canvas_find_empty_space`, `canvas_auto_layout`, `canvas_apply_layout`:
  arrange elements.
- `canvas_undo`, `canvas_redo`: reverse or restore the latest element edit.
- `canvas_get_knowledge`: return coordinate and layout guidance.

Canvas data is stored in the plugin's `${DUYA_PLUGIN_DATA}/canvases.json` file.
The server writes atomically and keeps the file private to the current user.
The Mini App and agent share the same MCP service and data store.

This is the migrated plugin-owned Canvas workspace. Import of existing
DUYA-native canvases is a separate migration step; the plugin does not read or
modify DUYA's private Conductor database.
