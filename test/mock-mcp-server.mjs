#!/usr/bin/env node
const tools = Array.from({ length: 50 }, (_, i) => ({
  name: `tool_${i}`,
  description: `Verbose tool ${i} `.repeat(20),
  inputSchema: {
    type: "object",
    properties: { x: { type: "string", description: "field ".repeat(10) } },
    required: ["x"],
  },
}));

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mock", version: "0" },
          },
        }) + "\n",
      );
    } else if (msg.method === "tools/list") {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\n",
      );
    } else if (msg.method === "tools/call") {
      const payload = { data: "y".repeat(20000), avatar_url: "http://x", ok: true };
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
        }) + "\n",
      );
    }
  }
});
