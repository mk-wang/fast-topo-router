# fast-topo-router Design Blueprint

> Universal agent context routing gateway: topology-driven physical compaction + strongly-typed high-speed tactical decisions.
> This document serves as the project's canonical design baseline; subsequent design documents reside in `documents/`.

## Positioning

A **Smart Ingestion & Gatekeeping Layer** for terminal AI agents like Claude Code, Omp, and Codex.
Unlike fast-jev-compaction (post-hoc compaction of bloated context), this framework acts as a **Pre-Ingestion Guard**:

- **Protects Prompt Caching**: context is pruned before reaching the frontier model, avoiding cache invalidation triggered by mid-session compaction.
- **High Determinism**: guides decisions using code-level directed graphs, preventing agents from wandering through nested call chains with blind grep/find operations.

## Two-Phase Pipeline

### Phase 1: Topology-Driven Space Committer (`TopoCompactor`, Ripwire-Inspired)

- Performs lossless, high-speed static skeleton extraction over the workspace to build a weighted dependency graph.
- Deterministic heuristics (AST parsing, import/dependency graphs, churn activity) prune ~85-90% of irrelevant context.
- Output: `CompactedGraph` with nodes (id + metadata), directed edges, and `verbatimPayload` (clean XML gold context for frontier LLM consumption, stripped of implementation bodies/noise).

### Phase 2: TypeSafe Tactical Router (`TopoDecisionRouter`, Jev-Inspired)

- Consumes the compacted graph and maps questions directly into strongly-typed evaluations rather than noisy free-text summaries.
- Fast, cost-efficient decision engines (TypeSafe Jev API or local Ollama with structured output) return typed branches in ~100-500ms (e.g. `{"is_critical_dependency": false, "recommended_test_action": "Unit"}`).
- `DecisionSchema` enforces per-field type and enum constraints; output strictly permits scalar branch values only.

### Phase 3: Agent Consumption

- The gateway hands the packaged "gold code skeleton + deterministic test action recommendation" to the frontier agent.
- The agent skips recursive call-tree exploration and blind full-suite test runs, jumping straight to precise implementation and targeted execution.

## Code Structure

```
src/
  core/
    compactor.ts       # TopoNode / CompactedGraph / TopoCompactor (abstract contracts, frozen boundary)
    decision.ts        # RouterOutputShape / DecisionSchema / TopoDecisionRouter (abstract contracts, frozen boundary)
  compactors/
    code-compactor.ts  # CodeCompactor: Tree-sitter TS/TSX skeleton extractor
  routers/
    ollama-router.ts   # OllamaRouter: local Ollama structured-output router (zero-dep)
    jev-router.ts      # JevRouter: TypeSafe Jev API router via JEV_KEY env
  index.ts             # FastTopoRouter.processIngress(entities, schema) + public exports
tests/                 # Vitest test suite and fixtures (excluded from tsconfig include)
bench/                 # Token savings and latency benchmarks (bun bench/bench.ts)
documents/
  blueprint.md         # This document
```

## Implementation Status

All core components and MVPs have been implemented and pass `typecheck + vitest + build` gates:

1. **CodeCompactor** (`src/compactors/code-compactor.ts`): web-tree-sitter + tree-sitter-wasms. Extracts TS/TSX signatures, import edges, and XML payload. Modeled ceilings (documented via in-source `ponytail:` comments): no call-graph edges yet, churn/complexity omitted without git history, relative imports only. `web-tree-sitter` is strictly pinned to 0.25.10 (0.27+ is incompatible with tree-sitter-wasms 0.1.13).
2. **OllamaRouter** (`src/routers/ollama-router.ts`): zero-dependency fetch against `/api/chat` using structured JSON Schema format, strict per-field validation, zero free-text.
3. **JevRouter** (`src/routers/jev-router.ts`): TypeSafe Jev API (`POST /v1/systemone`, Bearer token, reads `JEV_KEY` environment variable). Maps boolean to `noul`, string+enum to `choice`. Verified with end-to-end live smoke tests (<1s round-trip).

## Benchmark Results (`bench/bench.ts`, `bun run bench`)

| Target Set | Baseline (full files + 1-hop imports) | Compacted | Token Savings | compact() | route() (Jev) |
|---|---|---|---|---|---|
| fast-jev-compaction (3 core files) | ~7,486 tok | ~741 tok | **-90.1%** | 31ms | 779ms |
| fast-jev-compaction (all 7 src files) | ~7,668 tok | ~1,429 tok | **-81.4%** | 24ms | 553ms |

*Tokens estimated as chars/4. Decision latency reflects a single live Jev API round-trip; total pipeline execution is <1s.*

## Next Steps

1. End-to-end live smoke against local Ollama models (e.g. `qwen2.5-coder`).
2. Call-graph edge extraction in `CodeCompactor`.
3. Model Context Protocol (MCP) server wrapper for native integration into Claude Code / Omp.
