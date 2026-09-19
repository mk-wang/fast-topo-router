import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node as TsNode } from "web-tree-sitter";
import { TopoCompactor, type CompactedGraph, type TopoNode } from "../core/compactor.js";

const require = createRequire(import.meta.url);

/** 一个符号声明（函数/类/方法）的签名，永不含函数体 */
interface Signature {
  kind: "fn" | "class" | "method";
  name: string;
  params: string;
  returns: string;
  owner: string;
}

// ponytail: 只抓函数/类/方法三类签名；interface / type alias / 类字段箭头函数暂不抓，
// 需要时在下面的 switch 里加分支即可。
function signaturesOf(root: TsNode): Signature[] {
  const out: Signature[] = [];
  const add = (
    node: TsNode,
    kind: Signature["kind"],
    owner = "",
    name = node.childForFieldName("name")?.text,
  ): void => {
    if (!name) return;
    out.push({
      kind,
      name,
      params: node.childForFieldName("parameters")?.text ?? "",
      returns: node.childForFieldName("return_type")?.text.replace(/^:\s*/, "") ?? "",
      owner,
    });
  };
  const visit = (node: TsNode): void => {
    switch (node.type) {
      case "export_statement":
        for (const child of node.namedChildren) if (child) visit(child);
        return;
      case "function_declaration":
        add(node, "fn");
        return;
      case "class_declaration":
      case "abstract_class_declaration": {
        add(node, "class");
        const owner = node.childForFieldName("name")?.text ?? "";
        for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
          if (member?.type === "method_definition") add(member, "method", owner);
        }
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        for (const decl of node.namedChildren) {
          if (decl?.type !== "variable_declarator") continue;
          const value = decl.childForFieldName("value");
          if (!value || (value.type !== "arrow_function" && value.type !== "function_expression")) continue;
          add(value, "fn", "", decl.childForFieldName("name")?.text);
        }
        return;
      default:
        // 不下潜函数体/嵌套块：签名之外的一律不采集（函数体不会进入 payload）
        return;
    }
  };
  for (const child of root.namedChildren) if (child) visit(child);
  return out;
}

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const toRel = (abs: string): string => path.relative(process.cwd(), abs).split(path.sep).join("/");

/** 相对 specifier 解析：`./x.js` → x.ts（NodeNext 语义）、`./x` → x.ts、目录 → index.ts */
async function resolveImport(fromAbs: string, specifier: string): Promise<string | null> {
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, path.join(base, "index.ts")]) {
    if (await stat(candidate).then(() => true, () => false)) return toRel(candidate);
  }
  return null;
}

let initPromise: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();

/** wasm 惰性初始化一次；语法按扩展名各缓存一份（tsx 需要独立 grammar） */
function parserFor(file: string): Promise<Parser> {
  const grammar = file.endsWith(".tsx") ? "tsx" : "typescript";
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = (async () => {
      initPromise ??= Parser.init();
      await initPromise;
      const instance = new Parser();
      instance.setLanguage(await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`)));
      return instance;
    })();
    parsers.set(grammar, parser);
  }
  return parser;
}

/**
 * MVP：TypeScript/TSX 静态骨架提取。
 * - 节点：目标文件本身 + 文件内函数/类/方法签名，id = `relativePath::symbolName`
 * - 边：相对路径 import / re-export 的导入图（file → file），不含传递闭包
 * - payload：XML 骨架，绝不含函数体/注释
 * ponytail: 三个天花板——(1) 只有 targetEntities 内的文件成为节点，上下游文件只作边的端点，
 *   要闭包扩展就在 compact 内对 edges 做 BFS 再 parse；(2) 只解析相对 specifier，
 *   裸包名/tsconfig paths 需补 node_modules 与 paths 解析；(3) 只有 TS/TSX，
 *   其他语言给 parserFor 的 grammar 映射加一行即可。
 */
export class CodeCompactor extends TopoCompactor {
  async compact(targetEntities: string[]): Promise<CompactedGraph> {
    const nodes = new Map<string, TopoNode>();
    const edges: [string, string][] = [];
    const seenEdges = new Set<string>();
    const payload: string[] = ["<graph>"];

    for (const entity of targetEntities) {
      const [rawPath = "", symbol = ""] = entity.split("::");
      const abs = path.resolve(rawPath);
      const rel = toRel(abs);

      let root: TsNode;
      try {
        const tree = (await parserFor(abs)).parse(await readFile(abs, "utf8"));
        // ponytail: 读不到/解析不了的目标静默跳过——compact 没有错误通道，一个坏路径不该毁掉整张图
        if (!tree) continue;
        root = tree.rootNode;
      } catch {
        continue;
      }

      let signatures = signaturesOf(root);
      if (symbol) {
        const narrowed = signatures.filter((signature) => signature.name === symbol);
        if (narrowed.length > 0) signatures = narrowed;
      }

      // ponytail: churn/complexity 一律缺省——MVP 不读 git 历史；升级路径是 git log --numstat 逐文件统计后写回 metadata
      nodes.set(rel, { id: rel, metadata: {} });
      for (const signature of signatures) {
        const id = `${rel}::${signature.name}`;
        nodes.set(id, { id, metadata: {} });
      }

      payload.push(`<file path="${esc(rel)}">`);
      for (const signature of signatures) {
        const owner = signature.owner ? ` in="${esc(signature.owner)}"` : "";
        const params = signature.params ? ` params="${esc(signature.params)}"` : "";
        const returns = signature.returns ? ` returns="${esc(signature.returns)}"` : "";
        payload.push(`<${signature.kind}${owner} name="${esc(signature.name)}"${params}${returns}/>`);
      }
      payload.push("</file>");

      for (const child of root.namedChildren) {
        if (!child || (child.type !== "import_statement" && child.type !== "export_statement")) continue;
        const specifier = child.childForFieldName("source")?.text.replace(/^['"]|['"]$/g, "");
        if (!specifier?.startsWith(".")) continue;
        const target = await resolveImport(abs, specifier);
        if (!target) continue;
        const key = `${rel}\u0000${target}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push([rel, target]);
      }
    }

    for (const [from, to] of edges) payload.push(`<edge from="${esc(from)}" to="${esc(to)}"/>`);
    payload.push("</graph>");

    return { nodes: [...nodes.values()], edges, verbatimPayload: payload.join("\n") };
  }
}
