# mention-fs

Fast, reusable filesystem mention search extracted from Grok's persistent fuzzy-index design.

`mention-fs` walks a repository once per mention interaction, keeps a Nucleo index alive across incremental queries, and emits ranked snapshots while the walk is still running. Harness adapters decide whether to consume the stream directly or settle it into their native completion contract.

## Install in OMP

Prerequisites: OMP and SSH access to the private GitHub repository. The current plugin package includes a macOS arm64 binary.

```bash
omp plugin install git+ssh://git@github.com/celados/mention-fs.git
```

Restart OMP, then type:

```text
@pack
```

Hidden and ignored files are opt-in:

```text
@!.env
```

The OMP adapter waits for a completed snapshot to preserve ranking accuracy. It restarts the filesystem walk when a new `@` interaction begins, while keystrokes within the same interaction reuse the existing index.

For local development, link the checkout through the same plugin manager:

```bash
omp plugin install /path/to/mention-fs
```

## Architecture

```text
mention-fs-core
  persistent ignore walker + Nucleo matcher
        │ streaming snapshots
        ▼
mention-fs daemon
  JSONL commands and events
        │
        ▼
@celados/mention-fs client
  typed AsyncIterable query API
        │
        ▼
@celados/mention-fs-pi
  Pi autocomplete provider + OMP extension adapter
```

- `crates/mention-fs-core`: reusable Rust search source. Supports query supersession, hidden-mode reindexing, explicit restart, top-k snapshots, and deterministic shutdown.
- `crates/mention-fs-daemon`: long-lived `mention-fs <root>` process using JSONL over stdin/stdout.
- `packages/client`: validates daemon events and exposes streaming, first-snapshot, and complete-snapshot consumption.
- `packages/pi-provider`: intercepts `@` completion and delegates every other completion path to Pi's current provider.
- `extension.ts`: standard OMP plugin entry declared by `package.json#omp.extensions`.

## Protocol

Start the daemon with a fixed search root:

```bash
target/release/mention-fs /path/to/repository
```

Commands are newline-delimited JSON:

```json
{"type":"restart","hidden":false}
{"type":"query","id":1,"pattern":"pack","limit":100}
{"type":"stop"}
```

Events are `snapshot`, `superseded`, or `closed`. A snapshot carries the query ID, ranked matches, current item count, and `done` state.

## Development

```bash
bun install
bun run ready
```

`bun run ready` runs Vite+ formatting, linting and type checks, TypeScript package tests, Rust tests, and workspace builds.

`extension.ts` selects the packaged binary for the current platform. Run `bun run build:binary` before refreshing `bin/mention-fs-darwin-arm64` or adding another platform build.

## Source

The matcher implementation is adapted from [`xai-org/grok-build`](https://github.com/xai-org/grok-build), specifically its `xai-fuzzy-file-search` crate and persistent file-search state model.
