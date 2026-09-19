import { describe, expect, it } from "vitest";
import type { CompactedGraph } from "../src/core/compactor.js";
import type { DecisionSchema } from "../src/core/decision.js";
import { JevRouter } from "../src/routers/jev-router.js";

const graph: CompactedGraph = {
  nodes: [{ id: "src/a.ts::foo", metadata: {} }],
  edges: [["src/a.ts", "src/b.ts"]],
  verbatimPayload: "<graph><file path=\"src/a.ts\"><fn name=\"foo\"/></file></graph>",
};

const schema: DecisionSchema = {
  is_critical_dependency: { type: "boolean", description: "改动该节点是否会引发上游模块崩溃？" },
  recommended_test_action: { type: "string", enum: ["Unit", "Integration", "None"] },
};

const mockFetch = (answers: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch;

describe("JevRouter", () => {
  it("maps noul/choice answers to typed decision", async () => {
    const router = new JevRouter({
      apiKey: "k",
      fetch: mockFetch({
        is_critical_dependency: { noul: 0.92 },
        recommended_test_action: { choice: "Unit", confidence: 0.9, probabilities: { Unit: 0.9 } },
      }),
    });
    const decision = await router.route(graph, schema);
    expect(decision).toEqual({ is_critical_dependency: true, recommended_test_action: "Unit" });
  });

  it("throws naming the field when choice is outside the enum", async () => {
    const router = new JevRouter({
      apiKey: "k",
      fetch: mockFetch({
        is_critical_dependency: { noul: 0.1 },
        recommended_test_action: { choice: "E2E" },
      }),
    });
    await expect(router.route(graph, schema)).rejects.toThrow(/recommended_test_action.*E2E/);
  });

  it("rejects schema fields with no Jev question mapping", async () => {
    const router = new JevRouter({ apiKey: "k", fetch: mockFetch({}) });
    await expect(router.route(graph, { severity: { type: "number" } })).rejects.toThrow(/severity/);
  });
});
