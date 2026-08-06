# aspro-mcp

[![npm version](https://img.shields.io/npm/v/aspro-mcp.svg)](https://www.npmjs.com/package/aspro-mcp)
[![npm downloads](https://img.shields.io/npm/dm/aspro-mcp.svg)](https://www.npmjs.com/package/aspro-mcp)
[![install size](https://packagephobia.com/badge?p=aspro-mcp)](https://packagephobia.com/result?p=aspro-mcp)
[![CI](https://github.com/bssth/aspro-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bssth/aspro-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
![MIU](https://img.shields.io/badge/made_in-Ukraine-ffd700?labelColor=0057b7)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [Aspro.Cloud](https://aspro.cloud) REST API to LLM clients (Claude Desktop, Claude Code, etc.). The server ships with the bundled OpenAPI spec, so the model can discover modules, entities and methods on its own and call them safely.

## Features

- **Self-describing.** The model browses the API via `aspro_search` / `aspro_list_*` → `aspro_describe`, and only then calls — no need to memorize endpoints.
- **Keyword search** with Russian inflection handling, so `сделка`, `сделки` and `создать задачу` all land on the right endpoint.
- **Reads and writes are separate tools.** `aspro_call` is read-only and annotated as such; `aspro_write` is annotated destructive, so clients can auto-approve reads without also waving through deletes.
- **Read-only mode** via `ASPRO_READ_ONLY=1` — mutating operations are refused before any request leaves the process.
- **The API key never reaches the model.** It is redacted from every URL and error message the tools return.
- **Response schemas.** `aspro_describe` reports the fields an endpoint returns, not just what it accepts.
- **Form-urlencoded POSTs** by default (Aspro's expected content type), with array and nested-object handling.
- **Per-tenant config** via `ASPRO_COMPANY` (subdomain) or full `ASPRO_BASE_URL`.

## Install

Run it straight from npm — no checkout needed:

```bash
npx -y aspro-mcp
```

Or clone and build:

```bash
git clone https://github.com/bssth/aspro-mcp.git
cd aspro-mcp
npm install
npm run build
```

Requires Node.js ≥ 18.

## Wire it up to a client

### Claude Desktop / Claude Code

Pass the credentials in the `env` block — this is the recommended setup and the only one that works with `npx`:

```json
{
  "mcpServers": {
    "aspro": {
      "command": "npx",
      "args": ["-y", "aspro-mcp"],
      "env": {
        "ASPRO_COMPANY": "your_company",
        "ASPRO_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

For a local checkout, point at the built entry point instead:

```json
{
  "mcpServers": {
    "aspro": {
      "command": "node",
      "args": ["/absolute/path/to/aspro-mcp/dist/index.js"],
      "env": {
        "ASPRO_COMPANY": "your_company",
        "ASPRO_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Other MCP clients

Any client that speaks MCP over stdio can run `npx -y aspro-mcp` (or `node dist/index.js`).

## Configure

Configuration comes from the environment. A local checkout can also use a `.env` file in the package root, which is read regardless of the client's working directory:

```bash
cp .env.example .env
```

```ini
ASPRO_COMPANY=your_company        # the {company} part of https://{company}.aspro.cloud
ASPRO_API_KEY=your_api_key_here   # passed as ?api_key=... on every request
# ASPRO_BASE_URL=...              # optional; overrides the URL built from ASPRO_COMPANY
# ASPRO_TIMEOUT_MS=30000          # optional; default 30s
# ASPRO_READ_ONLY=1               # optional; refuse create/update/delete entirely
# ASPRO_MAX_RESPONSE_CHARS=60000  # optional; cap on a single tool result
```

Under `npx` the package lives in the npm cache, so there is no `.env` to read — use the `env` block shown above. Variables already present in the environment always win over `.env`.

Get an API key in your Aspro.Cloud account under **Settings → Integrations → API**.

Without credentials the server still starts and serves the discovery tools, which work entirely offline from the bundled spec; only the calling tools report the configuration error.

## Tools exposed

| Tool                  | What it does                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `aspro_list_modules`  | List top-level modules (`crm`, `fin`, `task`, …) with entity / operation counts.                       |
| `aspro_list_entities` | List entities inside a module and the methods available on each.                                       |
| `aspro_list_methods`  | List operations (HTTP method + path + short description) for a module, optionally filtered by entity.  |
| `aspro_search`        | Keyword search across module / entity / method / path / description / tags.                            |
| `aspro_describe`      | Full schema for one operation: parameters, body fields, response fields, and whether it mutates data.  |
| `aspro_call`          | Execute a **read** (`list` / `get`). Returns `{ status, ok, url, data }`.                              |
| `aspro_write`         | Execute a **create / update / delete**. Not registered at all when `ASPRO_READ_ONLY` is set.           |

The recommended flow is `search`/`list_*` → `describe` → `call`/`write`.

## Security notes

- **Aspro serves `/delete/{id}` over HTTP GET.** The HTTP verb tells you nothing about whether an operation is destructive, so do not build approval rules around it. This server classifies operations by their method segment and reports that as `mutating`; `aspro_write` carries the destructive annotation and `aspro_call` refuses anything that mutates.
- The API key is read from the environment and appended to every request as `?api_key=...`. It is redacted from the URLs and error messages returned to the model, but it still lives in the client config — never commit `.env`.
- There is no per-endpoint allowlist: once configured, `aspro_write` can reach any mutating endpoint in the spec. Use a dedicated API key with the minimum necessary permissions, and set `ASPRO_READ_ONLY=1` if the model has no business writing.
- Treat tool output as untrusted: Aspro entities (custom field values, descriptions, etc.) may contain user-supplied content.

## Notes on the bundled spec

- The spec documents no query parameters at all, yet `list` endpoints return `{ total, page, count, items }` — paging works, it is simply undocumented. Pass such parameters through `query`.
- Per-account custom fields (`cf_<id>` / `cf_<alias>`) are absent from the spec because they vary per tenant. They still come back in responses and can be sent in `body`.

## Develop

```bash
npm run dev      # tsc --watch
npm run build    # tsc
npm test         # smoke + e2e
```

Neither suite hits the network. `npm run smoke` stubs `fetch` and asserts that the bundled spec parses, that mutating operations are classified correctly (including GET-served deletes), that search finds the expected endpoints, that URLs are built correctly, that the API key never appears in a tool result or error, and that oversized responses are capped. `npm run e2e` starts the built server over stdio with a real MCP client and checks the exposed tools, their annotations, and that `ASPRO_READ_ONLY` actually withholds `aspro_write`.

## Project layout

```
src/
  index.ts    MCP server (tool registration + entry point)
  config.ts   environment loading and validation
  client.ts   HTTP client (URL building, redaction, form-urlencoded POSTs, timeouts, size caps)
  spec.ts     OpenAPI indexer (modules / entities / methods / search / describe)
  smoke.ts    offline unit tests
  e2e.ts      stdio round-trip against a real MCP client
spec/
  openapi.json  bundled Aspro.Cloud OpenAPI spec
```

## Contributing

Issues and PRs welcome. Please run `npm run build && npm run smoke` before submitting.

## License

MIT — see [LICENSE](LICENSE).

`aspro-mcp` is an unofficial third-party connector and is not affiliated with Aspro.Cloud.
