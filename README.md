# sun-kb-home

A two-level knowledge-base browser for Obsidian. The home view becomes a card wall of knowledge bases; clicking a card opens only that knowledge base's file tree.

[简体中文](README.zh-CN.md)

## Why

Obsidian's file explorer shows every folder of every project in one long tree. sun-kb-home splits that into two levels:

```
Knowledge-base cards  →  the tree of one knowledge base
       (home view)                (after clicking a card)
```

Groups are real folders. Notes remain ordinary Markdown files; the plugin does not copy them into a database.

## Concepts

| Term | Meaning |
| --- | --- |
| Knowledge base | A direct subfolder of a group folder, or a root-level folder that is not registered as a group. |
| Group | A real folder in the vault root. Creating, renaming, moving, or deleting a group operates on real folders. |
| Tree | The native-style file tree for one knowledge base. |

`data.json` stores group registrations, ordering, and display overrides only. File contents stay in the vault.

## Features

### Card wall

- One compact row per knowledge base: icon, name, document count.
- Three card styles: **bordered**, **light gray**, and **divider** (Settings → sun-kb-home → Card style).
- Folders hidden by the hide setting do not appear as cards unless **Show hidden files** is enabled.
- Create, rename, change icon, move between groups, and delete from the card menu (`⋯`) or the right-click menu.

### Groups are real folders

- **New group** creates a real folder in the vault root.
- Drag a card into another group to move its knowledge-base folder into that group.
- Rename or delete a group by renaming or deleting the real folder. Deleting a group first moves its contents back to the vault root; notes are never deleted.
- Only direct subfolders of a group become knowledge-base cards. Files placed directly inside a group stay in the native file tree and do not become cards.

### Drag and drop

- **Cards:** drag to reorder. A vertical accent line shows the insertion point: drop on the left half of a card to insert before it, or on the right half to insert after it.
- **Groups:** drag a group header to reorder groups; a line shows before/after.
- **Tree:** reorder siblings, drop into a folder, drop on an item's top/bottom edge to move into that folder at that position, or drop on the root title to move back to the knowledge-base root.
- Folder rows show an insertion line near the top/bottom 30% and a clear "move into" highlight in the middle 40%.
- Dropping a card back into its own group is a no-op and does not highlight the whole group.
- Hovering a collapsed folder for about one second expands it during a drag.
- A name collision during a move is resolved automatically with a numbered suffix.

### Native file explorer integration

- Custom order, pin to top, hide (manual or glob rules), and sort modes: custom, name, created time, modified time.
- One source of truth in `data.json`: the native explorer, the single-knowledge-base tree, and the card wall share the same order/pin/hide data.
- When hidden files are not shown, hidden root folders do not appear as knowledge-base cards.
- Multi-select drag, edge auto-scroll, and drop-into-folder work in the native explorer.

### Callouts

- `:::note`, `:::tip`, `:::info`, `:::warning`, `:::danger`.
- Optional title (`:::tip Title` or `:::tip[Title]`), collapsible variants (`:::tip+` / `:::tip-`), and nesting.
- Rendered in both Live Preview and Reading view; each view can be toggled independently.
- Inline Markdown works inside the body.

## How groups work

```
vault/
├─ Work/                  ← group (real folder)
│  ├─ Manuals/            ← knowledge base (card)
│  └─ Code/               ← knowledge base (card)
├─ Life/                  ← group
│  └─ Travel/             ← knowledge base
└─ Misc/                  ← unregistered root folder = ungrouped knowledge base
```

- A root folder becomes a group only when registered through the plugin (New group, or Settings → Groups → "Use an existing folder as a group"). Other root folders are ungrouped knowledge bases.
- Only direct subfolders are knowledge bases; deeper folders are internal folders of a knowledge base.
- Deleting a group returns its direct contents to the vault root, then removes the empty group folder. It never recursively deletes notes. If a move fails, the group is kept and an error is shown.

## Installation

