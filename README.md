# fast-topo-router

English | [中文](README.zh-CN.md)

The deterministic, type-safe context routing gateway for terminal AI agents (Claude Code, Omp, Codex).

Optional navigation and model-advice components, not a replacement for normal engineering checks:

1. **Topology Compactor** (Ripwire-inspired): extracts signatures and import edges for navigation. Read the relevant implementation before changing code.
2. **Tactical Router** (Jev-inspired): returns typed model advice. Valid types do not guarantee correct judgments; advice never authorizes skipping required tests or reviews.

Measured on a real TypeScript repo (`bun run bench`), against an agent reading the files in full plus their 1-hop imports:

| Target | Agent reads files in full | Through the gateway | Saved |
|---|---|---|---|
| 3 source files | ~7,500 tokens | ~740 tokens | **-90%** |
| 7-file module | ~7,700 tokens | ~1,400 tokens | **-81%** |

These historical measurements estimate tokens as characters/4, not actual billed-token savings or end-to-end speedup. Compaction took ~30ms; the Jev requests took ~0.5–0.8s. Local Ollama latency has not been measured.

## Install & Quickstart

```sh
bun install
```

The following library example explicitly invokes the remote Jev backend. MCP routing also remains available by default; operators can disable it with `TOPO_ENABLE_ROUTING=0`.

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

## Use from Codex, Omp, or Claude Code (MCP)

The MCP server provides optional local navigation; it does not replace ordinary file reads:

```sh
bun run build
codex mcp add fast-topo-router -- node /abs/path/fast-topo-router/dist/mcp/server.js
```

Both `topo_compact` and `topo_route` are normally available. Operators can disable routing with
`TOPO_ENABLE_ROUTING=0`, enforced for discovery and direct invocation. Valid routing judgments are
usable without mandatory second-model review. Technical failures return unavailable advice and
the extracted context when available, not fabricated `None`/`false`; required checks remain unchanged.
See [`documents/integration-mcp.md`](documents/integration-mcp.md) for fallback and egress details.

## Develop

```sh
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run build       # emit dist/
bun run bench       # token-savings / latency benchmark (1 Jev API call)
```

## License

MIT
