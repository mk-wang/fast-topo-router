import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node as TsNode } from "web-tree-sitter";
import { TopoCompactor, type CompactedGraph, type TopoNode } from "../core/compactor.js";

const require = createRequire(import.meta.url);

/** Signature of a symbol declaration (function/class/method), never contains body */
interface Signature {
  kind: "fn" | "class" | "method";
  name: string;
  params: string;
  returns: string;
  owner: string;
}

// ponytail: extract only function/class/method signatures; interface/type alias/arrow fields
// deferred. Add cases in switch below when needed.
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
        // Do not descend into function bodies or nested blocks: only signatures are captured
        return;
    }
  };
  for (const child of root.namedChildren) if (child) visit(child);
  return out;
}

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const toRel = (abs: string): string => path.relative(process.cwd(), abs).split(path.sep).join("/");

/** Relative specifier resolution: `./x.js` -> x.ts (NodeNext), `./x` -> x.ts, directory -> index.ts */
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

/** Lazy-init wasm once; cache parsers per grammar by extension (.tsx needs separate grammar) */
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
 * TypeScript/TSX static skeleton extractor.
 * - Nodes: target file itself + enclosed function/class/method signatures, id = `relativePath::symbolName`
 * - Edges: relative import / re-export graph (file -> file), no transitive closure
 * - Payload: compact XML skeleton, zero function bodies or comments
 * ponytail: ceilings — (1) only files in targetEntities become nodes; dependency files only serve as edge endpoints.
 *   For transitive closure, run BFS over edges in compact(); (2) only relative specifiers resolved;
 *   bare packages/tsconfig paths need path resolution; (3) TS/TSX only; add grammar mapping for others.
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
        // ponytail: silently skip unreadable/unparseable targets — compact has no error channel; one bad path shouldn't fail the graph
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

      // ponytail: churn/complexity omitted — MVP does not read git history; upgrade path: git log --numstat per file
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
