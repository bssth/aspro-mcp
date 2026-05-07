# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-07

### Added
- Initial public release.
- MCP tools: `aspro_list_modules`, `aspro_list_entities`, `aspro_list_methods`, `aspro_search`, `aspro_describe`, `aspro_call`.
- Bundled Aspro.Cloud OpenAPI spec for offline discovery.
- Form-urlencoded POSTs with array / nested-object handling.
- Path-parameter substitution (`/get/{id}`, `/update/{id}`, …).
- Configuration via `ASPRO_COMPANY` or `ASPRO_BASE_URL`, plus `ASPRO_API_KEY`.

[Unreleased]: https://github.com/bssth/aspro-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bssth/aspro-mcp/releases/tag/v0.1.0
