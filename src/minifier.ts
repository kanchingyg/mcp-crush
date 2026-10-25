export const DEFAULT_N_CTX = 4096;
const TRUNC_MARKER = "[…truncated by mcp-crush…]";

export function headTailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.max(0, Math.floor(maxChars * 0.4) - TRUNC_MARKER.length);
  return text.slice(0, headLen) + TRUNC_MARKER + text.slice(-tailLen);
}

export type McpToolShape = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const JUNK_DESC_WORDS =
  /\b(please|note that|this tool|allows you to|enables|comprehensive|detailed)\b/gi;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function minifyDescription(desc: string, maxLen = 80): string {
  let d = desc.replace(JUNK_DESC_WORDS, "").replace(/\s+/g, " ").trim();
  const first = d.split(/[.!?]/)[0]?.trim() ?? d;
  d = first.length > 0 ? first : d;
  if (d.length > maxLen) d = d.slice(0, maxLen - 1) + "…";
  return d;
}

function slimPropertySchema(prop: unknown): Record<string, unknown> {
  if (typeof prop !== "object" || prop === null) return { type: "string" };
  const pv = prop as Record<string, unknown>;
  const out: Record<string, unknown> = { type: pv.type ?? "string" };
  if (Array.isArray(pv.enum)) out.enum = pv.enum;
  if (typeof pv.format === "string") out.format = pv.format;
  return out;
}

export function slimSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const rawProps = schema.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const propCount = rawProps ? Object.keys(rawProps).length : 0;
  const keepAllProps = propCount <= 3;
  const out: Record<string, unknown> = { type: "object" };
  if (rawProps) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      const pv = v as Record<string, unknown>;
      const keep = keepAllProps || required.includes(k) || Array.isArray(pv.enum);
      if (keep) props[k] = slimPropertySchema(v);
    }
    out.properties = props;
  }
  if (required.length) out.required = required;
  const props = out.properties as Record<string, unknown> | undefined;
  if (props && Object.keys(props).length === 0) delete out.properties;
  return out;
}

export function stripToolDescriptions(tools: McpToolShape[]): McpToolShape[] {
  return tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }));
}

export function stripToolSchemaDetail(tools: McpToolShape[]): McpToolShape[] {
  return tools.map((tool) => {
    const schema = (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : undefined;
    const rawProps = schema.properties as Record<string, unknown> | undefined;
    const props: Record<string, unknown> = {};
    if (rawProps && required) {
      for (const key of required) {
        if (key in rawProps) props[key] = slimPropertySchema(rawProps[key]);
      }
    }
    const inputSchema: Record<string, unknown> = { type: "object" };
    if (Object.keys(props).length > 0) inputSchema.properties = props;
    if (required?.length) inputSchema.required = required;
    return { name: tool.name, inputSchema };
  });
}

export function minimalToolSchemas(tools: McpToolShape[]): McpToolShape[] {
  return tools.map((tool) => ({
    name: tool.name,
    inputSchema: { type: "object" },
  }));
}

export function minifyTool(tool: McpToolShape): McpToolShape {
  return {
    name: tool.name,
    inputSchema: slimSchema((tool.inputSchema ?? { type: "object" }) as Record<string, unknown>),
  };
}

export function minifyToolsList(tools: McpToolShape[]): McpToolShape[] {
  return tools.map(minifyTool);
}

export function compressionRatio(before: string, after: string): number {
  if (before.length === 0) return 0;
  return 1 - after.length / before.length;
}
