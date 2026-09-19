#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server exposing the fast-topo-router gateway
 * as tools for terminal agents (Codex, Claude Code, Omp).
 *
 * Zero-dep: newline-delimited JSON-RPC 2.0 over stdin/stdout. Nothing but protocol
 * messages may be written to stdout; diagnostics go to stderr.
 *
 * Tools:
 *   topo_compact — prune workspace entities into a compact XML skeleton (local only, always exposed)
 *   topo_route   — advisory-only model advice, available by default; the operator withholds it with
 *                  TOPO_ENABLE_ROUTING=0 (compacts, then sends the skeleton + schema text to a backend)
 */
import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CodeCompactor, MAX_ENTITIES, nodeIdFor } from "../compactors/code-compactor.js";
import type { CompactedGraph, TopoCompactor } from "../core/compactor.js";
import type { DecisionField, DecisionSchema, RouterOutputShape, TopoDecisionRouter } from "../core/decision.js";
import { JevRouter } from "../routers/jev-router.js";
import { OllamaRouter } from "../routers/ollama-router.js";

const SERVER_NAME = "fast-topo-router";

/** Read from package.json so the handshake never advertises a stale version. */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SERVER_VERSION = readPackageVersion();
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = [DEFAULT_PROTOCOL_VERSION];

/**
 * Bound for one call stage. A route call runs two stages — compaction, then the backend — each bounded
 * on its own clock, so a call's worst case is twice this value rather than one overall deadline.
 * Leave headroom under a 30-second client tool timeout so an unavailable result can arrive first.
 */
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

// Bounds on caller-supplied text that would otherwise be forwarded to a model backend.
// Per-field AND aggregate: 32 fields x (64-char name + 200-char description + 16 x 64-char labels) ~ 39KB max.
const MAX_SCHEMA_FIELDS = 32;
const MAX_FIELD_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_ENUM_LABELS = 16;
const MAX_ENUM_LABEL_CHARS = 64;
const MAX_ENTITY_CHARS = 4096;

/** Invalid tool input: reported as a JSON-RPC error, not as a tool execution failure. */
export class ToolInputError extends Error {}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Server-wide guidance. Codex reads this at initialization; the first 512 characters
 * must stand alone, since that is what the agent sees while choosing tools.
 *
 * Navigation only: compacted skeletons point at code, they never replace reading the
 * implementation or the checks a change requires. Failures are handled with the agent's
 * normal read/search/LSP tools — the server never retries or switches backends.
 */
const NAVIGATION_INSTRUCTIONS =
  "fast-topo-router prunes workspace context before you read it. Call topo_compact with the file paths " +
  "you are about to inspect to get signatures and import edges instead of full file bodies — typically " +
  "80-90% fewer tokens; paths resolve against the workspace root and reads never leave it. It points at " +
  "code, it does not replace reading the implementation you change, and it does not change which checks " +
  "your task requires. If it is unavailable or misses the code you need, fall back to your normal " +
  "read/search/LSP tools rather than retrying in a loop. Prefer topo_compact over reading or grepping " +
  "whole directories when you are exploring a call path.";

/** The routing recommendation; the operator withdraws it for a server with TOPO_ENABLE_ROUTING=0. */
const ROUTING_INSTRUCTIONS =
  "topo_route returns a routing recommendation (risk, test route) for the files you are about to touch: " +
  "use it as your routing decision. It carries one limit — it does not waive checks the user or the " +
  "repository explicitly requires. It sends the compacted skeleton and your schema text to a model " +
  "backend — the Jev API over the network when JEV_KEY is set, otherwise local Ollama. If the backend " +
  "fails or times out you get an \"unavailable\" advisory instead of a decision, carrying the skeleton " +
  "already compacted for the call as contextForFrontierLLM: continue from that context with your normal " +
  "read/search/LSP tools. The server never retries or switches backends for you.";

/** What a default server advertises: navigation plus the routing recommendation. */
export const SERVER_INSTRUCTIONS = `${NAVIGATION_INSTRUCTIONS} ${ROUTING_INSTRUCTIONS}`;

/**
 * Instructions advertised at initialization. With routing withheld the agent is told about navigation
 * only, so it is never invited to call a tool this process would refuse.
 */
export const serverInstructions = (routing: boolean): string =>
  routing ? SERVER_INSTRUCTIONS : NAVIGATION_INSTRUCTIONS;

