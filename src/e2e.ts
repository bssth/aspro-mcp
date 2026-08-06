// End-to-end test: starts the built server over stdio with a real MCP client
// and checks what it exposes. No network — no tool that would issue a request
// is called. Run with `npm run e2e` after `npm run build`.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const entry = resolve(dirname(__filename), "index.js");

let passed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function withServer(
  env: Record<string, string>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    // Keep the inherited environment out: these tests depend on exactly the
    // variables they set, and a developer's real .env would skew them.
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "aspro-mcp-e2e", version: "1.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await transport.close();
  }
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

const CONFIGURED = { ASPRO_API_KEY: "test-key", ASPRO_COMPANY: "demo" };

console.log("without credentials");
await check("server starts and still serves discovery", async () => {
  await withServer({ ASPRO_API_KEY: "", ASPRO_COMPANY: "" }, async (client) => {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "aspro_list_modules"));
    const modules = parse(await client.callTool({ name: "aspro_list_modules", arguments: {} }));
    assert.ok(Array.isArray(modules) && modules.length >= 10, "discovery must work offline");
  });
});

await check("calling reports the configuration error", async () => {
  await withServer({ ASPRO_API_KEY: "", ASPRO_COMPANY: "" }, async (client) => {
    const result: any = await client.callTool({
      name: "aspro_call",
      arguments: { module: "crm", entity: "lead", method: "list" },
    });
    assert.equal(result.isError, true, "expected an error result");
    assert.match(parse(result).error, /ASPRO_API_KEY/);
  });
});

console.log("\nconfigured");
await check("tools carry the right annotations", async () => {
  await withServer(CONFIGURED, async (client) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const read = byName.get("aspro_call");
    assert.ok(read, "aspro_call missing");
    assert.equal(read.annotations?.readOnlyHint, true, "aspro_call must be annotated read-only");

    const write = byName.get("aspro_write");
    assert.ok(write, "aspro_write missing");
    assert.equal(write.annotations?.readOnlyHint, false);
    assert.equal(write.annotations?.destructiveHint, true, "aspro_write must be annotated destructive");

    for (const name of ["aspro_search", "aspro_describe", "aspro_list_modules"]) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} should be read-only`);
    }
  });
});

await check("describe exposes response fields and mutation flags", async () => {
  await withServer(CONFIGURED, async (client) => {
    const list = parse(
      await client.callTool({
        name: "aspro_describe",
        arguments: { module: "crm", entity: "lead", method: "list" },
      }),
    );
    assert.equal(list.mutating, false);
    assert.equal(list.callWith, "aspro_call");
    assert.equal(list.paginated, true);
    assert.ok(list.responseFields.length > 5, "list must describe its response fields");
    assert.equal(list.responses, undefined, "raw schema must stay opt-in");

    const raw = parse(
      await client.callTool({
        name: "aspro_describe",
        arguments: {
          module: "crm",
          entity: "lead",
          method: "list",
          include_raw_response_schema: true,
        },
      }),
    );
    assert.ok(raw.responses, "opt-in raw schema missing");
  });
});

await check("a GET-served delete is still routed to aspro_write", async () => {
  await withServer(CONFIGURED, async (client) => {
    const described = parse(
      await client.callTool({
        name: "aspro_describe",
        arguments: { module: "crm", entity: "lead", method: "delete" },
      }),
    );
    assert.equal(described.httpMethod, "get", "spec changed: delete is no longer GET");
    assert.equal(described.mutating, true);
    assert.equal(described.callWith, "aspro_write");

    // The refusal must happen before any request is issued.
    const result: any = await client.callTool({
      name: "aspro_call",
      arguments: { module: "crm", entity: "lead", method: "delete", id: 1 },
    });
    assert.equal(result.isError, true, "aspro_call must refuse a mutating operation");
    assert.match(parse(result).error, /aspro_write/);
  });
});

console.log("\nread-only mode");
await check("ASPRO_READ_ONLY hides the write tool", async () => {
  await withServer({ ...CONFIGURED, ASPRO_READ_ONLY: "1" }, async (client) => {
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => t.name === "aspro_write"), "aspro_write must not be registered");
    assert.ok(tools.some((t) => t.name === "aspro_call"), "reads must stay available");
  });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("failed:", failures.join(", "));
  process.exit(1);
}
console.log("e2e OK");
process.exit(0);
