# Repository Guidelines

## Project Overview

`fast-topo-router` — a deterministic, type-safe context routing gateway for terminal AI agents (Claude Code, Omp, Codex). Two-phase pre-ingestion pipeline: topology-driven pruning of workspace entropy, then strongly-typed tactical routing via a fast decision model. Currently a scaffold: abstract framework only, no concrete compactor/router implementations yet.

Design baseline lives in `documents/blueprint.md` (canonical). All design docs go in `documents/`, not `docs/`.

## Architecture & Data Flow

```
entities ──► TopoCompactor.compact() ──► CompactedGraph ──► TopoDecisionRouter.route() ──► decision
                                              │
                                              └─► verbatimPayload ──► contextForFrontierLLM
```

- `src/core/compactor.ts` — `TopoNode`, `CompactedGraph` (nodes + directed edges + `verbatimPayload`), abstract `TopoCompactor`. Ripwire-inspired physical pruning layer.
- `src/core/decision.ts` — `RouterOutputShape` (scalars only, no free text), `DecisionSchema` (per-field type + enum constraints), abstract `TopoDecisionRouter<T>`. Jev-inspired ~100ms typed branching layer.
- `src/index.ts` — `FastTopoRouter<T>.processIngress(entities, schema)` wires compactor → router; re-exports all public types.

Both engines are abstract classes: consumers bring their own extractor (e.g. Tree-sitter) and decision model (e.g. Jev API / local Ollama). Keep this boundary — no concrete implementations in `src/core/`.

## Key Directories

- `src/core/` — abstract engine contracts (frozen boundary; concrete implementations live outside)
- `src/compactors/` — `CodeCompactor`: Tree-sitter TS/TSX skeleton extractor
- `src/routers/` — `OllamaRouter` (local Ollama structured output, zero-dep) and `JevRouter` (TypeSafe Jev API, Bearer via `JEV_KEY` env; boolean→noul, string+enum→choice)
- `documents/` — design docs, canonical source of truth for intent

## Development Commands

```sh
bun install          # install deps (Bun is the package manager here)
bun run typecheck    # tsc --noEmit — the current verification gate
bun run test         # vitest run
bun run build        # emit dist/ with .d.ts
```

## Code Conventions & Common Patterns

- ESM only (`"type": "module"`, NodeNext resolution): relative imports MUST use `.js` extensions, e.g. `from "./compactor.js"`.
- Strict TS: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` are on — handle `undefined` explicitly.
- Type imports use `import type`; public API is re-exported from `src/index.ts` only.
- Router outputs are scalar-only by design — never widen `RouterOutputShape` to allow objects/text blobs.
- Sibling project `fast-jev-compaction` is the convention reference: same ESM/NodeNext/strict setup, vitest for tests, tsx for examples.

## Important Files

- `src/index.ts` — sole public entry point
- `documents/blueprint.md` — architecture rationale and MVP candidates; update it when design decisions change
- `tsconfig.json`, `package.json` — toolchain config

## Runtime/Tooling Preferences

- Bun for install/run scripts; TypeScript 5.6+ compiles to `dist/` (NodeNext, declarations on).
- Node >= 18 compatible output; no runtime dependencies — keep it that way for the core. Concrete extractors/routers (Tree-sitter, HTTP clients) belong in separate modules/packages, not `src/core/`.

## Testing & QA

- vitest, tests in top-level `tests/` with fixtures in `tests/fixtures/` (sibling `fast-jev-compaction` convention). Tests are NOT in tsconfig `include` — `bun run typecheck` covers `src/` only, matching the sibling's split.
- Working rule: non-trivial logic (branch, loop, parser) gets one minimal runnable check; pure plumbing (like `processIngress` wiring) needs only `bun run typecheck`.
- Gate before finishing work: `bun run typecheck && bun run test && bun run build` — dist must not contain test files.
