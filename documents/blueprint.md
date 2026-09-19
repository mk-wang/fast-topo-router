# fast-topo-router: Architecture and Decisions

This is the canonical design baseline. Client setup and failure handling live in
[`integration-mcp.md`](integration-mcp.md). Design documents belong in `documents/`.

## Goal and non-goals

Help a terminal agent locate relevant code and delegate bounded routing judgments before spending
frontier-model context on full source files. The useful outcome is a completed engineering task with
less exploration cost, not a small prompt at any price.

The framework is not a correctness oracle, an automatic exemption from tests, a secrets sanitizer,
a complete call-graph engine, or a replacement for the agent's normal read/search/LSP tools.

## Architecture

```text
entities -> TopoCompactor -> CompactedGraph
                              |-- verbatimPayload -> navigation / implementation lookup
                              `-- TopoDecisionRouter + DecisionSchema -> typed routing decision

MCP adapter -> validates tool inputs, exposes local navigation/model routing,
               classifies technical failures, and preserves acquired context where available
```

The library and MCP adapter have different failure interfaces:

- `FastTopoRouter.processIngress()` returns a decision and context on success. Exceptions propagate;
  programmatic callers own their fallback policy.
- The MCP adapter turns execution failure into a tool-visible unavailable result, not a fabricated
  decision. A backend failure after compaction retains the skeleton so the agent can continue from
  work already done. If extraction itself fails before producing a graph, there is no graph to return.

### Ownership

| Owner | Responsibility |
| --- | --- |
| `src/core/compactor.ts` | Domain-independent nodes, directed edges, payload, abstract compactor |
| `src/core/decision.ts` | Scalar decision schema and abstract decision router |
| `src/compactors/code-compactor.ts` | Tree-sitter TS/TSX signatures, relative import edges, read/output bounds |
| `src/routers/jev-router.ts` | TypeSafe Jev typed-question protocol |
| `src/routers/ollama-router.ts` | Ollama structured JSON Schema output |
| `src/mcp/server.ts` | MCP transport, boundary validation, routing switch, technical-failure handling |
| `src/index.ts` | Library composition and public exports |
| `tests/` | Deterministic behavior and offline fault-injection checks |
| `bench/bench.ts` | Context-size and latency measurement; may call a real model backend |

Concrete parsers and providers stay outside `src/core/`. The MCP transport adds no SDK dependency;
concrete extraction still depends on `web-tree-sitter` and `tree-sitter-wasms`.

## Core decisions and tradeoffs

### 1. Extract first, decide second

AST extraction is local and deterministic for a fixed input; model inference answers a narrower
question over the extracted context. This separates navigation cost from decision cost and allows
either implementation to be replaced independently.

Tradeoff: the skeleton is intentionally **lossy**. The current extractor emits selected functions,
classes and methods plus relative import/re-export edges. It does not implement full caller/callee
analysis, transitive closure, churn metrics, or all TypeScript declaration forms. An untruncated
payload is still not the complete implementation. Default argument values and comments inside
signatures can survive extraction; treat source-derived output as untrusted data.

### 2. Delegate to Jev; do not routinely rejudge with a larger model

Jev has a real role: make bounded judgments cheaply so the main model need not repeat that inference.
A valid result can be used as the routing decision. Requiring a second frontier-model vote on every
answer would add latency, duplicate cost, and erase much of the product's value.

Neither Jev nor the frontier model is assumed correct because of its size or branding. Resolve
contradictions using task evidence, source inspection, compiler/test results, and explicit requirements.
A second model can be another opinion when useful, not a correctness guarantee.

### 3. Separate technical failure from a potentially wrong judgment

| Situation | Treatment | What it does not mean |
| --- | --- | --- |
| Transport failure, HTTP error, malformed/missing answer, schema mismatch | Advice unavailable; retain extracted context when available; continue normal workflow | Not `None`, not `false`, not a safe verdict |
| Backend timeout | Bounded response with fallback; retain an already-produced skeleton | Not cancellation/rollback of an in-flight request |
| Valid `None` or `false` result | Deliver unchanged as the routing judgment | Not proof that the model is right |
| Extraction failure or partial output | Report incompleteness and use ordinary reads/search/LSP as needed | Not evidence that code or dependencies do not exist |
| Explicit user/repository check | Preserve it regardless of which model recommends otherwise | No model can waive that requirement |

No automatic retry loop, repair loop, silent backend switch, or mandatory second-model inference is
introduced. This keeps failure behavior understandable and avoids repeated spending. Retrying can be
an explicit caller decision later.

`TOPO_TOOL_TIMEOUT_MS` bounds each stage separately: compaction, then routing. Defaults are 10 seconds
per stage, up to 20 seconds combined. A 30-second client timeout leaves headroom. Backend timeout
retains the acquired skeleton; a hung extraction has produced no skeleton to retain.
Cancellation would require a separate contract change and cannot undo a request already sent.

### 4. Routing is available normally, with an operator kill switch

MCP normally exposes both `topo_compact` and `topo_route`. `TOPO_ENABLE_ROUTING=0` disables route
discovery **and** direct invocation; tool arguments cannot override it. Unset or `1` keeps it available.
This is an operational control, not a judgment that Jev is less trustworthy than the main model.

Do not confuse service guarantees with agent behavior: the server can reject disabled calls and avoid
fabricating results. It cannot guarantee that an arbitrary agent always reads required files or runs
required checks. Enforce mandatory gates using CI and permissions, not model confidence.

### 5. Bounded local reads and honest partial output

Reads use real paths and stay within `TOPO_ROOT`, or the server's working directory if unset. An invalid
explicit root fails closed. Non-regular files and files above 1 MiB are rejected/skipped. Entity count
and MCP argument sizes are bounded.

The XML payload has a 256 KiB UTF-8 byte budget and a line budget. All serialized output, including
omission records, summary and closing tags, spends from these budgets. File blocks are atomic so
truncation cannot leave an unterminated `<file>`. Omitted paths use escaped XML elements rather than
comments; a bounded summary counts records that do not fit. Node/edge counts describe the extracted
graph, while truncation metadata explicitly marks a partial payload.

Tradeoff: a very large file block can be entirely absent from the payload. Narrow the request to a
symbol or use a normal source read. Do not mistake an omission for an empty source file.

### 6. Explicit network boundary

`topo_compact` is local-only. `topo_route` sends the skeleton and schema text to its selected model
backend. Jev uses `https://api.typesafe.ai`; the MCP Ollama backend uses local loopback by default.
The library's Ollama adapter also accepts a configurable `baseUrl`, so deployments choosing a remote
URL must account for that egress.

