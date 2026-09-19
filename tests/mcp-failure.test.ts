import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeIdFor } from "../src/compactors/code-compactor.js";
import type { CompactedGraph } from "../src/core/compactor.js";
import { TopoCompactor } from "../src/core/compactor.js";
import { TopoDecisionRouter, type DecisionSchema, type RouterOutputShape } from "../src/core/decision.js";
import { callTool, handleMessage } from "../src/mcp/server.js";
import { OllamaRouter } from "../src/routers/ollama-router.js";

/**
 * Offline fault injection for the MCP boundary. Every router below is injected locally, so no
 * backend (Jev API or Ollama) is ever contacted: no network, no paid call, no credentials.
 */
const fixture = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/code-compactor/sample.ts",
);
const missing = path.join(path.dirname(fixture), "does-not-exist.ts");

/** Router stand-in whose answer (or failure) is scripted per test. */
class StubRouter extends TopoDecisionRouter<RouterOutputShape> {
  constructor(private readonly answer: () => Promise<RouterOutputShape>) {
    super();
  }
  override async route(_graph: CompactedGraph, _schema: DecisionSchema): Promise<RouterOutputShape> {
    return this.answer();
  }
}

/** Never settles: only the backend stage bound can end a request that reaches it. */
const hangingRouter = new StubRouter(() => Promise.withResolvers<RouterOutputShape>().promise);

const failingCompactor = new (class extends TopoCompactor {
  async compact(): Promise<CompactedGraph> {
    throw new Error("boom: unreadable target");
  }
})();

/** Never settles: only the compaction stage bound can end a request that reaches it. */
const hangingCompactor = new (class extends TopoCompactor {
  compact(): Promise<CompactedGraph> {
    return Promise.withResolvers<CompactedGraph>().promise;
  }
})();

/**
 * Compaction that yields a captured skeleton once the test opens its gate, so stage order is explicit
 * rather than timed. `release()` before the request makes it immediate; releasing it mid-flight models
 * a slow compaction.
 */
const replayCompactor = (payload: string): { compactor: TopoCompactor; release: () => void } => {
  const gate = Promise.withResolvers<void>();
  const compactor = new (class extends TopoCompactor {
    async compact(entities: string[]): Promise<CompactedGraph> {
      await gate.promise;
      return {
        nodes: entities.map((entity) => ({ id: nodeIdFor(entity), metadata: {} })),
        edges: [],
        verbatimPayload: payload,
      };
    }
  })();
  return { compactor, release: () => gate.resolve() };
};

type CallResponse = {
  result?: { content: { text: string }[]; isError: boolean };
  error?: { code: number; message: string };
};

const compactCall = (id: number, entities: string[] = [fixture]): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "topo_compact", arguments: { entities } },
});

const routeCall = (id: number, schema: Record<string, unknown> = { risky: { type: "boolean" } }): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "topo_route", arguments: { entities: [fixture], schema, backend: "jev" } },
});

const textOf = (response: CallResponse): string => response.result!.content[0]!.text;

/** The skeleton topo_compact returns, without its "n nodes, m edges" summary line. */
const compactedSkeleton = (text: string): string => text.slice(text.indexOf("\n") + 1);

