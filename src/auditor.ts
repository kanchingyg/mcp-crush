import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { estimateTokens, minifyToolsList, type McpToolShape } from "./minifier.js";
import { resolveMcpConfigPath } from "./paths.js";

export type AuditMeasureSource = "live-tools/list" | "config-only";

export type ServerAuditRow = {
  server: string;
  command: string;
  source: AuditMeasureSource;
  estSchemaTokens: number | null;
  estUsd: number | null;
  toolCount?: number;
  note?: string;
};

export type AuditResult = {
  servers: ServerAuditRow[];
  totalTokens: number;
  totalUsd: number;
  projectedSavingsPct: number;
  configOnlyServers: number;
};

const USD_PER_MTOK = 3;
const DEFAULT_SPAWN_TIMEOUT_MS = 8_000;

type McpConfig = {
  mcpServers?: Record<
    string,
    { command?: string; args?: string[]; url?: string; env?: Record<string, string> }
  >;
};

function parseConfig(raw: string): McpConfig {
  return JSON.parse(raw) as McpConfig;
}

function measureTools(tools: McpToolShape[]): {
  estSchemaTokens: number;
  projectedSavingsPct: number;
} {
  const rawJson = JSON.stringify(tools);
  const minJson = JSON.stringify(minifyToolsList(tools));
  const estSchemaTokens = estimateTokens(rawJson);
  const minTokens = estimateTokens(minJson);
  const projectedSavingsPct =
    estSchemaTokens > 0 ? Math.round((1 - minTokens / estSchemaTokens) * 100) : 0;
  return { estSchemaTokens, projectedSavingsPct };
}

function configOnlyRow(
  name: string,
  cmd: string,
  note: string,
): ServerAuditRow {
  return {
    server: name,
    command: cmd,
    source: "config-only",
    estSchemaTokens: null,
    estUsd: null,
    note,
  };
}

export function auditConfigObject(config: McpConfig, mockToolsPerServer = 0): AuditResult {
  const servers: ServerAuditRow[] = [];
  let totalTokens = 0;
  let totalMinTokens = 0;
  let configOnlyServers = 0;

  for (const [name, srv] of Object.entries(config.mcpServers ?? {})) {
    const cmd = [srv.command, ...(srv.args ?? [])].filter(Boolean).join(" ");
    const displayCmd = cmd || srv.url || "(http)";

    if (mockToolsPerServer > 0) {
      const placeholderTools: McpToolShape[] = Array.from({ length: mockToolsPerServer }, (_, i) => ({
        name: `tool_${i}`,
        description: `Verbose placeholder tool number ${i} with extended documentation.`,
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Identifier field" },
            payload: { type: "string", description: "Large payload" },
          },
          required: ["id"],
        },
      }));
      const { estSchemaTokens } = measureTools(placeholderTools);
      const minJson = JSON.stringify(minifyToolsList(placeholderTools));
      const minTokens = estimateTokens(minJson);
      totalTokens += estSchemaTokens;
      totalMinTokens += minTokens;
      servers.push({
        server: name,
        command: displayCmd,
        source: "live-tools/list",
        estSchemaTokens,
        estUsd: Math.round(((estSchemaTokens / 1_000_000) * USD_PER_MTOK) * 1000) / 1000,
        toolCount: mockToolsPerServer,
        note: "test fixtures",
      });
      continue;
    }

    configOnlyServers++;
    servers.push(
      configOnlyRow(
        name,
        displayCmd,
        srv.url
          ? "HTTP/SSE server — config-only (stdio tools/list not available)"
          : "config-only estimate — spawn tools/list to measure",
      ),
    );
  }

  const projectedSavingsPct =
    totalTokens > 0 ? Math.round((1 - totalMinTokens / totalTokens) * 100) : 0;

  return {
    servers,
    totalTokens,
    totalUsd: Math.round(((totalTokens / 1_000_000) * USD_PER_MTOK) * 100) / 100,
    projectedSavingsPct,
    configOnlyServers,
  };
}

