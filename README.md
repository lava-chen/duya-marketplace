# DUYA Marketplace

Official plugin marketplace for DUYA.

## Catalog Format

The `marketplace.json` file follows this schema:

```json
{
  "name": "duya-official",
  "version": 1,
  "description": "Official DUYA plugin marketplace",
  "plugins": {
    "plugin-id": {
      "name": "Plugin Name",
      "version": "1.0.0",
      "description": "Plugin description",
      "author": "Author Name",
      "source": "https://github.com/...",
      "entry": "dist/index.js"
    }
  }
}
```

## Adding a Plugin

1. Add plugin metadata to `marketplace.json` under the `plugins` key
2. Bump the `version` number
3. Commit and push
