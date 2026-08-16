# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-08-16

### Added

- A guard against total wipes: a template defining no servers now throws rather than
  emptying a populated `.mcp.json`. Because `merge()` spreads `template.mcpServers`
  unconditionally, a typo'd or missing key arrives as `{}` and previously wrote through
  as "remove everything" — harmless in 1.x, where servers were copied back.
- `build()` returns `removed: string[]`, and a new `removedServers(existing, template)`
  export reports the same set, so callers can react to deletions without scraping logs.

### Changed

- **BREAKING — `.mcp.json.template` is now the sole source of truth for `.mcp.json`.**
  Additions, edits and removals in the template all propagate to the generated
  output. Deleting a server block from the template now removes that server from
  `.mcp.json` on the next build, together with any secret that had been injected
  into it.

### Removed

- **BREAKING — merge-preserving rebuilds.** Servers present in `.mcp.json` but
  absent from the template are no longer carried across rebuilds; they are dropped
  and reported. Previously they were preserved, which made removal via the template
  impossible.

#### Why

Preservation keyed off a single test — "is this server absent from the template?" —
which conflated two different situations and could not tell them apart:

| Server absent from template because… | Intended | Actual (1.x) |
|---|---|---|
| User hand-added it to `.mcp.json` | Keep | Kept |
| User **deleted it from the template** | Drop | Kept |

Consequences in 1.x:

- Deleting a server block from the template was a silent no-op: the build reported
  `✅ No changes` while the server remained in `.mcp.json`. The template could
  claim N servers while the generated file held N+1.
- The stranded entry kept **the key it was generated with**. Because
  `processTemplate()` only resolves `VITE_*` placeholders for servers the template
  still defines, a removed server's secret was never revisited — so clearing the
  variable from `.env` did not clear the baked-in value, and a rotated or revoked
  secret could persist in a file users reasonably assume is regenerated from source.

Making the output an exact mirror of the template removes the ambiguity at its
source rather than working around it: there is no longer a category of server whose
origin the builder has to infer.

#### Migrating from 1.x

If you relied on merge-preserving to run a machine-specific server, move it into
`.mcp.json.template` and supply its value from `.env` via a `VITE_*` placeholder,
or configure it in your MCP client outside the project. Anything left only in
`.mcp.json` is removed on the next build, and a removal is the one change this tool
cannot undo — the dropped server's injected secret exists nowhere else once the write
lands. **`.mcp.json.backup` is not a durable safety net**: it is a single rolling slot,
so the next build that writes anything at all replaces it with the already-pruned
config. If you may need a removed entry back, copy it out of `.mcp.json.backup` before
your next build, or re-fetch the key from its provider.

An alternative design — recording which servers the builder itself generated, so
hand-added ones could still be preserved — was considered and set aside. It kept
the preserve feature at the cost of metadata in the output, a migration step for
the first build after upgrading, and a fallback path when that record was missing
or malformed. Mirroring the template needs none of that.

## [1.0.0] - 2026-06-29

### Added

- Build `.mcp.json` from a committed `.mcp.json.template`, injecting `VITE_*`
  secrets from `.env` and resolving `PROJECT_PATH` at build time.
- Build-time leak guard that refuses to process a template containing raw secrets,
  with matched values redacted in error output.
- Merge-preserving rebuilds, idempotent writes, backup-and-restore on write
  failure, and `MCP_DYNAMIC=false` opt-out.
- `mcp-build` and `mcp-watch` binaries; library API with `/builder`, `/watcher`,
  and `/secrets` subpath exports.
