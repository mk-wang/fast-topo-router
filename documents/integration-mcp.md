# MCP integration: Codex, Omp, Claude Code

## Safety contract

The MCP server provides navigation and delegates routing judgments to Jev or Ollama.

- Both tools are available normally. Operators may set `TOPO_ENABLE_ROUTING=0` to disable `topo_route` in both discovery and execution; tool arguments cannot bypass that switch.
- Skeletons omit implementations and may omit declarations or entire files. They are not evidence that a dependency, implementation, or required test is absent.
- Read relevant implementation before editing. Preserve repository-required tests, reviews, approvals, and CI gates.
- If navigation fails or is partial, continue with normal file reads, search, and LSP. No automatic retries or backend switching.
- Use valid model decisions normally; no compulsory second-model review is added. Neither Jev nor the frontier model can waive explicitly required user/repository checks. Strong types validate format, not correctness.

These are service and consumption contracts, not proof of LLM compliance. CI and permission controls must enforce mandatory workflow checks.

## Build and register

```sh
bun install
bun run build
```

Local navigation needs no API key. Routing additionally needs a running Ollama backend or a configured Jev key:

```sh
codex mcp add fast-topo-router -- node /abs/path/fast-topo-router/dist/mcp/server.js
claude mcp add -s user fast-topo-router -- node /abs/path/fast-topo-router/dist/mcp/server.js
```

Codex configuration (`~/.codex/config.toml`, or trusted-project `.codex/config.toml`):

```toml
[mcp_servers.fast-topo-router]
command = "node"
args = ["/abs/path/fast-topo-router/dist/mcp/server.js"]
startup_timeout_sec = 30
```

Omp configuration (`~/.omp/agent/mcp.json`, or project `.omp/mcp.json`):

```json
{
  "mcpServers": {
    "fast-topo-router": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/fast-topo-router/dist/mcp/server.js"]
    }
  }
}
```

Omp also discovers Codex configuration; its native same-named entry takes precedence. Tool names are normalized, for example `mcp__fast_topo_router_topo_compact`.

Relative file paths resolve against the server's working directory. `TOPO_ROOT` sets the permitted filesystem root; it does not change the working directory. Use absolute entity paths when the client's working directory is uncertain. Invalid explicit roots fail closed.

The `path::symbol` syntax reserves `::`; literal filenames containing that delimiter are not supported.

After rebuilding, restart the MCP connection to load the new process. In Omp use `/mcp reload`; start a new Codex/Claude session or use the client's MCP reconnect controls. `codex mcp list` confirms registration; `claude mcp list` also performs a connection health check.

## Model routing and technical fallback

Routing is available by default. `TOPO_ENABLE_ROUTING=0` is an operator-controlled kill switch, not a judgment about model accuracy. `TOPO_ENABLE_ROUTING=1` explicitly enables it.

Successful decisions can guide the task without duplicate frontier-model adjudication. A technical failure returns `status: unavailable`, no fabricated `decision`, and the already-extracted skeleton when available. The client continues its ordinary workflow rather than retrying indefinitely or treating failure as `None`/`false`.

The fallback is not a claim that the frontier model is more reliable. Incorrect but well-formed judgments are not automatically detectable: source evidence, compiler results, tests, and explicit requirements remain the way to resolve them. The default backend is Jev when `JEV_KEY` is present, otherwise local Ollama. Configure credentials and egress approval, for example:

```toml
[mcp_servers.fast-topo-router]
command = "node"
args = ["/abs/path/fast-topo-router/dist/mcp/server.js"]
env_vars = ["JEV_KEY"]

[mcp_servers.fast-topo-router.env]
TOPO_ENABLE_ROUTING = "1"

[mcp_servers.fast-topo-router.tools.topo_route]
approval_mode = "prompt"
```

Do not store keys in repository configuration or inline them in shell history. If using a credential file, keep it outside version control with mode `0600`. Node's `--env-file-if-exists=/absolute/file.env` requires Node >=22.9; bare Node does not load `.env` automatically. Bun can automatically load `.env`, so use injected transports or disable routing during offline checks.

### What leaves the machine

`topo_compact` is local-only. `topo_route` sends the source-derived skeleton and schema text to the configured model backend: `https://api.typesafe.ai` for Jev, or `http://localhost:11434` for the default Ollama backend. Default parameter values and signature comments may contain sensitive text; a skeleton is not a secrets sanitizer. Provider retention policies apply. `readOnlyHint` means no local file mutation, not no network activity; routing has `openWorldHint: true`.

### Partial output and limits

Compaction confines reads using real paths, rejects non-regular files and files above 1 MiB, and limits entity count. The complete serialized XML payload, including omission records, closing tags, and truncation metadata, is bounded by its line and UTF-8 byte budgets. Omission records are machine-readable XML elements; if labels cannot fit, a bounded summary counts the remaining omissions. Graph counts describe extracted nodes and edges, not proof of complete source coverage.

`TOPO_TOOL_TIMEOUT_MS` bounds each stage separately (default 10 seconds for compaction, then up to another 10 seconds for routing). Configure the client's tool timeout above the combined stage budget; 30 seconds leaves headroom with the defaults. A timed-out backend returns the already-extracted skeleton; extraction that never finishes has no skeleton to return. These response deadlines do not cancel underlying work or undo a request already sent. Invalid/non-positive timeout values fall back to the default.

## Failure verification

Run the offline suite with `bun run test`. Tests inject local failures and adversarial output; no live Jev or Ollama call is required. They cover the server-side routing gate, disabled direct invocation, advisory failure handling, wrong-but-valid decisions, unavailable/partial navigation, continued protocol responsiveness, and strict output limits.

This proves the implemented service contracts. It does not prove that an arbitrary Codex/Omp/Claude model will always obey fallback instructions or execute every required check. A real agent workflow acceptance test needs a bounded task and an authoritative external check such as CI; do not infer that result from mocked routing tests.

### Observed verification

The local verification pass completed `bun run typecheck`, `bun run test` (50 tests in 5 files),
and `bun run build`. Independent contract and boundary reviews found no remaining blockers in the
reviewed change after fixes.

A built `node dist/mcp/server.js` subprocess was exercised over stdin/stdout with an injected fetch
implementation: HTTP 502, malformed JSON, and a response arriving after the backend deadline each
returned unavailable advice with the skeleton and no decision. A subsequent valid `false`/`None`
answer passed unchanged; a missing-path call was followed by successful compaction and `ping`.
Four requested model calls produced exactly four mock transport calls: no hidden retry or second
model call. A separate operator-disabled run made zero transport calls.

All inference in this pass was simulated locally. It validates technical failure handling and recovery,
not Jev/Ollama semantic accuracy or autonomous-agent adherence to repository requirements.
