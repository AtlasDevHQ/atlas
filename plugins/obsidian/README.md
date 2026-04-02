# Atlas for Obsidian

Obsidian plugin for [Atlas](https://www.useatlas.dev) — query your databases with natural language and embed results directly in your notes.

## Features

- **Query modal** — Open with the ribbon icon or `Ask a question` command (`Ctrl/Cmd+P`). Streams results from the Atlas agent in real time.
- **Insert into note** — One-click insert of the agent's answer and data tables as Markdown into your active note.
- **Code block processor** — Embed live queries in notes using ` ```atlas ` fenced blocks. Click "Run query" to execute; results are cached per session with a refresh button.
- **Keyboard shortcut** — `Ctrl/Cmd+Enter` submits from the query modal.

## Install

### From Obsidian Community Plugins (coming soon)

Search for "Atlas" in **Settings → Community Plugins → Browse**.

### Manual

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the [releases page](https://github.com/AtlasDevHQ/atlas/releases).
2. Create `<vault>/.obsidian/plugins/atlas/` and copy the files there.
3. Enable the plugin in **Settings → Community Plugins**.

### Build from Source

```bash
cd plugins/obsidian
bun install
bun run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin directory.

## Configuration

Open **Settings → Atlas** and set:

| Setting | Description |
|---------|-------------|
| **Atlas URL** | Base URL of your Atlas instance (e.g. `https://api.example.com`) |
| **API key** | API key for authentication (leave empty if auth is disabled) |

## Usage

### Query Modal

1. Click the database icon in the ribbon, or run **Atlas: Ask a question** from the command palette.
2. Type a natural-language question and press **Ask** (or `Ctrl/Cmd+Enter`).
3. View the streamed answer and data tables in the modal.
4. Click **Insert into note** to paste the result as Markdown at your cursor.

### Embedded Queries

Add a fenced code block with the `atlas` language tag:

````markdown
```atlas
How many users signed up last week?
```
````

When you view the note in reading mode, a "Run query" button appears. Click it to execute the query — the answer and tables render inline. Results are cached for the session; click "Refresh" to re-run.

## Reference

- [Plugin docs](https://docs.useatlas.dev/plugins/interactions/obsidian)
- [Atlas documentation](https://docs.useatlas.dev)