`readOnlyHint: true` means no local mutation, not no disclosure. Routing is marked `openWorldHint: true`.
Provider approval, credential storage and data-retention requirements remain explicit. Do not put keys
in repository configuration or command-line history. Never interpret a signature-only payload as free
of secrets.

## Can a smaller LLM replace Jev?

**Yes.** Jev is an adapter, not the framework's foundation. `OllamaRouter` already implements the same
`TopoDecisionRouter` contract and uses `/api/chat` with a JSON Schema `format` constraint.

| Choice | Strengths | Costs / limits |
| --- | --- | --- |
| Jev | Native typed questions; externally hosted inference | Network, provider billing/availability, source-derived egress |
| Small local model via Ollama | Local control, can avoid third-party transmission, no Jev key | Hardware/memory requirements, cold start, queueing; speed and quality must be measured |
| Another provider | Can preserve the same compactor and decision schema | Needs a real adapter, validation and provider-specific authorization; not currently implemented |

Portable schemas across current Jev/Ollama adapters use booleans and string enums. Jev maps booleans
to `noul` (currently thresholded at 0.5) and string enums to `choice`. The current Jev adapter does not
support number fields or unconstrained strings; do not assume parity with Ollama for those cases.

Example programmatic replacement (model name is illustrative, not a benchmark recommendation):

```ts
import { CodeCompactor, FastTopoRouter, OllamaRouter } from "fast-topo-router";

const gateway = new FastTopoRouter(
  new CodeCompactor(),
  new OllamaRouter({ model: "qwen2.5-coder:7b" }),
);
```

For MCP, set `OLLAMA_MODEL` to an installed model and request `backend: "ollama"`. If `JEV_KEY` is set,
backend omission still selects Jev; merely setting `OLLAMA_MODEL` does not override that selection.
The server does not silently switch to another model on failure.

### Replacement acceptance criteria

Use the same labeled routing tasks and schema for each candidate. Compare:

- Decision accuracy and important error classes separately (for example, underestimating required
  verification versus doing unnecessary work). Another LLM's answer is not the ground truth.
- Invalid-output and technical-failure rates, plus recovery behavior.
- Warm and cold p50/p95 latency, memory use and concurrency effects.
- Actual provider charges or local operating cost, not model size alone.
- Outcomes of the resulting engineering tasks under the same required checks.

No local Ollama benchmark has been run here. Do not claim that a smaller model is faster, cheaper, or
more accurate without that evidence. No new benchmark or paid invocation is authorized by this design.

## Evidence and remaining limits

Offline tests cover provider failure injection, malformed outputs, timeouts, valid-but-wrong decisions
remaining unchanged, operator controls, post-failure responsiveness, real-path confinement and bounded
XML output. Injected transports exercise the real Jev adapter without contacting the provider.
These tests prove service behavior, not that a real autonomous agent can never omit a required test.

Historical context/latency measurements, before the subsequent safety changes:

| Target | Baseline (full targets + 1-hop imports) | Skeleton | Estimated reduction | Compaction | Jev request |
| --- | --- | --- | --- | --- | --- |
| fast-jev-compaction, 3 files | ~7,486 tokens | ~741 tokens | 90.1% | 31ms | 779ms |
| fast-jev-compaction, 7 files | ~7,668 tokens | ~1,429 tokens | 81.4% | 24ms | 553ms |

Token counts were characters/4 estimates. The comparison uses different amounts of implementation
detail, so it is not a correctness-equivalent end-to-end A/B test or proof of actual billing savings.
Prompt-cache benefits and task-level speedup remain unmeasured.

`web-tree-sitter` is pinned to 0.25.10 because the paired WASM package failed with the newer tested
runtime. Upgrade the grammar/runtime pair together and exercise extraction before changing the pin.
