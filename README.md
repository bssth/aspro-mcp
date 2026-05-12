# aspro-mcp

[![npm version](https://img.shields.io/npm/v/aspro-mcp.svg)](https://www.npmjs.com/package/aspro-mcp)
[![npm downloads](https://img.shields.io/npm/dm/aspro-mcp.svg)](https://www.npmjs.com/package/aspro-mcp)
[![install size](https://packagephobia.com/badge?p=aspro-mcp)](https://packagephobia.com/result?p=aspro-mcp)
[![types](https://img.shields.io/npm/types/aspro-mcp.svg)](https://www.npmjs.com/package/aspro-mcp)
[![CI](https://github.com/bssth/aspro-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bssth/aspro-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
![MIU](https://img.shields.io/badge/made_in-Ukraine-ffd700?labelColor=0057b7)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [Aspro.Cloud](https://aspro.cloud) REST API to LLM clients (Claude Desktop, Claude Code, etc.). The server ships with the bundled OpenAPI spec, so the model can discover modules, entities and methods on its own and call them safely.

## Features

- **Self-describing.** The model browses the API via `aspro_list_modules` → `aspro_list_entities` → `aspro_list_methods` → `aspro_describe`, and only then `aspro_call`s — no need to memorize endpoints.
- **Substring search** across module / entity / method / path / description / tags.
- **Form-urlencoded POSTs** by default (Aspro's expected content type), with array and nested-object handling.
- **Path parameter substitution** for `/get/{id}`, `/update/{id}`, `/delete/{id}` and friends.
- **Per-tenant config** via `ASPRO_COMPANY` (subdomain) or full `ASPRO_BASE_URL`.

## Install

```bash
git clone https://github.com/bssth/aspro-mcp.git
cd aspro-mcp
npm install
npm run build
```

Requires Node.js ≥ 18.

## Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

```ini
ASPRO_COMPANY=your_company        # the {company} part of https://{company}.aspro.cloud
ASPRO_API_KEY=your_api_key_here   # passed as ?api_key=... on every request
# ASPRO_BASE_URL=...              # optional; overrides the URL built from ASPRO_COMPANY
# ASPRO_TIMEOUT_MS=30000          # optional; default 30s
```

Get an API key in your Aspro.Cloud account under **Settings → Integrations → API**.

## Wire it up to a client

### Claude Desktop / Claude Code

Add the server to your MCP config:

```json
{
  "mcpServers": {
    "aspro": {
      "command": "node",
      "args": ["/absolute/path/to/aspro-mcp/dist/index.js"]
    }
  }
}
```

The server reads its `.env` from the project root regardless of the working directory the client launches it in.

### Other MCP clients

Any client that speaks MCP over stdio can run `node dist/index.js` (or `npm start`).

## Tools exposed

| Tool                  | What it does                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `aspro_list_modules`  | List top-level modules (`crm`, `fin`, `task`, …) with entity / operation counts.                        |
| `aspro_list_entities` | List entities inside a module and the methods available on each.                                        |
| `aspro_list_methods`  | List operations (HTTP method + path + short description) for a module, optionally filtered by entity.   |
| `aspro_search`        | Substring search across module / entity / method / path / description / tags.                           |
| `aspro_describe`      | Full schema for one operation: query / path params, body fields with types and descriptions.            |
| `aspro_call`          | Execute the call. Returns `{ status, ok, url, data }`.                                                  |

The recommended flow is `search`/`list_*` → `describe` → `call`.

## Develop

```bash
npm run dev      # tsc --watch
npm run build    # tsc
npm run smoke    # offline: exercises the spec indexer and URL builder
```

The smoke test does not hit the network — it checks that the bundled OpenAPI spec parses, that operations can be described, and that the URL builder produces well-formed URLs.

## Project layout

```
src/
  index.ts    MCP server (tool registration + entry point)
  config.ts   .env loading and validation
  client.ts   HTTP client (URL building, form-urlencoded POSTs, timeouts)
  spec.ts    OpenAPI indexer (modules / entities / methods / search / describe)
  smoke.ts    offline smoke test
spec/
  openapi.json  bundled Aspro.Cloud OpenAPI spec
```

## Security notes

- The API key is read from the environment and appended to every request as `?api_key=...`. Never commit `.env`.
- The server has no allowlist — once configured, it can call any endpoint the spec describes (including destructive ones like `/delete/{id}`). Use a dedicated API key with the minimum necessary permissions.
- Treat tool output as untrusted: Aspro entities (custom field values, descriptions, etc.) may contain user-supplied content.

## Contributing

Issues and PRs welcome. Please run `npm run build && npm run smoke` before submitting.

## License

MIT — see [LICENSE](LICENSE).

`aspro-mcp` is an unofficial third-party connector and is not affiliated with Aspro.Cloud.
