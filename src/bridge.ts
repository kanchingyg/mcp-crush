#!/usr/bin/env node
import { createHash } from "node:crypto";
import { auditMcpConfig, formatAuditTable } from "./auditor.js";
import { buildCompressProfile, pruneJsonPayload } from "./compactor.js";
import { DEFAULT_N_CTX, headTailTruncate } from "./minifier.js";

export { DEFAULT_N_CTX, headTailTruncate } from "./minifier.js";
export { auditMcpConfig, formatAuditTable, type AuditResult } from "./auditor.js";
export {
  pruneJsonPayload,
  compactToolsListResponse,
  buildCompressProfile,
} from "./compactor.js";

/** Configuration and data shape for `McpToolAnnotations` (mcp tool annotations). */
export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** Configuration and data shape for `McpToolDefinition` (mcp tool definition). */
export type McpToolDefinition<TArgs = Record<string, unknown>, TResult = unknown> = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: McpToolAnnotations;
  mutates?: boolean;
  handler: (
    args: TArgs,
    ctx: { dryRun: boolean; allowWrite: boolean; nCtx: number },
  ) => Promise<TResult> | TResult;
};

let allowWrite = false;
let dryRun = false;
let nCtx = DEFAULT_N_CTX;

/** Executes `setGuards` to set guards in `mcp-crush`. */
export function setGuards(opts: { allowWrite?: boolean; dryRun?: boolean }): void {
  allowWrite = Boolean(opts.allowWrite);
  dryRun = Boolean(opts.dryRun);
}

/** Executes `setNCtx` to set nctx in `mcp-crush`. */
export function setNCtx(value: number): void {
  nCtx = value > 0 ? value : DEFAULT_N_CTX;
}

/** Executes `canonicalizeJson` to canonicalize json in `mcp-crush`. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}

const loopState = { lastHash: "", repeatCount: 0 };

/** Executes `resetLoopBreaker` to reset loop breaker in `mcp-crush`. */
export function resetLoopBreaker(): void {
  loopState.lastHash = "";
  loopState.repeatCount = 0;
}

/** Executes `checkLoopBreaker` to check loop breaker in `mcp-crush`. */
export function checkLoopBreaker(toolName: string, args: unknown): string | null {
  const h = createHash("sha256")
    .update(`${toolName}:${canonicalizeJson(args)}`)
    .digest("hex");
  if (h === loopState.lastHash) loopState.repeatCount++;
  else {
    loopState.lastHash = h;
    loopState.repeatCount = 1;
  }
  if (loopState.repeatCount >= 3) {
    return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
  }
  return null;
}

/** Executes `isMutatingMcpTool` to is mutating mcp tool in `mcp-crush`. */
export function isMutatingMcpTool(
  tool: { mutates?: boolean; annotations?: { destructiveHint?: boolean } } | null | undefined,
): boolean {
  return Boolean(tool?.mutates || tool?.annotations?.destructiveHint);
}

/** Executes `guardMutatingTool` to guard mutating tool in `mcp-crush`. */
export function guardMutatingTool(
  tool: { mutates?: boolean; annotations?: { destructiveHint?: boolean } } | null | undefined,
): { blocked: boolean; reason?: string } {
  if (!isMutatingMcpTool(tool)) return { blocked: false };
  if (dryRun) return { blocked: false };
  if (!allowWrite) {
    return { blocked: true, reason: "Read-only mode: pass --allow-write to enable mutating tools." };
  }
  return { blocked: false };
}

const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;

/** Executes `windowsToWsl` to windows to wsl in `mcp-crush`. */
export function windowsToWsl(p: string): string {
  const m = p.match(WIN_DRIVE_RE);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/** Executes `wslToWindows` to wsl to windows in `mcp-crush`. */
export function wslToWindows(p: string): string {
  const m = p.match(WSL_RE);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

/** Executes `normalizePathsDeep` to normalize paths deep in `mcp-crush`. */
export function normalizePathsDeep<T>(value: T, toWsl: boolean): T {
  if (typeof value === "string") {
    if (toWsl && WIN_DRIVE_RE.test(value)) return windowsToWsl(value) as T;
    if (!toWsl && WSL_RE.test(value)) return wslToWindows(value) as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalizePathsDeep(v, toWsl)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizePathsDeep(v, toWsl);
    return out as T;
  }
  return value;
}

const SECRET_RE =
  /(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|Bearer\s+[a-zA-Z0-9._-]+)/g;

/** Executes `redactSecrets` to redact secrets in `mcp-crush`. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "[REDACTED]");
}

let stdoutHijacked = false;
let jsonRpcWrite: ((line: string) => void) | null = null;

/** Constant `jsonRpcFrameLog` defining json rpc frame log. */
export const jsonRpcFrameLog: string[] = [];

/** Executes `hijackStdoutForMcp` to hijack stdout for mcp in `mcp-crush`. */
export function hijackStdoutForMcp(): void {
  if (stdoutHijacked) return;
  stdoutHijacked = true;
  const native = process.stdout.write.bind(process.stdout);
  jsonRpcWrite = (line: string) => native(line);
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
    if (str.trim().startsWith("{") && str.includes('"jsonrpc"')) {
      return native(chunk as string, ...(args as []));
    }
    process.stderr.write(str);
    return true;
  }) as typeof process.stdout.write;
}

