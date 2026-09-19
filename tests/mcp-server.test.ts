import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ENTITIES } from "../src/compactors/code-compactor.js";
import type { CompactedGraph } from "../src/core/compactor.js";
import { TopoCompactor } from "../src/core/compactor.js";
import { TopoDecisionRouter, type DecisionSchema, type RouterOutputShape } from "../src/core/decision.js";
import { handleMessage, SERVER_INSTRUCTIONS, serverInstructions, TOOLS } from "../src/mcp/server.js";

const fixture = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/code-compactor/sample.ts",
);

/** Records the graph it was asked to route, so the MCP layer's wiring is observable. */
class RecordingRouter extends TopoDecisionRouter<RouterOutputShape> {
  routed: string[] = [];
  async route(graph: CompactedGraph, _schema: DecisionSchema): Promise<RouterOutputShape> {
    this.routed.push(...graph.nodes.map((node) => node.id));
    return { recommended_test_action: "Unit" };
  }
}

const failingCompactor = new (class extends TopoCompactor {
  async compact(): Promise<CompactedGraph> {
    throw new Error("boom: unreadable target");
  }
})();

/** Routing is available by default; only the operator kill switch withholds it (tests/mcp-failure). */

describe("mcp server", () => {
  it("completes the handshake and lists navigation plus routing by default", async () => {
    const init = (await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })) as { result: { instructions: string } };
    expect(init).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "fast-topo-router" },
        instructions: expect.stringContaining("topo_compact"),
      },
    });
    expect(init.result.instructions).toContain("topo_route");

    const list = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: { name: string; annotations?: Record<string, unknown> }[] };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["topo_compact", "topo_route"]);
    // Codex's "writes" approval mode skips tools marked read-only.
    expect(list.result.tools.every((tool) => tool.annotations?.["readOnlyHint"] === true)).toBe(true);
  });

  it("returns a compacted skeleton for topo_compact", async () => {
    const response = (await handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "topo_compact", arguments: { entities: [fixture] } },
    })) as { result: { content: { text: string }[]; isError: boolean } };

    const text = response.result.content[0]!.text;
    expect(response.result.isError).toBe(false);
    expect(text).toContain("<fn name=\"alpha\"");
    expect(text).toMatch(/\d+ nodes, \d+ edges/);
  });

  it("returns the routing decision as a usable recommendation in a marked envelope", async () => {
    const router = new RecordingRouter();
    const response = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "topo_route",
          arguments: {
            entities: [fixture],
            schema: { recommended_test_action: { type: "string", enum: ["Unit", "Integration", "None"] } },
            backend: "jev",
          },
        },
      },
      { makeRouter: () => router },
    )) as { result: { content: { text: string }[]; isError: boolean } };

    const payload = JSON.parse(response.result.content[0]!.text) as Record<string, unknown>;
    expect(response.result.isError).toBe(false);
    expect(payload).toMatchObject({ advisory: true, status: "ok", backend: "jev" });
    // The decision is the answer to act on; the envelope only frames it as this tool's recommendation.
    expect(payload["decision"]).toEqual({ recommended_test_action: "Unit" });
    expect(payload["graph"]).toEqual({ nodes: expect.any(Number), edges: expect.any(Number) });
    expect(String(payload["note"])).toMatch(/usable routing recommendation/);
    expect(String(payload["note"])).toMatch(/does not waive checks the user or the repository explicitly requires/);
    // No blanket "do not use this" framing stacked on top of a decision meant to be followed.
    expect(response.result.content[0]!.text).not.toMatch(/never authority/);
    expect(router.routed.some((id) => id.endsWith("::alpha"))).toBe(true);
  });

  it("reports tool failures as results, not protocol errors", async () => {
    const response = (await handleMessage(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "topo_compact", arguments: { entities: ["x.ts"] } } },
      { compactor: failingCompactor },
    )) as { result: { content: { text: string }[]; isError: boolean }; error?: unknown };

    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain("boom");
  });

  it("ignores notifications and rejects unknown methods", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const unknown = (await handleMessage({ jsonrpc: "2.0", id: 7, method: "resources/list" })) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
  });

  it("answers ping and rejects batch requests instead of dropping them", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", id: 8, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 8, result: {} });
    const batch = (await handleMessage([{ jsonrpc: "2.0", id: 9, method: "ping" }])) as { id: null; error: { code: number } };
    expect(batch.error.code).toBe(-32600);
    expect(batch.id).toBeNull();
  });

  it("negotiates a supported protocol version", async () => {
    const future = (await handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    })) as { result: { protocolVersion: string } };
    expect(future.result.protocolVersion).toBe("2024-11-05");
  });

  it("reports invalid input as a protocol error, not a tool failure", async () => {
    const unknownTool = (await handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    })) as { error?: { code: number }; result?: unknown };
    expect(unknownTool.error?.code).toBe(-32602);
    expect(unknownTool.result).toBeUndefined();
  });

  it("rejects schemas that would widen the scalar contract", async () => {
    for (const schema of [
      { v: { type: "object" } },
      { v: { type: "array" } },
      { v: { type: "string", enum: [1, 2] } },
      { v: { type: "string", enum: ["ok"], description: "x".repeat(500) } },
    ]) {
      const response = (await handleMessage(
        { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "topo_route", arguments: { entities: [fixture], schema } } },
        { makeRouter: () => new RecordingRouter() },
      )) as { error?: { code: number } };
      expect(response.error?.code, JSON.stringify(schema)).toBe(-32602);
    }
  });

  it("refuses to report an unresolved entity as an empty success", async () => {
    const missing = path.join(path.dirname(fixture), "does-not-exist.ts");
    for (const entity of [missing, path.dirname(fixture), `${fixture}::NOPE`, "/etc/hosts"]) {
      const response = (await handleMessage({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "topo_compact", arguments: { entities: [entity] } },
      })) as { error?: { code: number; message: string }; result?: unknown };
      expect(response.error?.code, entity).toBe(-32602);
      expect(response.error?.message, entity).toContain("no nodes for");
      expect(response.result).toBeUndefined();
    }
  });

  it("advertises egress for route and withholds routing wording only under the kill switch", () => {
    const compact = TOOLS.find((tool) => tool.name === "topo_compact");
    const route = TOOLS.find((tool) => tool.name === "topo_route");
    expect(compact?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(route?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });

    // Default server: navigation plus the routing recommendation it can actually run.
    expect(SERVER_INSTRUCTIONS).toContain("topo_compact");
    expect(SERVER_INSTRUCTIONS).toContain("topo_route");
    expect(SERVER_INSTRUCTIONS).toMatch(/Jev API over the network/);
    expect(SERVER_INSTRUCTIONS).toMatch(/use it as your routing decision/);

    // Withheld routing: navigation only, so no agent is invited to call a refused tool.
    const withheld = serverInstructions(false);
    expect(withheld).toContain("topo_compact");
    expect(withheld).not.toContain("topo_route");
    expect(withheld).toMatch(/read\/search\/LSP/);
  });

  it("rejects more entities than the cap", async () => {
    const response = (await handleMessage({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "topo_compact", arguments: { entities: Array.from({ length: MAX_ENTITIES + 1 }, () => fixture) } },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32602);
  });

  it("bounds aggregate schema text and entity length", async () => {
    const tooManyFields = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`f${i}`, { type: "boolean" }]),
    );
    const longEntity = `src/${"a".repeat(5000)}.ts`;
    for (const args of [
      { entities: [fixture], schema: tooManyFields },
      { entities: [longEntity], schema: { ok: { type: "boolean" } } },
    ]) {
      const response = (await handleMessage(
        { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "topo_route", arguments: args } },
        { makeRouter: () => new RecordingRouter() },
      )) as { error?: { code: number } };
      expect(response.error?.code).toBe(-32602);
    }
  });
});