/** Local-only tool: reads files, never writes, never contacts anything. */
const READ_ONLY_LOCAL = { readOnlyHint: true, openWorldHint: false };
/** topo_route additionally transmits derived text to a model backend over the network. */
const READ_ONLY_EGRESS = { readOnlyHint: true, openWorldHint: true };

/**
 * Operator-controlled: routing stays available unless the operator withholds it for this process with
 * TOPO_ENABLE_ROUTING=0. The check happens at execution time, so a running server follows its env, and
 * nothing a caller sends — tool arguments, `backend`, or a stray JEV_KEY — can change the answer.
 */
const routingEnabled = (): boolean => process.env["TOPO_ENABLE_ROUTING"] !== "0";

export const TOOLS: McpTool[] = [
  {
    name: "topo_compact",
    annotations: READ_ONLY_LOCAL,
    description:
      "Prune workspace entities (files) into a compact XML skeleton: signatures and import edges, no function bodies. " +
      "Use it before reading files when exploring a call path — it typically removes 80-90% of the tokens a full read would cost. " +
      "It points at code rather than replacing it: reading the implementation you change and the checks your task requires stay yours. " +
      "Local only: paths resolve against the workspace root (TOPO_ROOT, else the server's working directory) and reads are confined to it. " +
      "If it fails or misses the code you need, fall back to your normal read/search/LSP tools.",
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_ENTITIES,
          description: 'File paths, optionally narrowed to a symbol with "path::symbol".',
        },
      },
      required: ["entities"],
      additionalProperties: false,
    },
  },
  {
    name: "topo_route",
    annotations: READ_ONLY_EGRESS,
    description:
      "Typed routing recommendation for the given entities against a decision schema (risk, test route) — the decision " +
      "to act on for that call. Use it as your routing decision: it does not waive checks the user or the repository " +
      "explicitly requires. Available unless the operator withheld it for this server with TOPO_ENABLE_ROUTING=0; " +
      "nothing a caller sends changes that. This tool sends the compacted skeleton and your schema text to a model " +
      "backend: the Jev API (https://api.typesafe.ai) when JEV_KEY is set, else local Ollama (http://localhost:11434). " +
      "If the backend fails or times out the result is an \"unavailable\" advisory instead of a decision, carrying the " +
      "skeleton already compacted for the call as contextForFrontierLLM; nothing is retried or switched automatically. " +
      "Nothing is written to disk.",
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_ENTITIES,
          description: 'File paths, optionally narrowed to a symbol with "path::symbol".',
        },
        schema: {
          type: "object",
          minProperties: 1,
          description:
            'Field name -> { type: "boolean" | "string" | "number", enum?: [...], description?: string }. ' +
            "Enum members must match `type`. The Jev backend supports boolean and string+enum only.",
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["string", "number", "boolean"] },
              enum: { type: "array", minItems: 1, description: "Allowed values; members must match `type`." },
              description: { type: "string" },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        backend: {
          type: "string",
          enum: ["jev", "ollama"],
          description: "Defaults to jev when JEV_KEY is set, else ollama.",
        },
      },
      required: ["entities", "schema"],
      additionalProperties: false,
    },
  },
];

/**
 * When the operator withholds routing, only navigation is listed, so an agent never discovers a tool
 * this process would refuse to run.
 */
const NAVIGATION_TOOLS: McpTool[] = TOOLS.filter((tool) => tool.name === "topo_compact");

export const listTools = (routing: boolean): McpTool[] => (routing ? TOOLS : NAVIGATION_TOOLS);

/**
 * The routing answer is a recommendation to act on, with exactly one limit: it does not waive the
 * checks the user or the repository explicitly requires. No further caveats are stacked on it.
 */
const ADVISORY_NOTE =
  "usable routing recommendation: follow it as your routing decision. It does not waive checks the user " +
  "or the repository explicitly requires.";

/**
 * Says technical unavailability, never a verdict on the code: an agent must not read a failed backend
 * as "nothing to check", and a failed compaction as an empty workspace.
 */
const FALLBACK_GUIDANCE =
  "technical unavailability of the tool, not a verdict on your code — continue with your normal " +
  "read/search/LSP tools and the checks your task requires; the server does not retry or switch backends.";