/** Executes `writeJsonRpcFrame` to write json rpc frame in `mcp-crush`. */
export function writeJsonRpcFrame(obj: object): void {
  const line = JSON.stringify(obj) + "\n";
  jsonRpcFrameLog.push(line);
  if (jsonRpcWrite) jsonRpcWrite(line);
  else process.stdout.write(line);
}

/** Configuration and data shape for `NCtxSource` (nctx source). */
export type NCtxSource = "llama.cpp" | "ollama" | "vllm" | "fallback";

/** Executes `probeNCtx` to probe nctx in `mcp-crush`. */
export async function probeNCtx(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ nCtx: number; source: NCtxSource }> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const props = await fetchImpl(`${base}/props`);
    if (props.ok) {
      const j = (await props.json()) as { n_ctx?: number };
      if (j.n_ctx && j.n_ctx > 0) return { nCtx: j.n_ctx, source: "llama.cpp" };
    }
  } catch {
    /* continue */
  }
  try {
    const show = await fetchImpl(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dummy" }),
    });
    if (show.ok) {
      const j = (await show.json()) as { model_info?: Record<string, unknown> };
      for (const [k, v] of Object.entries(j.model_info ?? {})) {
        if (k.includes("context_length") && typeof v === "number" && v > 0) {
          return { nCtx: v, source: "ollama" };
        }
      }
    }
  } catch {
    /* continue */
  }
  try {
    const models = await fetchImpl(`${base}/v1/models`);
    if (models.ok) {
      const j = (await models.json()) as { data?: Array<{ max_model_len?: number }> };
      const len = j.data?.[0]?.max_model_len;
      if (len && len > 0) return { nCtx: len, source: "vllm" };
    }
  } catch {
    /* continue */
  }
  return { nCtx: DEFAULT_N_CTX, source: "fallback" };
}

/** Executes `stripRedactedThinking` to strip redacted thinking in `mcp-crush`. */
export function stripRedactedThinking(text: string): string {
  const open = "<think>";
  const close = "</think>";
  let out = text;
  for (;;) {
    const start = out.indexOf(open);
    if (start < 0) break;
    const end = out.indexOf(close, start);
    if (end < 0) break;
    out = out.slice(0, start) + out.slice(end + close.length);
  }
  return out.trim();
}

/** Configuration and data shape for `ReasoningState` (reasoning state). */
export type ReasoningState = { inToolLoop: boolean };

/** Executes `createReasoningState` to create reasoning state in `mcp-crush`. */
export function createReasoningState(): ReasoningState {
  return { inToolLoop: false };
}

/** Executes `applyReasoningContentPolicy` to apply reasoning content policy in `mcp-crush`. */
export function applyReasoningContentPolicy(
  messages: Array<Record<string, unknown>>,
  state: ReasoningState,
  newUserTurn: boolean,
): Array<Record<string, unknown>> {
  if (newUserTurn) state.inToolLoop = false;
  return messages.map((m) => {
    const out = { ...m };
    if (newUserTurn && m.role === "assistant") delete out.reasoning_content;
    return out;
  });
}

/** Executes `sanitizeRequestBody` to sanitize request body in `mcp-crush`. */
export function sanitizeRequestBody(
  body: Record<string, unknown>,
  reasoner: boolean,
): Record<string, unknown> {
  const out = { ...body };
  if (reasoner) {
    delete out.temperature;
    delete out.top_p;
  }
  return out;
}

/** Executes `l2Normalize` to l2 normalize in `mcp-crush`. */
export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

/** Executes `mrlSlice` to mrl slice in `mcp-crush`. */
export function mrlSlice(vec: number[], dimensions: number): number[] {
  return l2Normalize(vec.slice(0, dimensions));
}

/** Executes `chunkArray` to chunk array in `mcp-crush`. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Executes `normalizeEmbedBatch` to normalize embed batch in `mcp-crush`. */
export async function normalizeEmbedBatch(
  inputs: string[],
  options: {
    dimensions?: number;
    maxBatch: number;
    embed: (batch: string[], dimensions?: number) => Promise<number[][]>;
  },
): Promise<number[][]> {
  const nonEmpty = inputs.map((t, i) => ({ t, i })).filter((x) => x.t.trim().length > 0);
  const batches = chunkArray(nonEmpty, options.maxBatch);
  const vectors = new Map<number, number[]>();
  for (const batch of batches) {
    const texts = batch.map((b) => b.t);
    const got = await options.embed(texts, options.dimensions);
    for (let j = 0; j < batch.length; j++) {
      let vec = got[j] ?? [];
      if (options.dimensions && vec.length >= options.dimensions) {
        vec = mrlSlice(vec, options.dimensions);
      }
      vectors.set(batch[j].i, vec);
    }
  }
  const dim = options.dimensions ?? vectors.values().next().value?.length ?? 0;
  return inputs.map((_, i) => vectors.get(i) ?? new Array(dim).fill(0));
}

