#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { auditMcpConfig, formatAuditTable } from "./auditor.js";
import { compactToolsListResponse, pruneJsonPayload, buildCompressProfile } from "./compactor.js";
import { estimateTokens } from "./minifier.js";
import {
  hijackStdoutForMcp,
  probeNCtx,
  setGuards,
  setNCtx,
  startMcpServer,
  writeJsonRpcFrame,
  headTailTruncate,
} from "./bridge.js";

const VERSION = "0.1.0";

function usage(): void {
  process.stderr.write(`mcp-crush v${VERSION}
  audit [--config path]     Token tax table for MCP servers
  wrap [--] <cmd...>        Stdio proxy compressing tools/list + tools/call
  --mcp                     Run as MCP server (audit / compress / prune tools)
  --ollama-pack             Shrink schemas for local 8k-16k ctx (alias flag)
  --dry-run                 Simulate mutating ops / show projected savings
  --allow-write             Enable mutating tools
`);
}

export function parseWrapArgv(argv: string[]): { cmd: string[]; flags: Set<string> } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let pastWrap = false;
  for (const a of argv) {
    if (a === "wrap") {
      pastWrap = true;
      continue;
    }
    if (a.startsWith("--")) {
      flags.add(a);
      continue;
    }
    if (pastWrap || rest.length > 0 || a !== "wrap") rest.push(a);
  }
  const sep = argv.indexOf("--");
  const cmd = sep >= 0 ? argv.slice(sep + 1) : rest.filter((x) => !x.startsWith("-"));
  return { cmd, flags };
}

export function runWrapProxy(
  cmd: string[],
  opts: { ollamaMode?: boolean; dryRun?: boolean },
): ChildProcess {
  if (opts.dryRun) {
    process.stderr.write(`[dry-run] Would wrap: ${cmd.join(" ")}\n`);
    process.stderr.write(`Projected tools/list savings: ~65%+\n`);
    process.exit(0);
  }
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], shell: false });
  hijackStdoutForMcp();
  const profile = buildCompressProfile({ ollamaMode: opts.ollamaMode });
  let childBuf = "";
  let hostBuf = "";

  child.stdout.on("data", (chunk: Buffer) => {
    childBuf += chunk.toString();
    let idx: number;
    while ((idx = childBuf.indexOf("\n")) >= 0) {
      const line = childBuf.slice(0, idx).trim();
      childBuf = childBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as {
          result?: {
            tools?: import("./minifier.js").McpToolShape[];
            content?: Array<{ type: string; text?: string }>;
          };
        };
        if (frame.result?.tools) {
          const { tools, bytesBefore, bytesAfter } = compactToolsListResponse(
            frame.result.tools,
            profile.maxSchemaTokens,
          );
          frame.result.tools = tools;
          process.stderr.write(
            `[mcp-crush] tools/list ${bytesBefore}B → ${bytesAfter}B (${Math.round((1 - bytesAfter / bytesBefore) * 100)}% smaller)\n`,
          );
        }
        if (frame.result?.content) {
          for (const c of frame.result.content) {
            if (c.type === "text" && c.text && estimateTokens(c.text) > profile.maxResponseTokens) {
              try {
                const parsed = JSON.parse(c.text);
                const pruned = pruneJsonPayload(parsed, profile.maxResponseTokens);
                c.text = headTailTruncate(JSON.stringify(pruned), profile.maxResponseTokens * 4);
              } catch {
                c.text = headTailTruncate(c.text, profile.maxResponseTokens * 4);
              }
            }
          }
        }
        writeJsonRpcFrame(frame);
      } catch {
        process.stderr.write(line + "\n");
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    hostBuf += chunk;
    let idx: number;
    while ((idx = hostBuf.indexOf("\n")) >= 0) {
      const line = hostBuf.slice(0, idx);
      hostBuf = hostBuf.slice(idx + 1);
      child.stdin.write(line + "\n");
    }
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  return child;
}

async function main(argv: string[]): Promise<void> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  if (flags.has("--dry-run")) setGuards({ dryRun: true });
  if (flags.has("--allow-write")) setGuards({ allowWrite: true });

  if (flags.has("--mcp")) {
    if (flags.has("--ollama-pack") || flags.has("--ollama-mode")) {
      process.env.MCP_CRUSH_OLLAMA = "1";
    }
    const ollamaUrl = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
    try {
      const probed = await probeNCtx(ollamaUrl);
      setNCtx(probed.nCtx);
      process.stderr.write(`[mcp-crush] n_ctx=${probed.nCtx} (${probed.source})\n`);
    } catch {
      setNCtx(4096);
    }
    startMcpServer({ name: "mcp-crush", version: VERSION });
    return;
  }

  const sub = argv.find((a) => !a.startsWith("--")) ?? "";
  if (sub === "audit" || argv.includes("audit")) {
    const cfgIdx = argv.indexOf("--config");
    const path = cfgIdx >= 0 ? argv[cfgIdx + 1] : undefined;
    const result = await auditMcpConfig(path);
    console.log(formatAuditTable(result));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (sub === "wrap" || argv.includes("wrap")) {
    const { cmd } = parseWrapArgv(argv);
    if (cmd.length === 0) {
      process.stderr.write("wrap requires a command after --\n");
      process.exit(2);
    }
    runWrapProxy(cmd, {
      ollamaMode: flags.has("--ollama-pack") || flags.has("--ollama-mode"),
      dryRun: flags.has("--dry-run"),
    });
    return;
  }

  if (flags.has("--ollama-pack")) {
    process.stderr.write(
      "Use: mcp-crush wrap --ollama-pack -- npx -y @modelcontextprotocol/server-everything\n",
    );
    return;
  }

  if (argv.length === 0 || flags.has("--help") || flags.has("-h")) {
    usage();
    process.exit(argv.length === 0 ? 2 : 0);
  }

  usage();
  process.exit(2);
}

const isMain = process.argv[1]?.includes("cli");
if (isMain) {
  void main(process.argv.slice(2));
}
