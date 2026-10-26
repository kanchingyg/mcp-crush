# mcp-crush

[![ci](https://github.com/kanchingyg/mcp-crush/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/mcp-crush/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-crush/latest?label=npm)](https://www.npmjs.com/package/mcp-crush)
[![JSR](https://jsr.io/badges/@kanchingyg/mcp-crush)](https://jsr.io/@kanchingyg/mcp-crush)
[![JSR Score](https://jsr.io/badges/@kanchingyg/mcp-crush/score)](https://jsr.io/@kanchingyg/mcp-crush/score)
[![Runtime](https://img.shields.io/badge/runtime-Node_%7C_Bun_%7C_Deno-f9f1e1)](https://github.com/kanchingyg/mcp-crush)
[![license](https://img.shields.io/github/license/kanchingyg/mcp-crush)](https://github.com/kanchingyg/mcp-crush/blob/HEAD/LICENSE)

**One line:** `npx mcp-crush wrap -- <your-mcp-cmd>` (or `bunx mcp-crush wrap -- <your-mcp-cmd>`): stdio proxy that shrinks MCP tool catalogs and prunes oversized JSON responses by 60-85%.

## Why

Large MCP servers (GitHub, Cloudflare, Notion) dump thousands of tokens into `tools/list` before your agent does any work. Local 8k models cannot fit them, and cloud APIs bill you for that handshake on every session.

`mcp-crush` sits in the middle using the same JSON-RPC wire protocol while emitting smaller payloads.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/mcp-crush):

```bash
bunx mcp-crush audit
npx mcp-crush audit

# or install in your project / globally
bun add -d mcp-crush
npm i -D mcp-crush
```

[JSR](https://jsr.io/@kanchingyg/mcp-crush):

```bash
bunx jsr add @kanchingyg/mcp-crush
npx jsr add @kanchingyg/mcp-crush
```

## Quick start

```bash
# Inspect token overhead from your MCP config
npx mcp-crush audit
bunx mcp-crush audit

# Wrap any stdio MCP server
npx mcp-crush wrap -- npx -y @modelcontextprotocol/server-github

# Ollama-friendly schema pack (~600 token budget)
npx mcp-crush wrap --ollama-pack -- npx -y @modelcontextprotocol/server-github

# Expose audit/compress/prune as MCP tools
npx mcp-crush --mcp
```

## Ollama / LM Studio

Set `OLLAMA_HOST` (default `http://127.0.0.1:11434`). With `--mcp`, `mcp-crush` probes `n_ctx` and tunes truncation automatically. Use `--ollama-pack` on `wrap` to cap `tools/list` schemas around 600 tokens.

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `audit_mcp_config` | `false` | Parse an MCP configuration file and measure per-server `tools/list` token consumption. |
| `compress_tools_list` | `false` | Minify an MCP `tools/list` JSON payload using description stripping and schema slimming. |
| `prune_json_payload` | `false` | Strip redundant UI metadata (`avatar_url`, `node_id`, HTML fragments) from tool output JSON. |
| `write_compressed_profile` | `true` | Persist a compressed MCP tool profile to disk (requires `--allow-write`). |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

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

### Claude Code CLI

```bash
claude mcp add mcp-crush -- npx -y mcp-crush --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/mcp-crush/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: `--mcp` redirects stray `console.log` to `stderr` so JSON-RPC on `stdout` stays valid.
- **Read-only default**: Mutating tools need `--allow-write`; `--dry-run` blocks writes.
- **Loop breaker**: Identical tool calls halt after three repeats (SHA-256 of name + args).
- **Context budget**: `wrap` / MCP probe `n_ctx` and head/tail-truncate large tool output.
- **Config path sandbox**: `audit_mcp_config` resolves `configPath` under the process cwd.
- **Secret redaction**: AWS keys, bearer tokens, and `sk-*` patterns scrubbed from tool text.

## License

[MIT](./LICENSE)
