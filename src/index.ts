#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { AsproClient, type CallOptions } from "./client.js";
import { SpecIndex, type OperationSpec } from "./spec.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const configResult = loadConfig();
const spec = SpecIndex.loadDefault();
// Discovery works offline, so the server still starts without credentials —
// only the calling tools report the configuration error.
const client = configResult.ok ? new AsproClient(configResult.config) : null;
const readOnly = configResult.ok && configResult.config.readOnly;

if (!configResult.ok) {
  console.error(`aspro-mcp: ${configResult.error} Discovery tools remain available.`);
}

const server = new McpServer(
  { name: "aspro-mcp", version },
  {
    capabilities: { tools: {} },
    instructions:
      "Aspro.Cloud REST API connector. Discover endpoints with aspro_search / aspro_list_modules / " +
      "aspro_list_entities / aspro_list_methods, read the schema with aspro_describe, then execute: " +
      "aspro_call for reads (list/get) and aspro_write for creates, updates and deletes.\n" +
      "Endpoint URLs follow /{module}/{entity}/{method}[/{id}]; POSTs use form-urlencoded.\n" +
      "Note that Aspro exposes /delete/{id} over HTTP GET — the HTTP verb does not indicate whether " +
      "an operation is destructive. Use the `mutating` flag from aspro_describe instead.\n" +
      "The bundled spec documents no query parameters, but list endpoints accept these (verified " +
      "against a live tenant, pass them through `query`):\n" +
      "  page=N               — 1-based page number.\n" +
      "  limit=N              — shrinks the page; a page holds at most 25 items regardless.\n" +
      "  filter[<field>]=v    — exact match on a response field, e.g. filter[id]=193.\n" +
      "  search=<text>        — full-text search across the entity.\n" +
      "Two traps: unknown or unsupported query parameters are ignored silently rather than " +
      "rejected, so never assume a filter applied — verify it against the returned items. And " +
      "`total` in the response reports the unfiltered count, so it does not tell you how many rows " +
      "matched. No sort parameter was found to work.\n" +
      "Per-account custom fields (cf_<id> / cf_<alias>) are not in the spec because they differ per " +
      "tenant; they can still be read from responses and sent in `body`.",
  },
);

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function asJson(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function summarizeOp(op: OperationSpec) {
  return {
    module: op.module,
    entity: op.entity,
    method: op.method,
    httpMethod: op.httpMethod,
    path: op.path,
    description: op.description,
    mutating: op.mutating,
  };
}

server.registerTool(
  "aspro_list_modules",
  {
    description:
      "List all top-level Aspro.Cloud API modules (crm, fin, agile, task, etc.) with entity and operation counts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => asJson(spec.listModules()),
);

server.registerTool(
  "aspro_list_entities",
  {
    description:
      "List entities inside a given module along with the methods available on each entity.",
    inputSchema: {
      module: z.string().describe("Module name, e.g. 'crm', 'fin', 'task'."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ module }) => {
    const entities = spec.listEntities(module);
    if (entities.length === 0) {
      return asJson(
        { error: `Unknown module "${module}". Call aspro_list_modules to see all options.` },
        true,
      );
    }
    return asJson({ module, entities });
  },
);

server.registerTool(
  "aspro_list_methods",
  {
    description:
      "List operations (HTTP method + path + short description) for a given module and optional entity.",
    inputSchema: {
      module: z.string().describe("Module name."),
      entity: z
        .string()
        .optional()
        .describe("Entity name. Omit to list operations across all entities of the module."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ module, entity }) => {
    const ops = spec.listMethods(module, entity);
    if (ops.length === 0) {
      return asJson(
        { error: `No operations found for module="${module}"${entity ? `, entity="${entity}"` : ""}.` },
        true,
      );
    }
    return asJson({ count: ops.length, operations: ops.map(summarizeOp) });
  },
);

server.registerTool(
  "aspro_search",
  {
    description:
      "Search operations by keyword across module/entity/method/path/description/tags. " +
      "Handles Russian inflection and multi-word queries ('создать задачу', 'сделки').",
    inputSchema: {
      query: z.string().min(1).describe("Keywords to search for, case-insensitive."),
      limit: z.number().int().positive().max(200).optional().describe("Max results (default 30)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, limit }) => {
    const ops = spec.search(query, limit ?? 30);
    return asJson({ count: ops.length, operations: ops.map(summarizeOp) });
  },
);

server.registerTool(
  "aspro_describe",
  {
    description:
      "Return the full schema for one operation: HTTP method, path, whether it mutates data, " +
      "request-body fields and the fields present in the response.",
    inputSchema: {
      module: z.string(),
      entity: z.string(),
      method: z.string().describe("Method segment, e.g. 'list', 'get', 'create', 'update', 'delete'."),
      include_raw_response_schema: z
        .boolean()
        .optional()
        .describe("Include the untrimmed OpenAPI response schema. Verbose; off by default."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ module, entity, method, include_raw_response_schema }) => {
    const op = spec.describe(module, entity, method);
    if (!op) {
      return asJson(
        { error: `No operation ${module}/${entity}/${method}. Use aspro_list_methods to discover.` },
        true,
      );
    }
    return asJson({
      module: op.module,
      entity: op.entity,
      method: op.method,
      httpMethod: op.httpMethod,
      path: op.path,
      description: op.description,
      tags: op.tags,
      mutating: op.mutating,
      callWith: op.mutating ? "aspro_write" : "aspro_call",
      parameters: op.parameters,
      bodyContentType: op.bodyContentType,
      bodyRequired: op.bodyRequired,
      bodyProperties: op.bodyProperties,
      paginated: op.paginated,
      responseFields: op.responseFields,
      ...(include_raw_response_schema ? { responses: op.responses } : {}),
    });
  },
);

const callInputSchema = {
  module: z.string(),
  entity: z.string(),
  method: z.string(),
  id: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Path id, when the operation path contains {id}."),
  query: z
    .record(z.unknown())
    .optional()
    .describe("Query string parameters. Do not include api_key — it is added automatically."),
  body: z
    .record(z.unknown())
    .optional()
    .describe("Form-urlencoded body fields for POST operations."),
};

interface CallArgs extends CallOptions {
  module: string;
  entity: string;
  method: string;
}

async function execute(args: CallArgs, expectMutating: boolean): Promise<ToolResult> {
  const { module, entity, method, id, query, body } = args;
  const op = spec.describe(module, entity, method);
  if (!op) {
    return asJson(
      { error: `No operation ${module}/${entity}/${method}. Use aspro_list_methods or aspro_search.` },
      true,
    );
  }

  if (op.mutating !== expectMutating) {
    const correct = op.mutating ? "aspro_write" : "aspro_call";
    return asJson(
      {
        error:
          `${module}/${entity}/${method} is ${op.mutating ? "a mutating" : "a read-only"} operation ` +
          `(HTTP ${op.httpMethod.toUpperCase()}). Call it with ${correct} instead.`,
      },
      true,
    );
  }

  if (op.mutating && readOnly) {
    return asJson(
      { error: `Refused: ASPRO_READ_ONLY is set and ${module}/${entity}/${method} modifies data.` },
      true,
    );
  }

  if (!client) {
    return asJson({ error: configResult.ok ? "Client unavailable." : configResult.error }, true);
  }

  try {
    return asJson(await client.call(op, { id, query, body }));
  } catch (err) {
    return asJson({ error: err instanceof Error ? err.message : String(err) }, true);
  }
}

server.registerTool(
  "aspro_call",
  {
    description:
      "Read data from Aspro.Cloud — the `list` and `get` methods only. Run aspro_describe first to " +
      "learn the parameter shape. Pass the entity id via `id`, query-string args via `query`. " +
      "Returns { status, ok, url, data }. Use aspro_write for create/update/delete.",
    inputSchema: callInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => execute(args as CallArgs, false),
);

if (!readOnly) {
  server.registerTool(
    "aspro_write",
    {
      description:
        "Create, update or DELETE data in Aspro.Cloud. Destructive — the change is applied to the " +
        "live account and cannot be undone from here. Run aspro_describe first. Pass the entity id " +
        "via `id` and body fields via `body`. Note that delete is served over HTTP GET.",
      inputSchema: callInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => execute(args as CallArgs, true),
  );
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive; the SDK manages stdio lifetime.
}

main().catch((err) => {
  // Errors must go to stderr — stdout is the MCP transport.
  console.error("aspro-mcp fatal:", err);
  process.exit(1);
});