const advisory = (fields: Record<string, unknown>): string =>
  JSON.stringify({ advisory: true, ...fields, note: ADVISORY_NOTE });

export interface GatewayDeps {
  compactor?: TopoCompactor;
  /** Resolves the decision backend; injected in tests. */
  makeRouter?: (backend: "jev" | "ollama") => TopoDecisionRouter<RouterOutputShape>;
  /** Bounds each stage of a call (compaction, then the backend); injected in tests. */
  timeoutMs?: number;
}

const defaultMakeRouter = (backend: "jev" | "ollama"): TopoDecisionRouter<RouterOutputShape> =>
  backend === "jev" ? new JevRouter() : new OllamaRouter({ model: process.env["OLLAMA_MODEL"] ?? "qwen2.5-coder:7b" });

function readEntities(args: Record<string, unknown>): string[] {
  const entities = args["entities"];
  if (!Array.isArray(entities) || entities.length === 0 || !entities.every((entity) => typeof entity === "string")) {
    throw new ToolInputError("`entities` must be a non-empty array of strings");
  }
  if (entities.length > MAX_ENTITIES) {
    throw new ToolInputError(`\`entities\` accepts at most ${MAX_ENTITIES} paths (got ${entities.length})`);
  }
  for (const entity of entities as string[]) {
    if (entity.length > MAX_ENTITY_CHARS) {
      throw new ToolInputError(`each entity must be at most ${MAX_ENTITY_CHARS} characters (got ${entity.length})`);
    }
  }
  return entities as string[];
}

/** Bounded echo of caller-supplied text (paths can be arbitrarily long). */
const snippet = (value: string, max = 120): string => value.slice(0, max);

const FIELD_TYPES = new Set(["string", "number", "boolean"]);

/** Validates the caller's decision schema so a router can never widen the scalar contract. */
function readSchema(input: Record<string, unknown>): DecisionSchema {
  const raw = input["schema"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new ToolInputError("`schema` must be a non-empty object of field definitions");
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_SCHEMA_FIELDS) {
    throw new ToolInputError(`\`schema\` accepts at most ${MAX_SCHEMA_FIELDS} fields (got ${entries.length})`);
  }
  const schema: DecisionSchema = {};
  for (const [name, value] of entries) {
    if (name.length > MAX_FIELD_NAME_CHARS) {
      throw new ToolInputError(`schema field names must be at most ${MAX_FIELD_NAME_CHARS} characters`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ToolInputError(`schema field "${snippet(name)}" must be an object`);
    }
    const field = value as Record<string, unknown>;
    const type = field["type"];
    if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
      throw new ToolInputError(`schema field "${snippet(name)}".type must be one of string | number | boolean`);
    }
    const definition: DecisionField = { type: type as DecisionField["type"] };

    const enumValues = field["enum"];
    if (enumValues !== undefined) {
      if (!Array.isArray(enumValues) || enumValues.length === 0) {
        throw new ToolInputError(`schema field "${snippet(name)}".enum must be a non-empty array`);
      }
      if (enumValues.length > MAX_ENUM_LABELS) {
        throw new ToolInputError(`schema field "${snippet(name)}".enum accepts at most ${MAX_ENUM_LABELS} members`);
      }
      for (const member of enumValues) {
        if (typeof member !== type) {
          throw new ToolInputError(`schema field "${snippet(name)}".enum members must be of type ${type}`);
        }
        if (typeof member === "string" && member.length > MAX_ENUM_LABEL_CHARS) {
          throw new ToolInputError(`schema field "${snippet(name)}".enum members must be at most ${MAX_ENUM_LABEL_CHARS} characters`);
        }
      }
      definition.enum = enumValues as readonly (string | number | boolean)[];
    }

    const description = field["description"];
    if (description !== undefined) {
      if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) {
        throw new ToolInputError(`schema field "${snippet(name)}".description must be a string of at most ${MAX_DESCRIPTION_CHARS} characters`);
      }
      definition.description = description;
    }
    schema[name] = definition;
  }
  return schema;
}

/** Bounded echo of a rejected value, so a malformed answer cannot flood the agent's context. */
const show = (value: unknown): string => snippet(JSON.stringify(value) ?? String(value), 40);

