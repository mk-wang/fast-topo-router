import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactedGraph } from "../src/core/compactor.js";
import type { DecisionSchema } from "../src/core/decision.js";
import { JevRouter } from "../src/routers/jev-router.js";
import { fileURLToPath } from "node:url";
import { handleMessage } from "../src/mcp/server.js";

afterEach(() => vi.unstubAllEnvs());

const graph: CompactedGraph = {
  nodes: [{ id: "src/a.ts::foo", metadata: {} }],
  edges: [["src/a.ts", "src/b.ts"]],
  verbatimPayload: "<graph><file path=\"src/a.ts\"><fn name=\"foo\"/></file></graph>",
};

const schema: DecisionSchema = {
  is_critical_dependency: { type: "boolean", description: "Will modifying this node crash upstream modules?" },
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

  it("hands acquired context back after an HTTP failure and recovers on the next request", async () => {
    vi.stubEnv("TOPO_ENABLE_ROUTING", "1");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("provider unavailable", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: {
        is_critical_dependency: { noul: 0.1 },
        recommended_test_action: { choice: "None" },
      } })));
    const router = new JevRouter({ apiKey: "offline-test-key", fetch: fetcher });
    const request = {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "topo_route", arguments: {
        entities: [fileURLToPath(new URL("./fixtures/code-compactor/sample.ts", import.meta.url))],
        schema, backend: "jev",
      } },
    };
    const failed = await handleMessage(request, { makeRouter: () => router });
    const failureResult = failed?.result as { isError: boolean; content: { text: string }[] };
    expect(failureResult.isError).toBe(true);
    const unavailable = JSON.parse(failureResult.content[0]!.text);
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable).not.toHaveProperty("decision");
    expect(unavailable.contextForFrontierLLM).toContain('<fn name="alpha"');
    expect(fetcher).toHaveBeenCalledTimes(1); // no hidden retry or fallback inference

    const recovered = await handleMessage({ ...request, id: 2 }, { makeRouter: () => router });
    const successResult = recovered?.result as { isError: boolean; content: { text: string }[] };
    expect(successResult.isError).toBe(false);
    expect(JSON.parse(successResult.content[0]!.text)).toMatchObject({
      status: "ok", decision: { is_critical_dependency: false, recommended_test_action: "None" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["missing answers", JSON.stringify({ status: "ok" })],
    ["missing requested answer", JSON.stringify({ answers: { is_critical_dependency: { noul: 0.9 } } })],
  ])("propagates %s as unavailable advice without losing the skeleton", async (_label, body) => {
    vi.stubEnv("TOPO_ENABLE_ROUTING", "1");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const router = new JevRouter({ apiKey: "offline-test-key", fetch: fetcher });
    const response = await handleMessage({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "topo_route", arguments: {
        entities: [fileURLToPath(new URL("./fixtures/code-compactor/sample.ts", import.meta.url))],
        schema, backend: "jev",
      } },
    }, { makeRouter: () => router });
    const result = response?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const unavailable = JSON.parse(result.content[0]!.text);
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable).not.toHaveProperty("decision");
    expect(unavailable.contextForFrontierLLM).toContain('<fn name="alpha"');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
