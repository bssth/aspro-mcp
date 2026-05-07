#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { AsproClient } from "./client.js";
import { SpecIndex, type OperationSpec } from "./spec.js";

const config = loadConfig();
const spec = SpecIndex.loadDefault();
const client = new AsproClient(config);

const server = new McpServer(
  { name: "aspro-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Aspro.Cloud REST API connector. Use aspro_list_modules / aspro_list_entities / " +
      "aspro_list_methods / aspro_search to discover endpoints, aspro_describe to get the " +
      "parameter and body schema for one method, then aspro_call to execute it. " +
      "Endpoint URLs follow /{module}/{entity}/{method}[/{id}], POSTs use form-urlencoded.",
  },
);

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
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
  };
}

server.registerTool(
  "aspro_list_modules",
  {
    description:
      "List all top-level Aspro.Cloud API modules (crm, fin, agile, task, etc.) with entity and operation counts.",
    inputSchema: {},
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
  },
  async ({ module }) => {
    const entities = spec.listEntities(module);
    if (entities.length === 0) {
      return asJson({
        error: `Unknown module "${module}". Call aspro_list_modules to see all options.`,
      });
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
  },
  async ({ module, entity }) => {
    const ops = spec.listMethods(module, entity);
    if (ops.length === 0) {
      return asJson({
        error: `No operations found for module="${module}"${entity ? `, entity="${entity}"` : ""}.`,
      });
    }
    return asJson({ count: ops.length, operations: ops.map(summarizeOp) });
  },
);

server.registerTool(
  "aspro_search",
  {
    description:
      "Substring search across module/entity/method/path/description/tags. Useful when you don't know the exact module or entity name.",
    inputSchema: {
      query: z.string().min(1).describe("Substring to search for, case-insensitive."),
      limit: z.number().int().positive().max(200).optional().describe("Max results (default 30)."),
    },
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
      "Return the full schema for one operation: HTTP method, path, query/path parameters, request-body fields with types and descriptions.",
    inputSchema: {
      module: z.string(),
      entity: z.string(),
      method: z.string().describe("Method segment, e.g. 'list', 'get', 'create', 'update', 'delete'."),
    },
  },
  async ({ module, entity, method }) => {
    const op = spec.describe(module, entity, method);
    if (!op) {
      return asJson({
        error: `No operation ${module}/${entity}/${method}. Use aspro_list_methods to discover.`,
      });
    }
    return asJson({
      module: op.module,
      entity: op.entity,
      method: op.method,
      httpMethod: op.httpMethod,
      path: op.path,
      description: op.description,
      tags: op.tags,
      parameters: op.parameters,
      bodyContentType: op.bodyContentType,
      bodyRequired: op.bodyRequired,
      bodyProperties: op.bodyProperties,
    });
  },
);

server.registerTool(
  "aspro_call",
  {
    description:
      "Call an Aspro.Cloud endpoint. Always run aspro_describe first to learn the parameter shape. " +
      "Pass entity id (for /get/{id}, /update/{id}, /delete/{id}) via `id`. " +
      "Pass query-string args via `query`, request-body fields via `body` (POST only). " +
      "Returns { status, ok, url, data }.",
    inputSchema: {
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
    },
  },
  async ({ module, entity, method, id, query, body }) => {
    const op = spec.describe(module, entity, method);
    if (!op) {
      return asJson({
        error: `No operation ${module}/${entity}/${method}. Use aspro_list_methods or aspro_search.`,
      });
    }
    try {
      const result = await client.call(op, { id, query, body });
      return asJson(result);
    } catch (err) {
      return asJson({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

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
