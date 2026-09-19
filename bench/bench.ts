/**
 * Performance benchmark: fast-topo-router vs naive baseline (agent reading full files + 1-hop imports).
 * Usage: bun bench/bench.ts [repoRoot] [file ...]
 * Defaults to core source files of ../fast-jev-compaction.
 *
 * Metrics:
 *  1. token savings = baseline chars/4 vs verbatimPayload chars/4 (ponytail: chars/4 is an estimate;
 *     swap in a real tokenizer for exact counts)
 *  2. decision latency = JevRouter.route() wall-clock time (real API, 1 call)
 *  3. compaction latency = CodeCompactor.compact() wall-clock time
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CodeCompactor, JevRouter, type CompactedGraph } from "../src/index.js";

const repoRoot = path.resolve(process.argv[2] ?? "../fast-jev-compaction");
const targets = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["src/compact.ts", "src/client.ts", "src/request.ts"];

// ponytail: baseline follows 1-hop imports only, matching typical agent behavior of inspecting direct deps
const IMPORT_RE = /from\s+["'](\.[^"']+)["']/g;

async function baselineBytes(absFiles: string[]): Promise<number> {
  const seen = new Set<string>();
  const entries = new Set(absFiles);
  let total = 0;
  const queue = [...absFiles];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // skip unresolvable imports (e.g. .css, directories)
    }
    total += text.length;
    if (!entries.has(file)) continue; // follow 1-hop imports for entry files only
    for (const m of text.matchAll(IMPORT_RE)) {
      const resolved = path.resolve(path.dirname(file), m[1]!).replace(/\.js$/, ".ts");
      queue.push(resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
    }
  }
  return total;
}

const compactor = new CodeCompactor();
const absTargets = targets.map((t) => path.join(repoRoot, t));

const t0 = performance.now();
const graph: CompactedGraph = await compactor.compact(absTargets);
const compactMs = performance.now() - t0;

const naive = await baselineBytes(absTargets);
const pruned = graph.verbatimPayload.length;

const schema = {
  is_critical_dependency: { type: "boolean" as const, description: "Will modifying these files crash upstream modules?" },
  recommended_test_action: {
    type: "string" as const,
    enum: ["Unit", "Integration", "None"],
    description: "Most appropriate test route for verifying this change",
  },
};

const t1 = performance.now();
const decision = await new JevRouter().route(graph, schema);
const routeMs = performance.now() - t1;

const pct = (1 - pruned / naive) * 100;
console.log(`repo:        ${repoRoot}`);
console.log(`targets:     ${targets.join(", ")}`);
console.log(`baseline:    ${naive} chars (~${Math.ceil(naive / 4)} tok)`);
console.log(`compacted:   ${pruned} chars (~${Math.ceil(pruned / 4)} tok)  →  -${pct.toFixed(1)}%`);
console.log(`compact():   ${compactMs.toFixed(0)}ms`);
console.log(`route():     ${routeMs.toFixed(0)}ms (Jev API, 1 call)`);
console.log(`decision:    ${JSON.stringify(decision)}`);
