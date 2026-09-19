# fast-topo-router

English | [中文](README.zh-CN.md)

The deterministic, type-safe context routing gateway for terminal AI agents (Claude Code, Omp, Codex).

Two-phase pre-ingestion pipeline — a gatekeeper that runs **before** the frontier LLM sees your workspace:

1. **Topology Compactor** (Ripwire-inspired): statically prunes ~85% of irrelevant workspace entropy into a high-density sub-graph — signatures, import edges, zero function bodies.
2. **Tactical Router** (Jev-inspired): evaluates the graph with strongly-typed decisions (booleans / enum choices, no free text) — bypassing noisy multi-turn LLM exploration, slashing token bills, and protecting your prompt cache.

Measured on a real TS repo: **-81~85% input tokens**, compactor ~30ms, single Jev decision ~550ms end-to-end (`bun run bench`).

## Install & Quickstart

```sh
bun install
```

```ts
import { CodeCompactor, FastTopoRouter, JevRouter } from "fast-topo-router";

const gateway = new FastTopoRouter(
  new CodeCompactor(),                        // Tree-sitter skeleton extractor (TS/TSX)
  new JevRouter(),                            // TypeSafe Jev API; reads JEV_KEY env
);

const { decision, contextForFrontierLLM } = await gateway.processIngress(
  ["src/foo.ts"],
  {
    is_critical_dependency: { type: "boolean", description: "Will this change break upstream modules?" },
    recommended_test_action: { type: "string", enum: ["Unit", "Integration", "None"] },
  },
);
// decision: { is_critical_dependency: false, recommended_test_action: "Unit" }
// contextForFrontierLLM: compact XML skeleton for your agent's context
```

## Components

| Component | Module | Backend |
|---|---|---|
| `TopoCompactor` / `TopoDecisionRouter` | `src/core/` | abstract contracts, zero deps — bring your own |
| `CodeCompactor` | `src/compactors/` | web-tree-sitter WASM, TS/TSX |
| `JevRouter` | `src/routers/` | TypeSafe Jev API (`JEV_KEY`) |
| `OllamaRouter` | `src/routers/` | local Ollama, zero-dep, no API key |

Design baseline: [`documents/blueprint.md`](documents/blueprint.md).

## Develop

```sh
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run build       # emit dist/
bun run bench       # token-savings / latency benchmark (1 Jev API call)
```

## License

MIT
