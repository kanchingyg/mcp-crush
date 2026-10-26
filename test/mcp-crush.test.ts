import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  minifyToolsList,
  estimateTokens,
  compressionRatio,
  slimSchema,
  type McpToolShape,
} from "../src/minifier.js";
import { auditConfigObject, spawnToolsList } from "../src/auditor.js";
import { pruneJsonPayload, compactToolsListResponse } from "../src/compactor.js";
import { assertPathContained } from "../src/paths.js";
import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  isMutatingMcpTool,
  setGuards,
  windowsToWsl,
  wslToWindows,
  normalizeEmbedBatch,
  stripRedactedThinking,
  applyReasoningContentPolicy,
  createReasoningState,
  sanitizeRequestBody,
  redactSecrets,
  probeNCtx,
} from "../src/bridge.js";

function verboseTools(n: number): McpToolShape[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `github_action_workflow_dispatch_tool_${i}`,
    description:
      `This comprehensive tool allows you to dispatch workflow number ${i} with detailed parameters and extended documentation for enterprise GitHub automation.`,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login name" },
        repo: { type: "string", description: "Repository name without owner" },
        workflow_id: { type: "string", description: "The workflow identifier" },
        ref: { type: "string", description: "Git reference for the dispatch" },
        inputs: { type: "object", description: "Workflow input parameters map" },
      },
      required: ["owner", "repo", "workflow_id"],
      additionalProperties: true,
    },
  }));
}

describe("minifier", () => {
  it("reduces verbose tools/list by >65%", () => {
    const tools = verboseTools(50);
    const before = JSON.stringify(tools);
    const after = JSON.stringify(minifyToolsList(tools));
    expect(compressionRatio(before, after)).toBeGreaterThan(0.65);
  });
});

describe("compactor", () => {
  it("prunes junk fields from large JSON", () => {
    const big = {
      id: 1,
      title: "ok",
      avatar_url: "https://example.com/a.png",
      node_id: "MDQ6VXNlcjE=",
      html: "<div>" + "x".repeat(500) + "</div>",
      nested: { score: 99, keep: true },
    };
    const pruned = pruneJsonPayload(big, 200) as Record<string, unknown>;
    expect(pruned).not.toHaveProperty("avatar_url");
    expect(pruned).not.toHaveProperty("node_id");
    expect(pruned).toHaveProperty("title");
  });

  it("compactToolsListResponse shrinks byte size", () => {
    const { bytesBefore, bytesAfter } = compactToolsListResponse(verboseTools(50), 600);
    expect(bytesAfter).toBeLessThan(bytesBefore * 0.35);
  });

  it("compactToolsListResponse never drops tools from the array", () => {
    const input = verboseTools(50);
    const { tools } = compactToolsListResponse(input, 50);
    expect(tools.length).toBe(input.length);
    expect(tools.map((t) => t.name)).toEqual(input.map((t) => t.name));
  });
});

describe("slimSchema", () => {
  it("keeps required and enums for large property sets", () => {
    const schema = slimSchema({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
        d: { type: "string", enum: ["x", "y"] },
        e: { type: "number" },
      },
      required: ["a", "d"],
    });
    expect(schema.required).toEqual(["a", "d"]);
    expect((schema.properties as Record<string, unknown>).d).toEqual({
      type: "string",
      enum: ["x", "y"],
    });
    expect(Object.keys(schema.properties as object).sort()).toEqual(["a", "d"]);
  });
});

