import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  CodeCompactor,
  MAX_ENTITIES,
  MAX_FILE_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_LINES,
  nodeIdFor,
} from "../src/compactors/code-compactor.js";
import type { CompactedGraph } from "../src/core/compactor.js";

const fixtureDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/code-compactor");
const rel = (abs: string): string => path.relative(process.cwd(), abs).split(path.sep).join("/");

/** Caps are byte- and newline-based, never UTF-16 code units or `split` entries. */
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const newlines = (text: string): number => text.split("\n").length - 1;

/** Every payload line is one complete element: consumers read the payload element by element. */
const ELEMENT_LINE =
  /^(?:<\/?graph>|<\/?file(?: path="[^"]*")?>|<(?:fn|class|method|edge|omitted|truncated)(?: [a-z-]+="[^"]*")*\/>)$/;

const XML_REFERENCES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#10;": "\n",
  "&#13;": "\r",
  "&#9;": "\t",
};

/** Decodes the references the payload emits, so an attribute value can be compared with the real path. */
const unescapeXml = (value: string): string =>
  value.replace(/&(?:amp|lt|gt|quot|#10|#13|#9);/g, (reference) => XML_REFERENCES[reference]!);

const attributesOf = (line: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const match of line.matchAll(/([a-z-]+)="([^"]*)"/g)) found[match[1]!] = unescapeXml(match[2]!);
  return found;
};

const elementsNamed = (payload: string, name: string): string[] =>
  payload.split("\n").filter((line) => line.startsWith(`<${name} `));

/** Attributes of the single element with this name; a missing or duplicated element fails here. */
const onlyElement = (payload: string, name: string): Record<string, string> => {
  const found = elementsNamed(payload, name);
  expect(found).toHaveLength(1);
  return attributesOf(found[0]!);
};

/**
 * The payload contract: well-formed single-line elements, balanced file blocks, and both caps held
 * as measured on the whole emitted string — UTF-8 bytes and actual newlines.
 */
const expectWithinCaps = (graph: CompactedGraph): void => {
  const payload = graph.verbatimPayload;
  expect(payload.startsWith("<graph>\n")).toBe(true);
  expect(payload.endsWith("</graph>")).toBe(true);
  for (const line of payload.split("\n")) expect(line).toMatch(ELEMENT_LINE);
  expect(payload.match(/^<file /gm)?.length ?? 0).toBe(payload.match(/^<\/file>$/gm)?.length ?? 0);
  expect(newlines(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_LINES);
  expect(bytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
};

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
  expectWithinCaps(graph);
});

it("never reads outside the workspace root", async () => {
  const graph = await new CodeCompactor().compact(["/etc/hosts", "/etc"]);
  expect(graph.nodes).toEqual([]);
  expect(graph.verbatimPayload).toBe("<graph>\n</graph>");
});

it("skips non-regular files instead of blocking on them", async () => {
  // The FIFO lives INSIDE the workspace root, so this exercises the isFile() guard, not root confinement.
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-fifo-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const fifo = path.join(root, "pipe.ts");
    execFileSync("mkfifo", [fifo]);
    // A blocking read would hang here; the isFile() guard must reject it outright.
    const graph = await new CodeCompactor().compact([fifo]);
    expect(graph.nodes).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("skips files above the read cap instead of streaming them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-big-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const big = path.join(root, "big.ts");
    await writeFile(big, `export function marker(): void {}\n${"// padding\n".repeat(100_000)}`);
    expect((await stat(big)).size).toBeGreaterThan(MAX_FILE_BYTES);
    const graph = await new CodeCompactor().compact([big]);
    expect(graph.nodes).toEqual([]);
    expect(graph.verbatimPayload).toBe("<graph>\n</graph>");
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("caps the emitted skeleton even when one file declares thousands of symbols", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-wide-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const wide = path.join(root, "wide.ts");
    await writeFile(wide, Array.from({ length: MAX_PAYLOAD_LINES }, (_, i) => `export function f${i}(): void {}`).join("\n"));
    const graph = await new CodeCompactor().compact([wide]);
    // The block cannot fit, so it is dropped whole — unbalanced XML is never emitted — and named.
    expect(elementsNamed(graph.verbatimPayload, "truncated")).toHaveLength(1);
    expect(onlyElement(graph.verbatimPayload, "omitted")["path"]).toBe(nodeIdFor(wide));
    // The graph still describes every symbol the payload had to leave out.
    expect(graph.nodes.length).toBe(MAX_PAYLOAD_LINES + 1);
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("names an omitted file instead of letting it look empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-omit-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const hugeLine = path.join(root, "huge-line.ts");
    await writeFile(hugeLine, `export function pad(blob = "${"x".repeat(300_000)}"): void {}\n`);
    const graph = await new CodeCompactor().compact([hugeLine]);
    // The block cannot fit at all, so the payload names it rather than returning a bare marker.
    expect(onlyElement(graph.verbatimPayload, "omitted")["path"]).toBe(nodeIdFor(hugeLine));
    const summary = onlyElement(graph.verbatimPayload, "truncated");
    expect(Number(summary["omitted-files"])).toBe(1);
    expect(Number(summary["omitted-edges"])).toBe(0);
    // A partial payload still describes a complete graph.
    expect(summary["payload"]).toBe("partial");
    expect(summary["graph"]).toBe("complete");
    expect(graph.nodes.map((node) => node.id)).toContain(nodeIdFor(hugeLine));
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds payload bytes, not just lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-bytes-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const wideLine = path.join(root, "wide-line.ts");
    // One enormous default-parameter line: short on line count, huge in bytes.
    await writeFile(wideLine, `export function pad(blob = "${"x".repeat(300_000)}"): void {}\n`);
    const graph = await new CodeCompactor().compact([wideLine]);
    expect(elementsNamed(graph.verbatimPayload, "truncated")).toHaveLength(1);
    expect(bytes(graph.verbatimPayload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds multi-byte payloads by UTF-8 bytes rather than by UTF-16 code units", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-utf8-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const multibyte = path.join(root, "multibyte.ts");
    const source = `export function pad(blob = "${"\u65e5".repeat(150_000)}"): void {}\n`;
    await writeFile(multibyte, source);
    // The premise: this declaration looks admissible in code units yet is far past the byte cap.
    expect(source.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(bytes(source)).toBeGreaterThan(MAX_PAYLOAD_BYTES);

    const graph = await new CodeCompactor().compact([multibyte]);
    // Nothing of the oversized line is emitted, and the counts still describe the graph.
    expect(elementsNamed(graph.verbatimPayload, "fn")).toHaveLength(0);
    expect(onlyElement(graph.verbatimPayload, "omitted")["path"]).toBe(nodeIdFor(multibyte));
    expect(graph.nodes.map((node) => node.id)).toContain(nodeIdFor(multibyte));
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("counts omitted files and edges accurately once the caps are spent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-counts-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const oversized: string[] = [];
    for (let index = 0; index < 3; index++) {
      const file = path.join(root, `oversized-${index}.ts`);
      await writeFile(file, `export function pad${index}(blob = "${"x".repeat(300_000)}"): void {}\n`);
      oversized.push(file);
    }
    const imports: string[] = [];
    for (let index = 0; index < 8; index++) {
      await writeFile(path.join(root, `dep-${index}.ts`), `export function dep${index}(): void {}\n`);
      imports.push(`import "./dep-${index}.js";`);
    }
    // Fills the line budget, leaving room for fewer edges than the file declares.
    const declarations = Array.from(
      { length: MAX_PAYLOAD_LINES - 10 },
      (_, index) => `export function f${index}(): void {}`,
    ).join("\n");
    const wide = path.join(root, "wide.ts");
    await writeFile(wide, `${imports.join("\n")}\n${declarations}\n`);

    const graph = await new CodeCompactor().compact([...oversized, wide]);

    // Only the payload is partial: every edge and every omitted file is still in the graph.
    expect(graph.edges).toHaveLength(8);
    expect(graph.nodes.map((node) => node.id)).toContain(nodeIdFor(oversized[0]!));

    const summary = onlyElement(graph.verbatimPayload, "truncated");
    expect(Number(summary["omitted-files"])).toBe(3);
    // Every edge is either emitted or counted, never dropped silently.
    const omittedEdges = Number(summary["omitted-edges"]);
    expect(omittedEdges).toBeGreaterThan(0);
    expect(elementsNamed(graph.verbatimPayload, "edge").length + omittedEdges).toBe(graph.edges.length);
    // The record lines themselves no longer fit, so the counts are the whole summary — still exact.
    expect(elementsNamed(graph.verbatimPayload, "omitted")).toHaveLength(0);
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps omission metadata well formed for paths with double hyphens, newlines and Unicode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-xml-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const dir = path.join(root, "a--b");
    await mkdir(dir, { recursive: true });
    const weird = path.join(dir, "c--d\n\u00e9\u65e5--e.ts");
    await writeFile(weird, `export function pad(blob = "${"x".repeat(300_000)}"): void {}\n`);

    const graph = await new CodeCompactor().compact([weird]);
    const expected = nodeIdFor(weird);
    expect(expected).toContain("--");
    expect(expected).toContain("\n");

    // A comment-based note cannot carry `--` or a newline; an element can, and the path round-trips.
    expect(graph.verbatimPayload).not.toContain("<!--");
    const record = onlyElement(graph.verbatimPayload, "omitted");
    expect(record["path"]).toBe(expected);
    expect(record["path-truncated"]).toBeUndefined();
    expect(graph.nodes.map((node) => node.id)).toContain(expected);
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("clamps an over-long omission path without hiding it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-long-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const deep = path.join(root, ...Array.from({ length: 4 }, (_, index) => `level-${index}-${"d".repeat(34)}`));
    await mkdir(deep, { recursive: true });
    const deepFile = path.join(deep, "long-name-target.ts");
    await writeFile(deepFile, `export function pad(blob = "${"x".repeat(300_000)}"): void {}\n`);

    const graph = await new CodeCompactor().compact([deepFile]);
    const full = nodeIdFor(deepFile);
    const record = onlyElement(graph.verbatimPayload, "omitted");
    expect(record["path-truncated"]).toBe("true");
    const shown = record["path"]!;
    expect(shown.endsWith("\u2026")).toBe(true);
    expect(full.startsWith(shown.slice(0, -1))).toBe(true);
    // Only the record's name is shortened; the graph keeps the whole path.
    expect(graph.nodes.map((node) => node.id)).toContain(full);
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a multi-line signature on a single element line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-wrap-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const spread = path.join(root, "spread.ts");
    await writeFile(spread, "export function spread(\n  first: string,\n  second: string,\n): void {}\n");
    const graph = await new CodeCompactor().compact([spread]);
    const fn = onlyElement(graph.verbatimPayload, "fn");
    expect(fn["name"]).toBe("spread");
    expect(fn["params"]).toContain("\n");
    expect(fn["params"]).toContain("second: string");
    // Root, file, signature, close, root: the wrapped signature spends one line, not four.
    expect(newlines(graph.verbatimPayload)).toBe(4);
    expectWithinCaps(graph);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves logical and real paths to the same node id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ftr-real-"));
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = root;
  try {
    const file = path.join(root, "sample.ts");
    await writeFile(file, "export function alpha(input: string): number {\n  return 1;\n}\n");
    const real = realpathSync(file);
    expect(nodeIdFor(file)).toBe(nodeIdFor(real));
    const graph = await new CodeCompactor().compact([file]);
    expect(graph.nodes.map((node) => node.id)).toContain(nodeIdFor(file));
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed when TOPO_ROOT is unusable", async () => {
  const previous = process.env["TOPO_ROOT"];
  process.env["TOPO_ROOT"] = "/definitely/not/here";
  try {
    await expect(new CodeCompactor().compact(["src/index.ts"])).rejects.toThrow(/TOPO_ROOT/);
  } finally {
    if (previous === undefined) delete process.env["TOPO_ROOT"];
    else process.env["TOPO_ROOT"] = previous;
  }
});

it("reads at most MAX_ENTITIES paths, ignoring the rest", async () => {
  const sample = path.join(fixtureDir, "sample.ts");
  const beyond = path.join(fixtureDir, "dep.ts");
  const graph = await new CodeCompactor().compact([...Array.from({ length: MAX_ENTITIES }, () => sample), beyond]);
  expect(graph.nodes.some((node) => node.id.endsWith("::alpha"))).toBe(true);
  expect(graph.nodes.some((node) => node.id.endsWith("dep.ts"))).toBe(false);
  expectWithinCaps(graph);
});
