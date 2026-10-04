# Excalidraw MCP App Server

MCP server that streams hand-drawn Excalidraw diagrams with smooth viewport camera control and interactive fullscreen editing.

![Demo](docs/demo.gif)

## Install

Works with any client that supports [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) — Claude, ChatGPT, VS Code, Goose, and others. If something doesn't work, please [open an issue](https://github.com/antonpk1/excalidraw-mcp-app/issues).

### Remote (recommended)

### `https://mcp.excalidraw.com`

For apps that don't yet have an official integration, you can add a custom MCP / connector (naming can vary between apps).

### Local

**Option A: Download Extension**

1. Download `excalidraw-mcp-app.mcpb` from [Releases](https://github.com/antonpk1/excalidraw-mcp-app/releases)
2. Double-click to install in Claude Desktop

**Option B: Build from Source**

```bash
git clone https://github.com/excalidraw/excalidraw-mcp.git
cd excalidraw-mcp-app
pnpm install && pnpm run build
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw-mcp-app/dist/index.js", "--stdio"]
    }
  }
}
```

Restart Claude Desktop.

## Usage

Example prompts:
- "Draw a cute cat using excalidraw"
- "Draw an architecture diagram showing a user connecting to an API server which talks to a database"

## What are MCP Apps and how can I build one?

Text responses can only go so far. Sometimes users need to interact with data, not just read about it. [MCP Apps](https://github.com/modelcontextprotocol/ext-apps/) is an official Model Context Protocol extension that lets servers return interactive HTML interfaces (data visualizations, forms, dashboards) that render directly in the chat.

- **Getting started for humans**: [documentation](https://modelcontextprotocol.io/docs/extensions/apps)
- **Getting started for AIs**: [skill](https://github.com/modelcontextprotocol/ext-apps/blob/main/plugins/mcp-apps/skills/create-mcp-app/SKILL.md)

## Contributing

PRs welcome! See [Local](#local) above for build instructions.

## Fork: local viewer fixes

This fork (`void0x14/mcp-excalidraw`) fixes the local browser viewer used by
`show_diagram`, where the canvas could not be panned or zoomed and both
**Edit** and **Open in Excalidraw** did nothing.

### What was broken

The viewer (`tools/excali-view`) acts as the MCP App **host**. It answered the
widget's JSON-RPC with stubs:

| Widget request | Old reply | Effect |
| --- | --- | --- |
| `ui/open-link` | `{}` | link never opened |
| `ui/request-display-mode` | `{}` | SDK schema requires `{mode}` → parse error → Edit dead |
| `tools/call` | `"ok"` | `export_to_excalidraw` never ran |

Separately, the inline SVG preview only supported Ctrl+wheel zoom and returned
early at scale 1, so a plain wheel did nothing and there was no drag-to-pan.

### Fixes

**`tools/excali-view`** — real host:

- `ui/open-link` → opens the URL (`xdg-open`), logged to `/tmp/excali-view/opened-urls.log`
- `ui/request-display-mode` → returns `{mode}` and makes the iframe fullscreen
- `tools/call` → forwarded to a real stdio MCP server (`dist/index.js --stdio`)
- `/scene` returns `{elements, checkpointId}`; the checkpoint id is derived from
  the scene content, so a new diagram gets its own localStorage edit cache

**`src/mcp-app.tsx`** — viewport interaction:

- plain wheel / trackpad → pan
- Ctrl/Cmd + wheel → zoom at cursor
- space-drag or middle-drag → pan
- double-click → reset zoom and pan
- a changed `checkpointId` clears stale user edits, so a new diagram renders
- after editing, the inline view keeps the scene-space viewport instead of
  collapsing to the raw export bounds
- Escape exits fullscreen (capture phase; visible Excalidraw overlays win first)

### Verified

Playwright against `http://127.0.0.1:8765/` with a 34-element scene: wheel pan,
Ctrl+wheel zoom, space-drag, double-click reset, Edit → full Excalidraw editor
→ draw → checkpoint written (45 elements), and Open in Excalidraw → a real
`https://excalidraw.com/#json=...` link that opens the editable scene.

| Screenshot | Shows |
| --- | --- |
| `docs/evidence/01-edit-fullscreen.png` | Edit opens the real Excalidraw editor |
| `docs/evidence/03-zoom-in.png` | Ctrl+wheel zoom, diagram legible |
| `docs/evidence/04-excalidraw-com-edited-scene.png` | exported link opens the editable scene on excalidraw.com |
| `docs/evidence/05-new-diagram-after-edit.png` | a new diagram (new checkpointId) replaces the edited one |

### Deploy your own instance

You can deploy your own copy to Vercel in a few clicks:

1. Fork this repo
2. Go to [vercel.com/new](https://vercel.com/new) and import your fork
3. No environment variables needed — just deploy
4. Your server will be at `https://your-project.vercel.app/mcp`

### Release checklist

<details>
<summary>For maintainers</summary>

```bash
# 1. Bump version in manifest.json and package.json
# 2. Build and pack
pnpm run build && mcpb pack .

# 3. Create GitHub release
gh release create v0.3.0 excalidraw-mcp-app.mcpb --title "v0.3.0" --notes "What changed"

# 4. Deploy to Vercel
vercel --prod
```

</details>

## Credits

Built with [Excalidraw](https://github.com/excalidraw/excalidraw) — a virtual whiteboard for sketching hand-drawn like diagrams.

## License

MIT