/**
 * Re-checks the backend's answer against the caller's schema at the MCP handoff. Scalars are the whole
 * point of this tool, so an empty, nested, enum-violating or extended answer is not a decision — the
 * caller gets the unavailable advisory instead of something shaped like an answer it never gave.
 */
function decisionProblem(answer: unknown, schema: DecisionSchema): string | null {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return `answer is ${answer === null ? "null" : typeof answer}, not a decision object`;
  }
  const decision = answer as Record<string, unknown>;
  for (const [name, field] of Object.entries(schema)) {
    const value = decision[name];
    if (typeof value !== field.type || (typeof value === "number" && !Number.isFinite(value))) {
      return `field "${snippet(name)}" is ${show(value)}, expected ${field.type}`;
    }
    if (field.enum !== undefined && !(field.enum as readonly unknown[]).includes(value)) {
      return `field "${snippet(name)}" is ${show(value)}, expected one of ${field.enum.join(", ")}`;
    }
  }
  const extra = Object.keys(decision).filter((name) => !Object.hasOwn(schema, name));
  return extra.length === 0 ? null : `unexpected ${extra.map((name) => `"${snippet(name)}"`).join(", ")}`;
}

/**
 * A skipped entity (missing path, directory, outside the root, unknown symbol) must not look like
 * a successful empty answer — the caller has to know the path or symbol did not match.
 */
function assertEntitiesResolved(entities: string[], graph: CompactedGraph): void {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const missing = entities.filter((entity) => !ids.has(nodeIdFor(entity)));
  if (missing.length > 0) {
    throw new ToolInputError(
      `no nodes for ${missing.map((entity) => snippet(entity)).join(", ")} — path missing, not a regular file, outside the workspace root, larger than 1 MiB, or an unknown symbol`,
    );
  }
}

function summarize(graph: CompactedGraph): string {
  return `${graph.nodes.length} nodes, ${graph.edges.length} edges`;
}

/**
 * Bounded compaction stage: a compaction that fails or hangs reports unavailable navigation with
 * fallback guidance, never an empty answer.
 */
async function compactOrUnavailable(
  compactor: TopoCompactor,
  entities: string[],
  timeoutMs: number,
): Promise<CompactedGraph> {
  try {
    return await withTimeout(compactor.compact(entities), timeoutMs, "compaction");
  } catch (error) {
    throw new Error(
      `topo navigation unavailable: ${error instanceof Error ? error.message : String(error)} — ${FALLBACK_GUIDANCE}`,
    );
  }
}

/** Executes one tool call and returns its text output. Throws `ToolInputError` for bad input. */
export async function callTool(
  name: string,
  args: unknown,
  deps: GatewayDeps = {},
): Promise<string> {
  const compactor = deps.compactor ?? new CodeCompactor();
  const input = (args ?? {}) as Record<string, unknown>;
  // Read per call, like the routing switch, so a running server follows its operator's env. Each stage
  // gets this bound on its own clock: a route call that compacts and then routes can take twice as long,
  // and a stage that hangs never eats the other stage's budget.
  const requestedMs = deps.timeoutMs ?? Number(process.env["TOPO_TOOL_TIMEOUT_MS"]);
  const stageMs = Number.isSafeInteger(requestedMs) && requestedMs > 0 && requestedMs <= 2_147_483_647
    ? requestedMs
    : DEFAULT_CALL_TIMEOUT_MS;

  if (name === "topo_compact") {
    const entities = readEntities(input);
    const graph = await compactOrUnavailable(compactor, entities, stageMs);
    assertEntitiesResolved(entities, graph);
    return `${summarize(graph)}\n${graph.verbatimPayload}`;
  }

  if (name === "topo_route") {
    // Checked before any router is built and before any file is read: the kill switch belongs to the
    // operator, and a caller cannot override it with arguments, `backend`, or a stray JEV_KEY.
    if (!routingEnabled()) {
      throw new Error(
        `topo_route is disabled on this server: its operator withheld routing with TOPO_ENABLE_ROUTING=0, ` +
        `and nothing a caller sends can re-enable it. ${FALLBACK_GUIDANCE}`,
      );
    }
    const entities = readEntities(input);
    const schema = readSchema(input);
    const requested = input["backend"];
    if (requested !== undefined && requested !== "jev" && requested !== "ollama") {
      throw new ToolInputError('`backend` must be "jev" or "ollama"');
    }
    const backend = (requested as "jev" | "ollama" | undefined) ?? (process.env["JEV_KEY"] ? "jev" : "ollama");
    const graph = await compactOrUnavailable(compactor, entities, stageMs);
    assertEntitiesResolved(entities, graph);
    try {
      // Bounded on its own clock, so a hung backend reports through the advisory below while the graph
      // compacted above travels with it.
      const decision: unknown = await withTimeout(
        (deps.makeRouter ?? defaultMakeRouter)(backend).route(graph, schema),
        stageMs,
        `${backend} backend`,
      );
      // The answer is re-checked against the caller's schema here, at the handoff: a router is local
      // code, but an empty, nested or out-of-contract answer must not reach the agent as a decision.
      const problem = decisionProblem(decision, schema);
      if (problem !== null) throw new Error(`backend answer rejected: ${problem}`);
      return advisory({
        status: "ok",
        backend,
        decision,
        graph: { nodes: graph.nodes.length, edges: graph.edges.length },
      });
    } catch (error) {
      // Only technical failure lands here, and it must not look like an answer: a fabricated
      // "None"/false would be indistinguishable from a decision the backend really made. The skeleton
      // already compacted for this call travels with the advisory so the caller continues from acquired
      // context — a hand-off of local work, not a second model call.
      throw new Error(
        advisory({
          status: "unavailable",
          backend,
          reason: error instanceof Error ? error.message : String(error),
          fallback: `${FALLBACK_GUIDANCE} The skeleton already compacted for this call is attached as contextForFrontierLLM.`,
          contextForFrontierLLM: graph.verbatimPayload,
        }),
      );
    }
  }

  throw new ToolInputError(`Unknown tool: ${name}`);
}

