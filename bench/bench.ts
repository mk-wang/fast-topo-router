/**
 * 效果基准：fast-topo-router vs 朴素基线（Agent 直接全文读目标文件 + 一跳 import）。
 * 用法: bun bench/bench.ts [repoRoot] [file ...]
 * 默认对 ../fast-jev-compaction 的核心源文件跑。
 *
 * 指标:
 *  1. token 节省 = 基线字符/4 vs verbatimPayload 字符/4（ponytail: chars/4 是估算，
 *     精确计数时换 tokenizer）
 *  2. 决策延迟 = JevRouter.route() 墙钟时间（真实 API，1 次调用）
 *  3. 裁剪延迟 = CodeCompactor.compact() 墙钟时间
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CodeCompactor, JevRouter, type CompactedGraph } from "../src/index.js";

const repoRoot = path.resolve(process.argv[2] ?? "../fast-jev-compaction");
const targets = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["src/compact.ts", "src/client.ts", "src/request.ts"];

// ponytail: 基线只追一跳 import，匹配"Agent 读完入口还会打开直接依赖"的典型行为
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
      continue; // 解析不到的 import（如 .css、目录）跳过
    }
    total += text.length;
    if (!entries.has(file)) continue; // 只对入口文件追一跳
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
  is_critical_dependency: { type: "boolean" as const, description: "改动这些文件是否会引发上游模块崩溃？" },
  recommended_test_action: {
    type: "string" as const,
    enum: ["Unit", "Integration", "None"],
    description: "验证该改动最匹配的测试路由",
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
