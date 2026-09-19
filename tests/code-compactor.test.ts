import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CodeCompactor } from "../src/compactors/code-compactor.js";

const fixtureDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/code-compactor");
const rel = (abs: string): string => path.relative(process.cwd(), abs).split(path.sep).join("/");

it("extracts signatures and import edges without leaking bodies", async () => {
  const sample = path.join(fixtureDir, "sample.ts");
  const graph = await new CodeCompactor().compact([sample]);
  const file = rel(sample);

  const symbolIds = graph.nodes.map((node) => node.id).filter((id) => id.includes("::"));
  expect(symbolIds).toContain(`${file}::alpha`);
  expect(symbolIds).toContain(`${file}::beta`);
  expect(symbolIds.length).toBeGreaterThanOrEqual(2);
  expect(graph.nodes.map((node) => node.id)).toContain(file);

  expect(graph.edges).toEqual([[file, rel(path.join(fixtureDir, "dep.ts"))]]);

  const { verbatimPayload } = graph;
  expect(verbatimPayload).toContain('<fn name="alpha" params="(input: string)" returns="number"/>');
  expect(verbatimPayload).toContain('<fn name="beta" params="(count: number)" returns="string"/>');
  expect(verbatimPayload).toContain('<class name="Widget"/>');
  expect(verbatimPayload).toContain('<method in="Widget" name="render" params="(scale: number)" returns="string"/>');
  expect(verbatimPayload).toContain('<edge from="' + file + '"');
  expect(verbatimPayload).not.toContain("BODY_MARKER");
});
