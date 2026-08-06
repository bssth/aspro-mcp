# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-06

### Security
- The API key is no longer returned to the model. `aspro_call` used to echo the
  full request URL — including `?api_key=...` — into its result and into error
  messages, putting the key in the conversation transcript and client logs.
- Reads and writes are separate tools with MCP annotations. `aspro_call` is
  read-only, `aspro_write` is marked destructive, so a client can auto-approve
  reads without also approving deletes.
- Added `ASPRO_READ_ONLY`, which refuses mutating operations and stops
  registering `aspro_write` altogether.
- Operations are classified as mutating by their method segment rather than
  their HTTP verb, because Aspro serves `/delete/{id}` over GET.

### Added
- `aspro_describe` now reports `responseFields` (the fields an endpoint
  actually returns), `paginated`, and `mutating`. Response schemas were
  previously parsed and then discarded, leaving all 410 GET operations —
  60% of the API — with an empty description.
- The server instructions now document the query parameters `list` endpoints
  actually accept — `page`, `limit`, `filter[<field>]`, `search` — none of
  which appear in the spec. Verified against a live tenant, along with two
  traps the model must know: unsupported parameters are ignored silently
  rather than rejected, and `total` reports the unfiltered count.
- `ASPRO_MAX_RESPONSE_CHARS` (default 60000) caps a single tool result.
  Paginated payloads shed trailing items and report how many were dropped.
- The server now starts without credentials and serves the offline discovery
  tools; only the calling tools report the configuration error. Previously a
  missing key threw during module import, so the process died before the
  transport connected and clients showed a bare "disconnected".

### Changed
- Search is token-based, with Russian inflection handling, ё/е folding,
  multi-word queries and length-normalized ranking. Substring matching used to
  miss the obvious queries: `сделка` returned nothing while `сделки` worked,
  and any multi-word query returned nothing at all.
- Successful responses are no longer sent twice — the raw body was previously
  returned alongside the parsed JSON.
- The request timeout now covers reading the response body, not just the
  initial connection.
- The smoke test asserts instead of printing; it caught two search ranking
  regressions while it was being written. CI can now actually fail.
- The server version is read from `package.json` instead of being hardcoded.
- Warn on stderr when two spec paths collapse onto the same
  module/entity/method address, which would silently hide an operation.
- Minimum `@modelcontextprotocol/sdk` raised to 1.29.0 for tool annotations.

## [0.1.0] - 2026-05-07

### Added
- Initial public release.
- MCP tools: `aspro_list_modules`, `aspro_list_entities`, `aspro_list_methods`, `aspro_search`, `aspro_describe`, `aspro_call`.
- Bundled Aspro.Cloud OpenAPI spec for offline discovery.
- Form-urlencoded POSTs with array / nested-object handling.
- Path-parameter substitution (`/get/{id}`, `/update/{id}`, …).
- Configuration via `ASPRO_COMPANY` or `ASPRO_BASE_URL`, plus `ASPRO_API_KEY`.

[Unreleased]: https://github.com/bssth/aspro-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bssth/aspro-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bssth/aspro-mcp/releases/tag/v0.1.0
