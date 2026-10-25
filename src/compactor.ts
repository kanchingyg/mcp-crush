import {
  estimateTokens,
  minifyToolsList,
  stripToolDescriptions,
  stripToolSchemaDetail,
  minimalToolSchemas,
  headTailTruncate,
  DEFAULT_N_CTX,
  type McpToolShape,
} from "./minifier.js";

const JUNK_KEYS = new Set([
  "avatar_url",
  "avatarUrl",
  "node_id",
  "nodeId",
  "html",
  "raw_html",
  "icon_url",
  "gravatar_id",
  "score",
  "reactions",
]);

const HTML_RE = /<[^>]+>/g;

export function pruneValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth-cap]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (HTML_RE.test(value) && value.length > 200) {
      return value.replace(HTML_RE, " ").replace(/\s+/g, " ").trim().slice(0, 120) + "…";
    }
    if (value.length > 2000) return headTailTruncate(value, 800);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) {
      return [...value.slice(0, 25).map((v) => pruneValue(v, depth + 1)), "[…truncated]"];
    }
    return value.map((v) => pruneValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (JUNK_KEYS.has(k)) continue;
      out[k] = pruneValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function pruneJsonPayload(json: unknown, maxTokens: number): unknown {
  let pruned = pruneValue(json);
  let text = JSON.stringify(pruned);
  while (estimateTokens(text) > maxTokens && text.length > 100) {
    pruned = pruneValue(pruned);
    text = headTailTruncate(text, Math.floor(maxTokens * 3.5));
    try {
      pruned = JSON.parse(text);
    } catch {
      break;
    }
  }
  return pruned;
}

const COMPACT_STRIP_STAGES: Array<(tools: McpToolShape[]) => McpToolShape[]> = [
  stripToolDescriptions,
  stripToolSchemaDetail,
  minimalToolSchemas,
];

export function compactToolsListResponse(
  tools: McpToolShape[],
  maxSchemaTokens?: number,
): { tools: McpToolShape[]; bytesBefore: number; bytesAfter: number } {
  const before = JSON.stringify(tools);
  const toolCount = tools.length;
  let minified = minifyToolsList(tools);

  if (maxSchemaTokens) {
    for (const stage of COMPACT_STRIP_STAGES) {
      if (estimateTokens(JSON.stringify(minified)) <= maxSchemaTokens) break;
      minified = stage(minified);
    }
  }

  if (minified.length !== toolCount) {
    throw new Error(`compactToolsListResponse dropped tools (${toolCount} → ${minified.length})`);
  }

  const after = JSON.stringify(minified);
  return { tools: minified, bytesBefore: before.length, bytesAfter: after.length };
}

export function defaultMaxSchemaTokens(nCtx = DEFAULT_N_CTX): number {
  return Math.min(600, Math.floor(nCtx * 0.08));
}

export type CompressProfile = {
  maxSchemaTokens: number;
  maxResponseTokens: number;
  ollamaMode: boolean;
};

export function buildCompressProfile(opts: {
  maxSchemaTokens?: number;
  nCtx?: number;
  ollamaMode?: boolean;
}): CompressProfile {
  const nCtx = opts.nCtx ?? DEFAULT_N_CTX;
  return {
    maxSchemaTokens: opts.maxSchemaTokens ?? defaultMaxSchemaTokens(nCtx),
    maxResponseTokens: Math.floor(nCtx * 0.25),
    ollamaMode: Boolean(opts.ollamaMode),
  };
}