export async function spawnToolsList(
  command: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
): Promise<McpToolShape[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, ...env },
    });

    let buf = "";
    let settled = false;
    let listId: number | null = null;

    const finish = (err: Error | null, tools?: McpToolShape[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(tools ?? []);
    };

    const timer = setTimeout(
      () => finish(new Error(`tools/list timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const send = (frame: object) => {
      child.stdin.write(JSON.stringify(frame) + "\n");
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: { tools?: McpToolShape[] };
            error?: { message?: string };
          };
          if (msg.error) {
            finish(new Error(msg.error.message ?? "MCP error"));
            return;
          }
          if (listId !== null && msg.id === listId && msg.result?.tools) {
            finish(null, msg.result.tools);
            return;
          }
        } catch {
          /* ignore partial / non-json noise */
        }
      }
    });

    child.stderr.on("data", () => {
      /* stderr is expected for many MCP servers */
    });

    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`MCP process exited (${code ?? "signal"}) before tools/list`));
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-crush-audit", version: "0.1.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    listId = 2;
    send({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} });
  });
}

export async function auditMcpConfig(
  configPath?: string,
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<AuditResult> {
  const root = opts?.cwd ?? process.cwd();
  const path = resolveMcpConfigPath(configPath, root);

  if (!existsSync(path)) {
    return {
      servers: [],
      totalTokens: 0,
      totalUsd: 0,
      projectedSavingsPct: 0,
      configOnlyServers: 0,
    };
  }

  const config = parseConfig(readFileSync(path, "utf8"));
  const servers: ServerAuditRow[] = [];
  let totalTokens = 0;
  let totalMinTokens = 0;
  let configOnlyServers = 0;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;

  for (const [name, srv] of Object.entries(config.mcpServers ?? {})) {
    const cmd = [srv.command, ...(srv.args ?? [])].filter(Boolean).join(" ");
    const displayCmd = cmd || srv.url || "(http)";

    if (srv.url && !srv.command) {
      configOnlyServers++;
      servers.push(
        configOnlyRow(name, displayCmd, "HTTP/SSE server — config-only (stdio tools/list not available)"),
      );
      continue;
    }

    if (!srv.command) {
      configOnlyServers++;
      servers.push(configOnlyRow(name, displayCmd, "config-only — missing command"));
      continue;
    }

    try {
      const tools = await spawnToolsList(srv.command, srv.args ?? [], srv.env, timeoutMs);
      const { estSchemaTokens } = measureTools(tools);
      const minTokens = estimateTokens(JSON.stringify(minifyToolsList(tools)));
      totalTokens += estSchemaTokens;
      totalMinTokens += minTokens;
      servers.push({
        server: name,
        command: displayCmd,
        source: "live-tools/list",
        estSchemaTokens,
        estUsd: Math.round(((estSchemaTokens / 1_000_000) * USD_PER_MTOK) * 1000) / 1000,
        toolCount: tools.length,
      });
    } catch (e) {
      configOnlyServers++;
      const msg = e instanceof Error ? e.message : String(e);
      servers.push(
        configOnlyRow(
          name,
          displayCmd,
          `config-only — tools/list spawn failed: ${msg}`,
        ),
      );
    }
  }

  const projectedSavingsPct =
    totalTokens > 0 ? Math.round((1 - totalMinTokens / totalTokens) * 100) : 0;

  return {
    servers,
    totalTokens,
    totalUsd: Math.round(((totalTokens / 1_000_000) * USD_PER_MTOK) * 100) / 100,
    projectedSavingsPct,
    configOnlyServers,
  };
}

export function formatAuditTable(result: AuditResult): string {
  const lines = [
    "Server | Command | Source | Est.Tokens | Est.USD | Note",
    "---|---|---|---|---|---",
  ];
  for (const r of result.servers) {
    const tokens = r.estSchemaTokens === null ? "—" : String(r.estSchemaTokens);
    const usd = r.estUsd === null ? "—" : `$${r.estUsd}`;
    const note = r.note ?? "";
    lines.push(
      `${r.server} | ${r.command.slice(0, 32)} | ${r.source} | ${tokens} | ${usd} | ${note.slice(0, 48)}`,
    );
  }
  lines.push(`**Total (live measured)** | | | ${result.totalTokens} | $${result.totalUsd}`);
  if (result.configOnlyServers > 0) {
    lines.push(
      `Config-only rows: ${result.configOnlyServers} (not included in token totals — spawn tools/list or fix server)`,
    );
  }
  lines.push(`Projected minify savings (live rows): ~${result.projectedSavingsPct}%`);
  return lines.join("\n");
}
