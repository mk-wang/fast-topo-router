import type { CompactedGraph } from "../core/compactor.js";
import { TopoDecisionRouter } from "../core/decision.js";
import type { DecisionSchema, RouterOutputShape } from "../core/decision.js";

export interface OllamaRouterConfig {
  model: string;
  /** Ollama server root, e.g. http://localhost:11434 */
  baseUrl?: string;
  timeoutMs?: number;
}


const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 5000;

const SYSTEM_PROMPT =
  "You are a deterministic routing engine. Answer with a single JSON object matching the given JSON Schema. No prose, no markdown, no extra keys.";

/** DecisionSchema -> JSON Schema object handed to Ollama's structured-output `format` field. */
function toJsonSchema(schema: DecisionSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    properties[name] = {
      type: field.type,
      ...(field.enum === undefined ? {} : { enum: [...field.enum] }),
      ...(field.description === undefined ? {} : { description: field.description }),
    };
  }
  return {
    type: "object",
    properties,
    required: Object.keys(schema),
    additionalProperties: false,
  };
}

function buildPrompt(graph: CompactedGraph, schema: DecisionSchema): string {
  const edges = graph.edges.map(([from, to]) => `${from} -> ${to}`).join("\n");
  const questions = Object.entries(schema)
    .map(([name, field]) => {
      const allowed = field.enum === undefined ? "" : ` | allowed: ${field.enum.join(", ")}`;
      return `- "${name}" (${field.type}${allowed}): ${field.description ?? "no description"}`;
    })
    .join("\n");
  return [
    `Nodes: ${graph.nodes.length}`,
    `Edges:\n${edges}`,
    `Payload:\n${graph.verbatimPayload}`,
    `Answer every field:\n${questions}`,
    "Reply with the JSON object only.",
  ].join("\n\n");
}

function describe(value: unknown): string {
  return value === undefined ? "undefined" : `${typeof value} ${JSON.stringify(value)}`;
}

/** Reads and type-checks every schema field; throws naming the offending field. */
function validateShape<T extends RouterOutputShape>(value: unknown, schema: DecisionSchema): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`OllamaRouter: expected a JSON object from the model, got ${describe(value)}`);
  }
  const source = value as Record<string, unknown>;
  const result: RouterOutputShape = {};
  for (const [name, field] of Object.entries(schema)) {
    const got = source[name];
    if (typeof got !== field.type) {
      throw new Error(
        `OllamaRouter: field "${name}" expected ${field.type}, got ${describe(got)}`,
      );
    }
    if (field.enum !== undefined && !(field.enum as readonly unknown[]).includes(got)) {
      throw new Error(
        `OllamaRouter: field "${name}" got ${JSON.stringify(got)}, expected one of ${field.enum
          .map((v) => JSON.stringify(v))
          .join(", ")}`,
      );
    }
    result[name] = got as string | number | boolean;
  }
  return result as T;
}

export class OllamaRouter<T extends RouterOutputShape> extends TopoDecisionRouter<T> {
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(config: OllamaRouterConfig) {
    super();
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  override async route(graph: CompactedGraph, schema: DecisionSchema): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const endpoint = `${this.baseUrl}/api/chat`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: toJsonSchema(schema),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildPrompt(graph, schema) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OllamaRouter: POST ${endpoint} failed with HTTP ${response.status}`);
      }
      const content = readContent(await response.json());
      return validateShape<T>(JSON.parse(content), schema);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`OllamaRouter: POST ${endpoint} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function readContent(body: unknown): string {
  const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`OllamaRouter: response has no message.content string, got ${describe(body)}`);
  }
  return content;
}

// ponytail: no retry / repair loop when the model returns invalid JSON — one shot, throw.
// Upgrade path: wrap route() in a bounded re-prompt loop that feeds the validation error back.