function defaultTools(): McpToolDefinition[] {
  return [
    {
      name: "audit_mcp_config",
      description: "Audit MCP config token tax per server.",
      inputSchema: {
        type: "object",
        properties: { configPath: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const result = await auditMcpConfig(args.configPath as string | undefined);
        return { table: formatAuditTable(result), json: result };
      },
    },
    {
      name: "compress_mcp_server",
      description: "Build extreme compression profile for a wrapped MCP cmd.",
      inputSchema: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          maxSchemaTokens: { type: "number" },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: (args) => {
        const profile = buildCompressProfile({
          maxSchemaTokens: args.maxSchemaTokens as number | undefined,
          nCtx,
          ollamaMode: process.env.MCP_CRUSH_OLLAMA === "1",
        });
        return { cmd: args.cmd, profile, hint: "Run: mcp-crush wrap -- " + args.cmd };
      },
    },
    {
      name: "prune_json_payload",
      description: "Prune bloated JSON tool output under maxTokens.",
      inputSchema: {
        type: "object",
        properties: {
          json: { type: "string" },
          maxTokens: { type: "number" },
        },
        required: ["json", "maxTokens"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: (args) => {
        const parsed = JSON.parse(String(args.json));
        const pruned = pruneJsonPayload(parsed, Number(args.maxTokens) || 512);
        return { pruned, text: redactSecrets(JSON.stringify(pruned)) };
      },
    },
  ];
}

/** Configuration and data shape for `McpServerOptions` (mcp server options). */
export type McpServerOptions = {
  tools?: McpToolDefinition[];
  pathToWsl?: boolean;
  name?: string;
  version?: string;
};

/** Executes `startMcpServer` to start mcp server in `mcp-crush`. */
export function startMcpServer(
  metaOrOpts?: { name: string; version: string } | McpServerOptions,
  toolsArg?: McpToolDefinition[],
  options?: { allowWrite?: boolean },
): void {
  hijackStdoutForMcp();
  let tools: McpToolDefinition[];
  let serverName = "mcp-crush";
  let version = "0.1.0";
  let toWsl = process.env.MCP_CRUSH_PATH_WSL === "1";

  if (toolsArg && metaOrOpts && "name" in metaOrOpts && "version" in metaOrOpts) {
    const meta = metaOrOpts as { name: string; version: string };
    serverName = meta.name;
    version = meta.version;
    tools = toolsArg;
    if (options?.allowWrite) setGuards({ allowWrite: true });
  } else {
    const opts = (metaOrOpts ?? {}) as McpServerOptions;
    tools = opts.tools ?? defaultTools();
    serverName = opts.name ?? serverName;
    version = opts.version ?? version;
    toWsl = opts.pathToWsl ?? toWsl;
  }

  const handlers = new Map(tools.map((t) => [t.name, t]));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: {
        jsonrpc?: string;
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      dispatchMcpMessage(msg, { tools, handlers, toWsl, serverName, version });
    }
  });
}

/** Configuration and data shape for `DispatchCtx` (dispatch ctx). */
export type DispatchCtx = {
  tools: McpToolDefinition[];
  handlers: Map<string, McpToolDefinition>;
  toWsl: boolean;
  serverName: string;
  version: string;
};

/** Executes `dispatchMcpMessage` to dispatch mcp message in `mcp-crush`. */
export function dispatchMcpMessage(
  msg: {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  },
  ctx: DispatchCtx,
): void {
  const { id, method, params } = msg;
  if (method === "initialize") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: ctx.serverName, version: ctx.version },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        tools: ctx.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name as string;
    const args = normalizePathsDeep((params?.arguments as Record<string, unknown>) ?? {}, ctx.toWsl);
    const loopErr = checkLoopBreaker(name, args);
    if (loopErr) {
      writeJsonRpcFrame({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: loopErr }], isError: true },
      });
      return;
    }
    const tool = ctx.handlers.get(name);
    const guard = guardMutatingTool(tool);
    if (guard.blocked) {
      writeJsonRpcFrame({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: guard.reason ?? "blocked" }], isError: true },
      });
      return;
    }
    if (dryRun && isMutatingMcpTool(tool)) {
      writeJsonRpcFrame({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: `[dry-run] Would call ${name} with ${canonicalizeJson(args)}` },
          ],
        },
      });
      return;
    }
    void (async () => {
      try {
        const result = tool
          ? await tool.handler(args, { dryRun, allowWrite, nCtx })
          : { error: "unknown tool" };
        let text = redactSecrets(
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
        );
        text = headTailTruncate(text, Math.floor(nCtx * 4 * 0.3));
        text = normalizePathsDeep(text, !ctx.toWsl) as string;
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (e) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: String(e) }], isError: true },
        });
      }
    })();
    return;
  }
  if (id !== undefined) {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}
export type { ServerAuditRow, AuditMeasureSource } from "./auditor.js";
export type { CompressProfile } from "./compactor.js";
export type { McpToolShape } from "./minifier.js";