/**
 * One stuck stage must not wedge the request loop or lose the work of an earlier stage.
 *
 * ponytail: this bounds the RESPONSE, not the underlying work — an aborted compaction or in-flight
 * request still settles in the background. Cancelling them needs an AbortSignal threaded through the
 * frozen core contracts; revisit if a stuck stage is ever observed in practice.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${ms}ms — ${FALLBACK_GUIDANCE}`)),
      ms,
    );
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Handles one JSON-RPC message; returns the response object, or null for notifications. */
export async function handleMessage(
  message: unknown,
  deps: GatewayDeps = {},
): Promise<Record<string, unknown> | null> {
  if (message === null || typeof message !== "object") return null;

  const fail = (id: unknown, code: number, text: string): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message: text },
  });

  // Batching is not implemented; say so instead of dropping the message silently.
  if (Array.isArray(message)) return fail(null, -32600, "Batch requests are not supported");

  const { id, method, params } = message as JsonRpcMessage;
  if (id === undefined) return null; // notification: never answered
  if (typeof method !== "string") return fail(id, -32600, "Invalid request: `method` must be a string");

  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const version =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
    return reply({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: serverInstructions(routingEnabled()),
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: listTools(routingEnabled()) });

  if (method === "tools/call") {
    const call = params as { name?: unknown; arguments?: unknown } | undefined;
    if (typeof call?.name !== "string") return fail(id, -32602, "tools/call requires a `name`");
    try {
      // Every stage inside callTool bounds itself (stageMs per stage), so there is no overall deadline
      // here to race against a stage and discard the work it already produced.
      const text = await callTool(call.name, call.arguments, deps);
      return reply({ content: [{ type: "text", text }], isError: false });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (error instanceof ToolInputError) return fail(id, -32602, text);
      // Execution failures are results, not protocol errors — the agent reads the message and adapts.
      return reply({ content: [{ type: "text", text }], isError: true });
    }
  }

  return fail(id, -32601, `Method not found: ${method}`);
}

async function main(): Promise<void> {
  // The client may close the pipe at any time; that is a normal shutdown, not a crash.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    process.stderr.write(`fast-topo-router-mcp: stdout error: ${error.code ?? String(error)}\n`);
    process.exit(1);
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("fast-topo-router-mcp: skipping malformed JSON line\n");
      continue;
    }
    const response = await handleMessage(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

// Only start the stdio loop when executed directly (not when imported by tests).
// realpath+pathToFileURL keeps this correct behind a symlinked bin or paths with spaces.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`fast-topo-router-mcp: fatal: ${String(error)}\n`);
    process.exit(1);
  });
}
