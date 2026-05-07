// Offline smoke test: exercises the spec indexer and URL building without
// hitting the network. Run with `npm run smoke` after `npm run build`.
import { SpecIndex } from "./spec.js";
import { AsproClient } from "./client.js";

const spec = SpecIndex.loadDefault();

const modules = spec.listModules();
console.log("modules:", modules.length);
console.log("first 3:", modules.slice(0, 3));

const crmEntities = spec.listEntities("crm");
console.log("\ncrm entities:", crmEntities.length);
console.log("first 3:", crmEntities.slice(0, 3));

const dealCreate = spec.describe("crm", "lead", "create") ?? spec.listMethods("crm")[0];
console.log("\nsample describe:", {
  path: dealCreate.path,
  http: dealCreate.httpMethod,
  bodyProps: dealCreate.bodyProperties.slice(0, 3),
});

const found = spec.search("сделка", 5);
console.log("\nsearch 'сделка':", found.length, "first paths:", found.slice(0, 5).map((o) => o.path));

const client = new AsproClient({
  baseUrl: "https://example.aspro.cloud/api/v1/module",
  apiKey: "TEST_KEY",
  timeoutMs: 5000,
});

// Build a URL for a /get/{id} op without actually calling
const getOp = spec.listMethods("customfields", "fieldsets").find((o) => o.method === "get");
if (getOp) {
  const url = (client as unknown as { buildUrl: (op: unknown, opts: unknown) => string })
    .buildUrl(getOp, { id: 42, query: { extra: "x" } });
  console.log("\nbuilt URL:", url);
}

console.log("\nsmoke OK");
