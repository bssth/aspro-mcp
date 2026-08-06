// Offline smoke test: asserts the spec indexer, search ranking, URL building
// and response handling behave. No network — fetch is stubbed.
// Run with `npm run smoke` after `npm run build`.
import assert from "node:assert/strict";

import { SpecIndex } from "./spec.js";
import { AsproClient, capResponseSize, redactApiKey, REDACTED } from "./client.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failures.push(name);
      console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

const spec = SpecIndex.loadDefault();
const TEST_KEY = "super-secret-key";
const client = new AsproClient({
  baseUrl: "https://example.aspro.cloud/api/v1/module",
  apiKey: TEST_KEY,
  timeoutMs: 5000,
  readOnly: false,
  maxResponseChars: 60_000,
});

console.log("spec index");
await check("modules are indexed", () => {
  const modules = spec.listModules();
  assert.ok(modules.length >= 10, `expected >= 10 modules, got ${modules.length}`);
  assert.ok(modules.every((m) => m.operationCount > 0));
});

await check("entities and methods resolve", () => {
  const entities = spec.listEntities("crm");
  assert.ok(entities.length > 0, "crm has no entities");
  assert.ok(entities.some((e) => e.entity === "lead"));
  assert.equal(spec.listEntities("no-such-module").length, 0);
});

await check("describe returns a known operation", () => {
  const op = spec.describe("crm", "lead", "create");
  assert.ok(op, "crm/lead/create missing");
  assert.equal(op.httpMethod, "post");
  assert.ok(op.bodyProperties.length > 0, "create has no body properties");
  assert.equal(spec.describe("crm", "lead", "nope"), undefined);
});

console.log("\nmutation classification");
await check("reads are not marked mutating", () => {
  for (const method of ["list", "get"]) {
    const op = spec.describe("crm", "lead", method);
    assert.ok(op, `crm/lead/${method} missing`);
    assert.equal(op.mutating, false, `${method} should be read-only`);
  }
});

await check("delete is mutating even though it is served over GET", () => {
  const op = spec.describe("crm", "lead", "delete");
  assert.ok(op, "crm/lead/delete missing");
  assert.equal(op.httpMethod, "get", "spec changed: delete is no longer GET");
  assert.equal(op.mutating, true, "delete must be classified as mutating");
});

await check("every spec operation is classified", () => {
  let mutating = 0;
  let reads = 0;
  for (const m of spec.listModules()) {
    for (const e of spec.listEntities(m.module)) {
      for (const method of e.methods) {
        const op = spec.describe(m.module, e.entity, method)!;
        if (op.mutating) mutating++;
        else reads++;
      }
    }
  }
  assert.ok(mutating > 0 && reads > 0, `mutating=${mutating} reads=${reads}`);
});

console.log("\nresponse schema extraction");
await check("list operations expose entity fields and pagination", () => {
  const op = spec.describe("crm", "lead", "list")!;
  assert.ok(op.responseFields.length > 5, `expected fields, got ${op.responseFields.length}`);
  assert.ok(op.responseFields.some((f) => f.name === "id"));
  assert.ok(op.responseFields.some((f) => f.description), "fields carry no descriptions");
  assert.equal(op.paginated, true, "list should be paginated");
});

await check("get operations expose entity fields", () => {
  const op = spec.describe("crm", "lead", "get")!;
  assert.ok(op.responseFields.length > 5, `expected fields, got ${op.responseFields.length}`);
  assert.equal(op.paginated, false);
});

console.log("\nsearch");
for (const [query, expectedPath] of [
  ["сделка", "/crm/lead/list"],
  ["сделки", "/crm/lead/list"],
  ["задача", "/task/tasks/list"],
  ["создать задачу", "/task/tasks/create"],
  ["счёт", "/fin/invoice/list"],
  ["timesheet", "/timetracker/timesheets/list"],
] as const) {
  await check(`search("${query}") finds ${expectedPath}`, () => {
    const results = spec.search(query, 10);
    assert.ok(results.length > 0, "no results");
    assert.ok(
      results.some((o) => o.path === expectedPath),
      `top paths: ${results.slice(0, 5).map((o) => o.path).join(", ")}`,
    );
  });
}

await check("search ignores unmatched noise", () => {
  assert.equal(spec.search("zzzznotathing", 10).length, 0);
  assert.equal(spec.search("   ", 10).length, 0);
});

console.log("\nurl building");
await check("path id and query params are substituted", () => {
  const op = spec.describe("customfields", "fieldsets", "get")!;
  const url = (client as unknown as { buildUrl: (op: unknown, opts: unknown) => string }).buildUrl(op, {
    id: 42,
    query: { extra: "x" },
  });
  assert.ok(url.startsWith("https://example.aspro.cloud/api/v1/module/customfields/fieldsets/get/42?"));
  assert.ok(url.includes(`api_key=${TEST_KEY}`), "api_key must be sent to the API");
  assert.ok(url.includes("extra=x"));
});

await check("missing path parameter is rejected", () => {
  const op = spec.describe("crm", "lead", "get")!;
  assert.throws(
    () => (client as unknown as { buildUrl: (op: unknown, opts: unknown) => string }).buildUrl(op, {}),
    /Missing path parameter/,
  );
});

console.log("\nsecret redaction");
await check("redactApiKey strips the key", () => {
  const redacted = redactApiKey(`https://x/y?api_key=${TEST_KEY}&page=2`);
  assert.ok(!redacted.includes(TEST_KEY), "key survived redaction");
  assert.ok(redacted.includes(REDACTED));
  assert.ok(redacted.includes("page=2"), "other params must survive");
});

await check("call() never returns the api key", async () => {
  const realFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: any) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ response: { id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const op = spec.describe("crm", "lead", "get")!;
    const result = await client.call(op, { id: 7 });
    assert.ok(requestedUrl.includes(TEST_KEY), "the real request must carry the key");
    assert.ok(!JSON.stringify(result).includes(TEST_KEY), "api key leaked into the tool result");
    assert.ok(result.url.includes(REDACTED));
    assert.deepEqual(result.data, { response: { id: 1 } });
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("network errors do not leak the api key", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  try {
    const op = spec.describe("crm", "lead", "get")!;
    await assert.rejects(client.call(op, { id: 7 }), (err: Error) => {
      assert.ok(!err.message.includes(TEST_KEY), "api key leaked into the error message");
      assert.ok(err.message.includes(REDACTED));
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log("\nresponse capping");
await check("oversized paginated payloads drop items", () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: "x".repeat(200) }));
  const { value, truncated } = capResponseSize({ response: { total: 500, items } }, 5_000);
  assert.ok(truncated, "expected truncation");
  const kept = (value as any).response.items.length;
  assert.ok(kept > 0 && kept < 500, `kept ${kept}`);
  assert.equal(truncated.totalItems, 500);
  assert.ok(JSON.stringify(value).length <= 5_000);
});

await check("oversized non-paginated payloads are cut", () => {
  const { value, truncated } = capResponseSize({ blob: "y".repeat(20_000) }, 1_000);
  assert.ok(truncated, "expected truncation");
  assert.ok(typeof value === "string" && value.length <= 1_001);
});

await check("payloads within the cap pass through untouched", () => {
  const data = { response: { items: [{ id: 1 }] } };
  const { value, truncated } = capResponseSize(data, 60_000);
  assert.equal(truncated, undefined);
  assert.equal(value, data);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("failed:", failures.join(", "));
  process.exit(1);
}
console.log("smoke OK");
