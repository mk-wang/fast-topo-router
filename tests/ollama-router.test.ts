import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactedGraph } from "../src/core/compactor.js";
import type { DecisionSchema } from "../src/core/decision.js";
import { OllamaRouter } from "../src/routers/ollama-router.js";

const graph: CompactedGraph = {
  nodes: [{ id: "src/a.ts", metadata: { churn: 3 } }],
  edges: [["src/a.ts", "src/b.ts"]],
  verbatimPayload: "function a() { b(); }",
};

const schema: DecisionSchema = {
  is_critical_dependency: { type: "boolean", description: "Does b() gate the change?" },
  recommended_test_action: {
    type: "string",
    enum: ["Unit", "Integration", "None"],
    description: "Which test to run?",
  },
};

function mockOllama(content: string) {
  const fetchMock = vi.fn(async (_url: string, _init: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ message: { content } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaRouter", () => {
  it("returns a typed decision for a valid payload", async () => {
    const fetchMock = mockOllama(
      JSON.stringify({ is_critical_dependency: true, recommended_test_action: "Unit" }),
    );
    const router = new OllamaRouter<{ is_critical_dependency: boolean; recommended_test_action: string }>({
      model: "qwen2.5:0.5b",
    });

    const decision = await router.route(graph, schema);

    expect(decision).toEqual({ is_critical_dependency: true, recommended_test_action: "Unit" });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(init.body) as {
      stream: boolean;
      format: { required: string[]; additionalProperties: boolean };
      messages: { role: string; content: string }[];
    };
    expect(body.stream).toBe(false);
    expect(body.format.required).toEqual(["is_critical_dependency", "recommended_test_action"]);
    expect(body.format.additionalProperties).toBe(false);
    expect(body.messages[1]?.content).toContain("function a() { b(); }");
  });

  it("throws naming the field when an enum value is outside the schema", async () => {
    mockOllama(JSON.stringify({ is_critical_dependency: true, recommended_test_action: "E2E" }));
    const router = new OllamaRouter<{ is_critical_dependency: boolean; recommended_test_action: string }>({
      model: "qwen2.5:0.5b",
    });

    await expect(router.route(graph, schema)).rejects.toThrow(/recommended_test_action.*E2E/);
  });
});