**From Obsidian Community plugins:** search for **sun-kb-home**, install, and enable it.

**Manual:**

1. Download `sun-home-<version>-plugin.zip` from Releases, or build from source.
2. Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/sun-home/`.
3. Enable **sun-kb-home** in Settings → Community plugins.

After a manual copy, enable the plugin once in Community plugins. Obsidian then records it in `community-plugins.json`, so it stays enabled after restart. Do not edit that file while Obsidian is running.

Requires Obsidian **1.7.2** or newer. The plugin UI is currently in Chinese; the command names below are shown as they appear in Obsidian.

Configurations from the old `kb-home` plugin id or from virtual groups are migrated on first load. If you deferred the group migration, the command palette still has **Migrate legacy groups to real folders**.

## Usage

1. Open the knowledge-base list from the ribbon (library icon) or the command palette.
2. Create groups and knowledge bases with the toolbar buttons, or register an existing root folder as a group in Settings.
3. Drag cards to reorder them or move them between groups.
4. Click a card to open that knowledge base's tree; use "← All knowledge bases" to return.
5. In the tree, use the toolbar to create notes or folders, change the sort mode for the whole knowledge base, collapse/expand all, or reveal the active note.
6. Right-click items for open/new tab, rename, delete, copy path, reveal in system file manager, pin, hide, and sort actions.

## Settings

- **Open knowledge-base list on startup** — enabled by default.
- **Card style** — bordered, light gray, or divider.
- **Rescan knowledge bases** — refresh after creating folders outside Obsidian.
- **Group management** — view the real folder behind each group, register an existing root folder as a group, and delete groups.
- **Sort & hide** — show hidden files, manage hidden items individually, choose where new items are inserted, keep custom order on create/delete, configure gitignore-style glob rules, and enable debug logging.
- **Callouts** — separate toggles for Live Preview and Reading view.

## Commands

Open the command palette and search for `sun-kb-home`:

- `打开知识库列表` — Open the knowledge-base list
- `打开当前笔记所在知识库的目录` — Open the tree for the active note's knowledge base
- `显示 / 隐藏被隐藏的文件` — Toggle hidden files
- `迁移旧分组到真实文件夹` — Migrate legacy groups (only needed for very old configurations)

Two ribbon icons mirror the first two commands.

## Known limitations

- Groups are one level deep; nested groups are not supported.
- Files placed directly in a group folder are not knowledge-base cards. They remain accessible in the native file tree.
- Folders starting with `.` and folders matching a hide rule are not listed.
- Renaming a group or knowledge base does not rewrite old paths in glob hide rules; update the rules manually.
- Moving or deleting groups operates on real folders. Obsidian updates internal links, but external tools, absolute paths, or references created outside Obsidian may need manual fixes.
- Callouts: in Reading view, block elements separated from the rest of a callout by a blank line may fall outside the box. Live Preview does not have this issue. Inline Markdown in callout titles renders in Live Preview but is plain text in Reading view.
- The Reading-view callout renderer rewrites Obsidian-rendered DOM; other plugins that also rewrite the preview DOM may interact with it.

## Build from source

```bash
npm install --ignore-scripts
npm run build        # production main.js
npm run dev          # watch mode
npm run typecheck    # TypeScript check
```

`main.js` is written to the project root; combine it with `manifest.json` and `styles.css`.

On Windows, `--ignore-scripts` avoids an esbuild postinstall `EBUSY`; the platform package is still installed normally.

## Credits and license

MIT.

The sort/pin/hide engine in `src/core/` is adapted from [Flexplorer](https://github.com/kh4f/flexplorer) (MIT, by kh4f). Callout support is based on the earlier admonition-blocks implementation. See `LICENSE`.

## Compatibility

- `minAppVersion`: 1.7.2
- Tested with Obsidian 1.14.4.
- The live CDP regression suite covers card/tree drag and drop, group operations, settings, migration, persistence, callouts, and cleanup (12/12 passing at release 1.6.8).