afterEach(() => {
  delete process.env["TOPO_ENABLE_ROUTING"];
  delete process.env["TOPO_TOOL_TIMEOUT_MS"];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mcp routing safety", () => {
  it("serves routing by default and stops it at listing and execution under the operator kill switch", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network access attempted in an offline test");
    });
    const makeRouter = vi.fn(() => new StubRouter(async () => ({ risky: true })));

    // Unset: routing behaves as it always has — advertised and executable.
    const listed = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["topo_compact", "topo_route"]);

    const init = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })) as {
      result: { instructions: string };
    };
    expect(init.result.instructions).toContain("topo_route");

    const available = (await handleMessage(routeCall(3), { makeRouter })) as CallResponse;
    expect(available.result?.isError).toBe(false);
    expect(JSON.parse(textOf(available))).toMatchObject({ status: "ok", decision: { risky: true } });

    // Explicit enable is the same normal operation.
    process.env["TOPO_ENABLE_ROUTING"] = "1";
    const enabled = (await handleMessage(routeCall(4), { makeRouter })) as CallResponse;
    expect(enabled.result?.isError).toBe(false);

    // Kill switch: withheld from listing, refused at execution, still no router and no network.
    process.env["TOPO_ENABLE_ROUTING"] = "0";
    const killed = (await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };
    expect(killed.result.tools.map((tool) => tool.name)).toEqual(["topo_compact"]);

    const killedInit = (await handleMessage({ jsonrpc: "2.0", id: 6, method: "initialize", params: {} })) as {
      result: { instructions: string };
    };
    expect(killedInit.result.instructions).not.toContain("topo_route");

    const refused = (await handleMessage(routeCall(7), { makeRouter })) as CallResponse;
    expect(refused.error).toBeUndefined();
    expect(refused.result?.isError).toBe(true);
    expect(textOf(refused)).toMatch(/disabled/);
    expect(textOf(refused)).toMatch(/TOPO_ENABLE_ROUTING=0/);
    expect(textOf(refused)).toMatch(/read\/search\/LSP/);

    // A caller that bypasses the protocol and imports the tool executor directly is refused too.
    await expect(
      callTool("topo_route", { entities: [fixture], schema: { risky: { type: "boolean" } } }, { makeRouter }),
    ).rejects.toThrow(/disabled/);

    expect(makeRouter).toHaveBeenCalledTimes(2);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("reports an unavailable routing advisory that hands over the skeleton instead of a decision", async () => {
    const compacted = (await handleMessage(compactCall(8))) as CallResponse;
    const skeleton = compactedSkeleton(textOf(compacted));
    expect(skeleton).toContain('<fn name="alpha"');

    const failed = (await handleMessage(routeCall(9), {
      makeRouter: () => new StubRouter(() => {
        throw new Error("Jev request failed (502)");
      }),
    })) as CallResponse;

    expect(failed.error).toBeUndefined();
    expect(failed.result?.isError).toBe(true);

    const payload = JSON.parse(textOf(failed)) as Record<string, unknown>;
    expect(payload).toMatchObject({ advisory: true, status: "unavailable", backend: "jev" });
    expect(String(payload["reason"])).toContain("Jev request failed (502)");
    expect(String(payload["fallback"])).toMatch(/read\/search\/LSP/);
    // Technical failure only: no decision appears, so nothing can be mistaken for a "None" verdict...
    expect(payload).not.toHaveProperty("decision");
    expect(textOf(failed)).not.toContain("recommended_test_action");
    expect(String(payload["note"])).toMatch(/does not waive checks the user or the repository explicitly requires/);
    // ...and the compaction already paid for travels with it, so the caller continues from that context.
    expect(payload["contextForFrontierLLM"]).toBe(skeleton);
  });

  it("treats a malformed backend response as unavailable rather than as a decision", async () => {
    // What the shipped routers do with a junk payload (OllamaRouter raises) and what a router that
    // returns nothing usable looks like to the server (non-object answer).
    const rejected = new StubRouter(() => {
      throw new Error('OllamaRouter: expected a JSON object from the model, got string "not json"');
    });
    const nonObject = new StubRouter(async () => null as unknown as RouterOutputShape);

    for (const [label, router] of [["rejected payload", rejected], ["non-object answer", nonObject]] as const) {
      const response = (await handleMessage(routeCall(10), { makeRouter: () => router })) as CallResponse;
      expect(response.result?.isError, label).toBe(true);
      const payload = JSON.parse(textOf(response)) as Record<string, unknown>;
      expect(payload, label).toMatchObject({ advisory: true, status: "unavailable" });
      expect(payload, label).not.toHaveProperty("decision");
      expect(String(payload["contextForFrontierLLM"]), label).toContain('<fn name="alpha"');
    }
  });

  it("bounds a hanging backend on its own clock and hands the skeleton over instead of losing it", async () => {
    const compacted = (await handleMessage(compactCall(11))) as CallResponse;
    const skeleton = compactedSkeleton(textOf(compacted));
    const { compactor, release } = replayCompactor(skeleton);
    release();

    vi.useFakeTimers();
    const pending = handleMessage(routeCall(12), { compactor, makeRouter: () => hangingRouter, timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    const timedOut = (await pending) as CallResponse;

    expect(timedOut.result?.isError).toBe(true);
    const payload = JSON.parse(textOf(timedOut)) as Record<string, unknown>;
    expect(payload).toMatchObject({ advisory: true, status: "unavailable" });
    expect(String(payload["reason"])).toMatch(/jev backend: timed out after 20ms/);
    expect(payload).not.toHaveProperty("decision");
    // The backend stage ran on its own clock, so the graph already compacted survives the timeout.
    expect(payload["contextForFrontierLLM"]).toBe(skeleton);

    // The loop is not wedged by the timed-out call: a healthy call still answers.
    vi.useRealTimers();
    const healthy = (await handleMessage(compactCall(13), { makeRouter: () => hangingRouter })) as CallResponse;
    expect(healthy.result?.isError).toBe(false);
    expect(textOf(healthy)).toContain('<fn name="alpha"');
  });

  it("lets a slow compaction finish inside its own bound without eating the backend's", async () => {
    const compacted = (await handleMessage(compactCall(14))) as CallResponse;
    const skeleton = compactedSkeleton(textOf(compacted));
    const { compactor, release } = replayCompactor(skeleton);

    vi.useFakeTimers();
    const pending = handleMessage(routeCall(15), { compactor, makeRouter: () => hangingRouter, timeoutMs: 300 });
    // 200ms of compaction: still inside the compaction stage's own 300ms...
    await vi.advanceTimersByTimeAsync(200);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // ...and the backend stage then gets a fresh 300ms rather than what is left of a shared deadline.
    await vi.advanceTimersByTimeAsync(300);
    const response = (await pending) as CallResponse;

    const payload = JSON.parse(textOf(response)) as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "unavailable" });
    expect(String(payload["reason"])).toMatch(/jev backend: timed out after 300ms/);
    expect(payload["contextForFrontierLLM"]).toBe(skeleton);
  });

  it("reports a hung compaction for either tool without pretending it has context", async () => {
    vi.useFakeTimers();
    for (const [label, call] of [["topo_compact", compactCall(16)], ["topo_route", routeCall(17)]] as const) {
      const pending = handleMessage(call, { compactor: hangingCompactor, timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(20);
      const stalled = (await pending) as CallResponse;

      expect(stalled.result?.isError, label).toBe(true);
      expect(textOf(stalled), label).toMatch(/compaction: timed out after 20ms/);
      expect(textOf(stalled), label).toMatch(/technical unavailability/);
      // Nothing was extracted before the hang, so there is no skeleton to hand over and no decision.
      expect(textOf(stalled), label).not.toContain("contextForFrontierLLM");
      expect(textOf(stalled), label).not.toContain("decision");
    }
    vi.useRealTimers();
  });

  it("rejects answers that do not match the caller's scalar schema", async () => {
    const schema = {
      risky: { type: "boolean" },
      action: { type: "string", enum: ["Unit", "Integration", "None"] },
    };
    const answers: [string, unknown][] = [
      ["empty object", {}],
      ["missing field", { risky: true }],
      ["nested object where a scalar belongs", { risky: true, action: { value: "Unit" } }],
      ["wrong scalar type", { risky: "true", action: "Unit" }],
      ["enum violation", { risky: true, action: "Full" }],
      ["extra field", { risky: true, action: "Unit", extra: "smuggled" }],
      ["prototype-named extra field", { risky: true, action: "Unit", constructor: "smuggled" }],
    ];

    for (const [label, answer] of answers) {
      const response = (await handleMessage(routeCall(18, schema), {
        makeRouter: () => new StubRouter(async () => answer as RouterOutputShape),
      })) as CallResponse;
      expect(response.result?.isError, label).toBe(true);
      const payload = JSON.parse(textOf(response)) as Record<string, unknown>;
      expect(payload, label).toMatchObject({ advisory: true, status: "unavailable" });
      expect(payload, label).not.toHaveProperty("decision");
      expect(String(payload["contextForFrontierLLM"]), label).toContain('<fn name="alpha"');
    }
  });

  it("honours TOPO_TOOL_TIMEOUT_MS as the per-stage bound", async () => {
    const compacted = (await handleMessage(compactCall(19))) as CallResponse;
    const skeleton = compactedSkeleton(textOf(compacted));
    const { compactor, release } = replayCompactor(skeleton);
    release();

    process.env["TOPO_TOOL_TIMEOUT_MS"] = "25";
    vi.useFakeTimers();
    const pending = handleMessage(routeCall(20), { compactor, makeRouter: () => hangingRouter });
    await vi.advanceTimersByTimeAsync(25);
    const response = (await pending) as CallResponse;

    expect(response.result?.isError).toBe(true);
    const payload = JSON.parse(textOf(response)) as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "unavailable" });
    expect(String(payload["reason"])).toMatch(/timed out after 25ms/);
    expect(payload["contextForFrontierLLM"]).toBe(skeleton);
  });

  it("delivers fallback before a 30-second client deadline with the default bounds", async () => {
    delete process.env["TOPO_TOOL_TIMEOUT_MS"];
    const compacted = await handleMessage(compactCall(31)) as CallResponse;
    const skeleton = compactedSkeleton(textOf(compacted));
    const { compactor, release } = replayCompactor(skeleton);
    release();
    vi.useFakeTimers();
    let settled = false;
    const pending = handleMessage(routeCall(32), { compactor, makeRouter: () => hangingRouter })
      .then((response) => { settled = true; return response as CallResponse; });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(true);
    const response = await pending;
    expect(response.result?.isError).toBe(true);
    expect(JSON.parse(textOf(response))).toMatchObject({
      status: "unavailable", contextForFrontierLLM: skeleton,
    });
  });

  it("rejects numeric overflow at both the adapter and MCP handoff", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      message: { content: '{"score":1e400}' },
    })));
    const routers = [
      new StubRouter(async () => ({ score: Number.POSITIVE_INFINITY })),
      new OllamaRouter({ model: "offline-test-model" }),
    ];
    for (const router of routers) {
      const response = await handleMessage(routeCall(28, { score: { type: "number" } }), {
        makeRouter: () => router,
      }) as CallResponse;
      expect(response.result?.isError).toBe(true);
      const unavailable = JSON.parse(textOf(response));
      expect(unavailable.status).toBe("unavailable");
      expect(unavailable).not.toHaveProperty("decision");
      expect(unavailable.contextForFrontierLLM).toContain('<fn name="alpha"');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not turn a negative timeout setting into immediate failure", async () => {
    const compacted = await handleMessage(compactCall(29)) as CallResponse;
    const { compactor, release } = replayCompactor(compactedSkeleton(textOf(compacted)));
    release();
    process.env["TOPO_TOOL_TIMEOUT_MS"] = "-5";
    vi.useFakeTimers();
    const backendReply = Promise.withResolvers<RouterOutputShape>();
    const pending = handleMessage(routeCall(30), {
      compactor,
      makeRouter: () => new StubRouter(() => backendReply.promise),
    });
    await vi.advanceTimersByTimeAsync(20);
    backendReply.resolve({ risky: false });
    const response = await pending as CallResponse;
    expect(response.result?.isError).toBe(false);
    expect(JSON.parse(textOf(response))).toMatchObject({ status: "ok", decision: { risky: false } });
  });

  it("delivers a wrong-but-valid None/false answer as the recommendation, without re-judging it", async () => {
    const schema = {
      recommended_test_action: { type: "string", enum: ["Unit", "Integration", "None"] },
      blocking: { type: "boolean" },
    };
    const router = new StubRouter(async () => ({ recommended_test_action: "None", blocking: false }));

    const response = (await handleMessage(routeCall(21, schema), { makeRouter: () => router })) as CallResponse;
    const payload = JSON.parse(textOf(response)) as Record<string, unknown>;

    expect(response.result?.isError).toBe(false);
    // Normal operation consumes the decision: the server neither second-guesses nor rewrites it...
    expect(payload).toMatchObject({ status: "ok", decision: { recommended_test_action: "None", blocking: false } });
    // ...so a route answer is only ever replaced by a technical-unavailability advisory, never by an opinion.
    expect(String(payload["note"])).toMatch(/usable routing recommendation/);
    expect(String(payload["note"])).toMatch(/does not waive checks the user or the repository explicitly requires/);
  });

  it("serves a healthy request after failed and partial navigation", async () => {
    const failed = (await handleMessage(compactCall(22), { compactor: failingCompactor })) as CallResponse;
    expect(failed.result?.isError).toBe(true);
    expect(textOf(failed)).toContain("boom: unreadable target");
    expect(textOf(failed)).toMatch(/technical unavailability/);
    expect(textOf(failed)).toMatch(/read\/search\/LSP/);

    const recovered = (await handleMessage(compactCall(23))) as CallResponse;
    expect(recovered.result?.isError).toBe(false);
    expect(textOf(recovered)).toContain('<fn name="alpha"');

    // Partial navigation (one unresolved entity) fails loudly, then a healthy request still answers.
    const partial = (await handleMessage(compactCall(24, [fixture, missing]))) as CallResponse;
    expect(partial.error?.code).toBe(-32602);
    expect(partial.error?.message).toContain("no nodes for");
    const afterPartial = (await handleMessage(compactCall(25, [fixture]))) as CallResponse;
    expect(afterPartial.result?.isError).toBe(false);
    expect(textOf(afterPartial)).toContain('<fn name="alpha"');

    // Same after an unavailable advisory from the routing tool.
    const unavailable = (await handleMessage(routeCall(26), {
      makeRouter: () => new StubRouter(() => {
        throw new Error("backend down");
      }),
    })) as CallResponse;
    expect(unavailable.result?.isError).toBe(true);

    const routed = (await handleMessage(routeCall(27), {
      makeRouter: () => new StubRouter(async () => ({ risky: true })),
    })) as CallResponse;
    expect(routed.result?.isError).toBe(false);
    expect(JSON.parse(textOf(routed))).toMatchObject({ status: "ok", decision: { risky: true } });
  });
});
