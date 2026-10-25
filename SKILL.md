---
name: mcp-crush
description: Audit MCP token tax and wrap stdio servers to compress tool schemas and prune bloated JSON responses.
---

# mcp-crush

## When to use

- MCP `tools/list` handshakes eat >5% of your context (GitHub, Cloudflare, Notion).
- Local models (Ollama 8k–16k) choke on giant schemas.
- You want measurable token/USD savings without changing the upstream MCP server.

## Commands

```bash
npx mcp-crush audit
npx mcp-crush wrap -- npx -y @modelcontextprotocol/server-github
npx mcp-crush --mcp
```

## MCP tools (`--mcp`)

| Tool | Purpose |
|------|---------|
| `audit_mcp_config` | Token table per server in `.cursor/mcp.json` |
| `compress_mcp_server` | Build compression profile for a wrapped command |
| `prune_json_payload` | Drop junk fields / truncate huge `tools/call` JSON |

## Flags

- `--ollama-pack` — cap schemas ~600 tokens for local ctx
- `--dry-run` — project savings; no child process
- `--allow-write` — enable mutating tools (default read-only)

## Cursor config snippet

```json
{
  "mcpServers": {
    "mcp-crush": {
      "command": "npx",
      "args": ["-y", "mcp-crush", "--mcp"]
    }
  }
}
```
