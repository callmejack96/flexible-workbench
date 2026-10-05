# Embedded Source Sync

This directory contains the sanitized runtime bundle imported from the user's
local `multi-source-sync` Obsidian plugin.

Run `npm run import:source-sync -- /path/to/multi-source-sync` to refresh it.
The importer removes the source installation's machine-specific cookie startup
shims, copies no `data.json`, and regenerates the marked Source Sync block in
the root `styles.css`.

At runtime, Flexible Workbench stores this module's settings in
`multi-source-sync-data.json` beside its own plugin data. On first load it can
migrate settings from a same-vault native installation or from the explicitly
configured legacy source path without embedding credentials in this repository.
