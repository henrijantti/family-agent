import { createInterface } from "node:readline";

// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). OpenClaw
// starts it on the host and gives the agent only the tools listed here, so
// the agent never gets a shell, a file path of its choosing, or a secret.
// Hand-rolled on purpose: three methods, no extra dependency to audit.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Prop {
  type: "string" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  pattern?: string;
  maxLength?: number;
  items?: Prop;
  properties?: Record<string, Prop>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  input: { properties: Record<string, Prop>; required?: string[] };
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** An error the agent should see as a tool result, not a crash. */
export class ToolError extends Error {}

/** Checks args against the tool's schema. Unknown keys are refused, so a typo can't slip past a guard. */
export function validate(props: Record<string, Prop>, required: string[] = [], args: unknown, at = ""): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ToolError(`${at || "arguments"} must be an object`);
  const a = args as Record<string, unknown>;
  for (const k of required) if (a[k] === undefined || a[k] === null || a[k] === "") throw new ToolError(`missing ${at}${k}`);
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) throw new ToolError(`unknown argument ${at}${k}`);
    if (v === undefined || v === null) continue;
    checkValue(p, v, `${at}${k}`);
  }
  return a;
}

function checkValue(p: Prop, v: unknown, at: string) {
  const ok =
    p.type === "array" ? Array.isArray(v) : p.type === "integer" ? Number.isInteger(v) : p.type === "object" ? typeof v === "object" && !Array.isArray(v) : typeof v === p.type;
  if (!ok) throw new ToolError(`${at} must be ${p.type}`);
  if (typeof v === "string") {
    if (p.maxLength && v.length > p.maxLength) throw new ToolError(`${at} is longer than ${p.maxLength} characters`);
    if (p.enum && !p.enum.includes(v)) throw new ToolError(`${at} must be one of ${p.enum.join(", ")}`);
    if (p.pattern && !new RegExp(p.pattern).test(v)) throw new ToolError(`${at} has the wrong format`);
  }
  if (Array.isArray(v) && p.items) v.forEach((x, i) => checkValue(p.items!, x, `${at}[${i}]`));
  if (p.type === "object" && p.properties) validate(p.properties, p.required, v, `${at}.`);
}

function schema(t: Tool) {
  return { type: "object", properties: t.input.properties, required: t.input.required ?? [], additionalProperties: false };
}

/** Handles one JSON-RPC message; returns the response, or undefined for notifications. */
export async function handle(name: string, tools: Tool[], msg: { id?: number | string; method?: string; params?: any }): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.id === undefined) return undefined; // notifications (initialized, cancelled) need no answer
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name, version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: schema(t) })) });
    case "tools/call": {
      const t = tools.find((x) => x.name === msg.params?.name);
      if (!t) return error(-32602, `unknown tool ${msg.params?.name}`);
      try {
        const args = validate(t.input.properties, t.input.required, msg.params?.arguments ?? {});
        const out = await t.run(args);
        return reply({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 1) }] });
      } catch (e) {
        // Tool errors go back to the agent as text; the server keeps running.
        const text = e instanceof ToolError ? e.message : `failed: ${(e as Error).message}`;
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}

export function serve(name: string, tools: Tool[]) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    const res = await handle(name, tools, msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
  // Logs go to stderr; stdout carries protocol messages only.
  console.log = (...a: unknown[]) => console.error(...a);
}
