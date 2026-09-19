import type { CompactedGraph } from "../core/compactor.js";
import { TopoDecisionRouter } from "../core/decision.js";
import type { DecisionSchema, RouterOutputShape } from "../core/decision.js";

export interface JevRouterConfig {
  /** Defaults to process.env.JEV_KEY */
  apiKey?: string;
  /** Defaults to "jev-latest" */
  model?: string;
  /** Defaults to TypeSafe System One endpoint */
  baseUrl?: string;
  timeoutMs?: number;
  /** Global fetch by default; injected for testing */
  fetch?: typeof fetch;
}

// Jev wire shapes (subset; see fast-jev-compaction)
interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}
interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, null>;
}
type JevQuestion = NoulQuestion | ChoiceQuestion;

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 10_000;

// ponytail: support boolean->noul, string+enum->choice only; number / unconstrained string
// have no equivalent in Jev's typed question model and throw directly.
function toQuestions(schema: DecisionSchema): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const [name, field] of Object.entries(schema)) {
    const instructions = field.description ?? name;
    if (field.type === "boolean") {
      out[name] = { type: "noul", instructions };
    } else if (field.type === "string" && field.enum) {
      const criteria: Record<string, null> = {};
      for (const label of field.enum) criteria[String(label)] = null;
      out[name] = { type: "choice", instructions, criteria };
    } else {
      throw new Error(
        `JevRouter: field "${name}" (${field.type}${field.enum ? " with enum" : ""}) has no Jev question mapping; use boolean or string+enum`,
      );
    }
  }
  return out;
}

/** Provider-controlled text is echoed only as a bounded, single-line snippet. */
const snippet = (value: unknown, max = 80): string => {
  const text = JSON.stringify(value) ?? "undefined";
  return text.replace(/[\r\n\t]+/g, " ").slice(0, max);
};

function readAnswers(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || !("answers" in body)) {
    throw new Error("Jev response is missing answers");
  }
  const answers = (body as { answers: unknown }).answers;
  if (answers === null || typeof answers !== "object") throw new Error("Jev response is missing answers");
  return answers as Record<string, unknown>;
}

export class JevRouter<T extends RouterOutputShape> extends TopoDecisionRouter<T> {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(config: JevRouterConfig = {}) {
    super();
    this.apiKey = config.apiKey ?? process.env.JEV_KEY ?? "";
    this.model = config.model ?? "jev-latest";
    this.baseUrl = config.baseUrl ?? SYSTEM_ONE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = config.fetch ?? fetch;
  }

  async route(graph: CompactedGraph, schema: DecisionSchema): Promise<T> {
    if (!this.apiKey) throw new Error("JevRouter: apiKey missing (set JEV_KEY or pass config.apiKey)");
    const questions = toQuestions(schema);
    const state = {
      payload: graph.verbatimPayload,
      edges: graph.edges.map(([from, to]) => `${from} -> ${to}`),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Jev request failed (${response.status})`);
    }

    const answers = readAnswers(await response.json());
    const out: Record<string, string | number | boolean> = {};
    for (const [name, field] of Object.entries(schema)) {
      const answer = answers[name];
      if (answer === null || typeof answer !== "object") {
        throw new Error(`Jev answer missing for "${name}"`);
      }
      if (field.type === "boolean") {
        const noul = (answer as { noul?: unknown }).noul;
        if (typeof noul !== "number" || !Number.isFinite(noul)) {
          throw new Error(`Jev answer for "${name}": expected numeric noul, got ${snippet(answer)}`);
        }
        out[name] = noul >= 0.5; // ponytail: 0.5 fixed threshold; move to config when calibration is needed
      } else {
        const choice = (answer as { choice?: unknown }).choice;
        const allowed = (field.enum ?? []).map(String);
        if (typeof choice !== "string" || !allowed.includes(choice)) {
          throw new Error(`Jev answer for "${name}": expected one of ${allowed.join("/")}, got ${snippet(choice)}`);
        }
        out[name] = choice;
      }
    }
    return out as T;
  }
}