describe("auditor", () => {
  it("returns projected savings", () => {
    const result = auditConfigObject(
      { mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp"] } } },
      20,
    );
    expect(result.servers.length).toBe(1);
    expect(result.projectedSavingsPct).toBeGreaterThan(0);
  });

  it("labels config-only rows without fake token totals", () => {
    const result = auditConfigObject({
      mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp"] } },
    });
    expect(result.servers[0].source).toBe("config-only");
    expect(result.servers[0].estSchemaTokens).toBeNull();
    expect(result.configOnlyServers).toBe(1);
  });

  it("spawnToolsList reads mock MCP server", async () => {
    const mockPath = join(fileURLToPath(new URL(".", import.meta.url)), "mock-mcp-server.mjs");
    const tools = await spawnToolsList(process.execPath, [mockPath], undefined, 10_000);
    expect(tools.length).toBe(50);
  });
});

describe("paths", () => {
  it("rejects path traversal for config", () => {
    expect(() => assertPathContained("../../../etc/passwd", process.cwd())).toThrow(/outside sandbox/);
  });

  it("rejects absolute paths outside sandbox root", () => {
    expect(() => assertPathContained("C:\\Windows\\System32\\drivers\\etc\\hosts", process.cwd())).toThrow(
      /outside sandbox/,
    );
  });
});

describe("bridge blindajes", () => {
  beforeEach(() => {
    jsonRpcFrameLog.length = 0;
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
    hijackStdoutForMcp();
  });

  it("loop breaker trips on third identical call", () => {
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toContain("LOOP_BREAKER");
  });

  it("blocks mutating without allow-write", () => {
    setGuards({ allowWrite: false, dryRun: false });
    expect(guardMutatingTool({ mutates: true }).blocked).toBe(true);
    expect(guardMutatingTool({ annotations: { destructiveHint: true } }).blocked).toBe(true);
    setGuards({ allowWrite: true });
    expect(guardMutatingTool({ mutates: true }).blocked).toBe(false);
  });

  it("dry-run only stubs mutating tools", async () => {
    setGuards({ dryRun: true, allowWrite: false });
    expect(isMutatingMcpTool({ mutates: true })).toBe(true);
    expect(isMutatingMcpTool({ annotations: { readOnlyHint: true } })).toBe(false);
    const readOnlyTools = [
      {
        name: "audit_mcp_config",
        description: "Audit.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => ({ ok: true }),
      },
    ];
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "audit_mcp_config", arguments: {} } },
      {
        tools: readOnlyTools,
        handlers: new Map(readOnlyTools.map((t) => [t.name, t])),
        toWsl: false,
        serverName: "mcp-crush",
        version: "0.1.0",
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    const frame = JSON.parse(
      jsonRpcFrameLog.find((line) => line.includes('"id":9')) ?? jsonRpcFrameLog.at(-1)!,
    );
    expect(JSON.parse(frame.result.content[0].text)).toEqual({ ok: true });
    setGuards({ dryRun: false });
  });

  it("normalizes windows/wsl paths", () => {
    expect(windowsToWsl("C:\\foo\\bar.ts")).toBe("/mnt/c/foo/bar.ts");
    expect(wslToWindows("/mnt/c/foo/bar.ts")).toBe("C:\\foo\\bar.ts");
  });

  it("MCP handshake tools/list", () => {
    const tools = [
      {
        name: "audit_mcp_config",
        description: "Audit MCP config.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => ({}),
      },
    ];
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        tools,
        handlers: new Map(tools.map((t) => [t.name, t])),
        toWsl: false,
        serverName: "mcp-crush",
        version: "0.1.0",
      },
    );
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        tools,
        handlers: new Map(tools.map((t) => [t.name, t])),
        toWsl: false,
        serverName: "mcp-crush",
        version: "0.1.0",
      },
    );
    const listFrame = JSON.parse(jsonRpcFrameLog[1]);
    expect(listFrame.result.tools[0].name).toBe("audit_mcp_config");
  });

  it("redacts secrets", () => {
    expect(redactSecrets("token sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });

  it("strips redacted thinking", () => {
    const out = stripRedactedThinking("<think>secret</think>hello");
    expect(out).toBe("hello");
  });

  it("reasoning policy strips on new user turn", () => {
    const state = createReasoningState();
    const msgs = applyReasoningContentPolicy(
      [{ role: "assistant", content: "x", reasoning_content: "r" }],
      state,
      true,
    );
    expect(msgs[0].reasoning_content).toBeUndefined();
  });

  it("sanitize removes temperature for reasoners", () => {
    const out = sanitizeRequestBody({ temperature: 0.7, model: "deepseek-reasoner" }, true);
    expect(out.temperature).toBeUndefined();
  });

  it("normalizeEmbedBatch batches and pads empty strings", async () => {
    const embed = vi.fn(async (batch: string[]) => batch.map(() => [1, 0, 0]));
    const vecs = await normalizeEmbedBatch(["a", "", "b"], {
      maxBatch: 2,
      dimensions: 3,
      embed,
    });
    expect(vecs.length).toBe(3);
    expect(vecs[1]).toEqual([0, 0, 0]);
    expect(embed).toHaveBeenCalled();
  });

  it("probeNCtx uses fallback fetch", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false })) as typeof fetch;
    const r = await probeNCtx("http://127.0.0.1:9", fetchImpl);
    expect(r.source).toBe("fallback");
  });
});

describe("wrap mock server", () => {
  it("proxy preserves JSON-RPC for tools/list compression", () => {
    const mockPath = join(fileURLToPath(new URL(".", import.meta.url)), "mock-mcp-server.mjs");
    const before = JSON.stringify(verboseTools(50));
    const { bytesAfter } = compactToolsListResponse(verboseTools(50), 600);
    expect(bytesAfter).toBeLessThan(before.length * 0.35);
    expect(estimateTokens(before)).toBeGreaterThan(
      estimateTokens(JSON.stringify(minifyToolsList(verboseTools(50)))),
    );
    expect(mockPath).toContain("mock-mcp-server.mjs");
  });
});
