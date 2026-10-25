# mcp-crush

[![ci](https://github.com/kanchingyg/mcp-crush/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/mcp-crush/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-crush)](https://www.npmjs.com/package/mcp-crush)
[![JSR](https://jsr.io/badges/@kanchingyg/mcp-crush)](https://jsr.io/@kanchingyg/mcp-crush)
[![Bun](https://img.shields.io/badge/runtime-Node_%7C_Bun-f9f1e1)](https://github.com/kanchingyg/mcp-crush)
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

## Production guards

Built into `src/bridge.ts`:

1. Read-only default, `--dry-run`, and loop breaker on repeated identical tool calls
2. `n_ctx` probe + head/tail truncation + recency-friendly output budgets
3. Embedding batch normalizer (empty string filter, MRL slice, L2 norm)
4. MCP stdio stdout guard + Windows/WSL path normalization
5. Reasoning-model quirks (`reasoning_content`, strip thinking blocks, omit `temperature` on reasoners)

## License

[MIT](./LICENSE)
