import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
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

/**
 * XML attribute escaping for caller-derived text (paths, signatures).
 * Whitespace controls become character references: a raw newline breaks the one-element-per-line
 * wire format and XML normalizes literal attribute whitespace to spaces. Character references decode
 * to the original whitespace characters instead. The remaining C0 controls cannot be represented in
 * XML 1.0 at all, not even as references, so they are replaced.
 */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "\uFFFD");

const toRel = (abs: string): string => path.relative(process.cwd(), abs).split(path.sep).join("/");

/**
 * Node id scheme shared with consumers: `relativePath` or `relativePath::symbol`.
 * Uses realpath so a logical path (`/tmp/x`) and its real path (`/private/tmp/x`) yield the same id,
 * matching how the compactor resolves entities.
 */
export function nodeIdFor(entity: string): string {
  const [rawPath = "", symbol = ""] = entity.split("::");
  const resolved = path.resolve(rawPath);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // Unresolvable path: fall back to the logical form so the caller gets an id it can compare.
  }
  const rel = toRel(real);
  return symbol ? `${rel}::${symbol}` : rel;
}

export const MAX_ENTITIES = 64;

/** Per-file read cap; larger files are skipped rather than streamed into the payload. */
export const MAX_FILE_BYTES = 1 << 20;

/**
 * Cap on emitted skeleton lines: bounds the agent's context and any egress volume.
 * Counted as the newlines in the payload, so every element — root tags, omission records and the
 * truncation summary included — spends from this budget.
 */
export const MAX_PAYLOAD_LINES = 2000;

/**
 * Byte cap for the same reason, counted in UTF-8 bytes rather than UTF-16 code units: one long line
 * must not slip past the line bound, and multi-byte text must not slip past the byte bound.
 */
export const MAX_PAYLOAD_BYTES = 256 << 10;

/**
 * Headroom held back from file/edge blocks for the elements appended after them, so the closing tag
 * and the truncation summary can never push the payload past either cap.
 * Worst-case `<truncated .../>` plus `</graph>`, separators included, stays well under the bytes.
 */
const TAIL_RESERVE_LINES = 2;
const TAIL_RESERVE_BYTES = 256;

/** An omission record is clamped to this many code points, so no single path can eat the reserve. */
const MAX_OMITTED_PATH_CHARS = 160;

/** Payload caps are byte-based, so `String#length` (UTF-16 code units) is not enough. */
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function withinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/**
 * Workspace root for reads: TOPO_ROOT when set, else the working directory.
 * Fail closed — a configured but unusable root must not silently widen to the cwd.
 */
function resolveWorkspaceRoot(): string {
  const configured = process.env["TOPO_ROOT"];
  if (!configured) return process.cwd();
  try {
    return realpathSync(configured);
  } catch {
    throw new Error(`TOPO_ROOT is not a readable directory: ${configured}`);
  }
}

/** Relative specifier resolution: `./x.js` -> x.ts (NodeNext), `./x` -> x.ts, directory -> index.ts */
async function resolveImport(fromAbs: string, specifier: string, root: string): Promise<string | null> {
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, path.join(base, "index.ts")]) {
    const real = await realpath(candidate).catch(() => null);
    if (!real || !withinRoot(real, root)) continue;
    if (await stat(real).then((info) => info.isFile(), () => false)) return toRel(real);
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
 * - Payload: compact XML skeleton, zero function bodies or comments. Root tags, omission records and
 *   the truncation summary all spend from MAX_PAYLOAD_LINES / MAX_PAYLOAD_BYTES, measured on the
 *   joined string, so the emitted payload can never exceed either cap.
 * ponytail: ceilings — (1) only files in targetEntities become nodes; dependency files only serve as edge endpoints.
 *   For transitive closure, run BFS over edges in compact(); (2) only relative specifiers resolved;
 *   bare packages/tsconfig paths need path resolution; (3) TS/TSX only; add grammar mapping for others.
 */
export class CodeCompactor extends TopoCompactor {
  async compact(targetEntities: string[]): Promise<CompactedGraph> {
    const root = resolveWorkspaceRoot();
    const entities = targetEntities.slice(0, MAX_ENTITIES);
    const nodes = new Map<string, TopoNode>();
    const edges: [string, string][] = [];
    const seenEdges = new Set<string>();
    const payload: string[] = ["<graph>"];
    /** Running cost of the joined payload; its newline count is always `payload.length - 1`. */
    let usedBytes = utf8Bytes(payload[0]!);
    let truncated = false;
    const omitted: string[] = [];
    let omittedEdges = 0;

    /**
     * Does `lines` fit, keeping `reserveLines`/`reserveBytes` free for elements appended later?
     * Both caps are measured on the string that is actually joined, so every line costs its UTF-8
     * bytes plus one newline separator.
     */
    const fits = (lines: readonly string[], reserveLines: number, reserveBytes: number): boolean => {
      let bytes = 0;
      for (const line of lines) bytes += utf8Bytes(line) + 1;
      return (
        payload.length - 1 + lines.length + reserveLines <= MAX_PAYLOAD_LINES &&
        usedBytes + bytes + reserveBytes <= MAX_PAYLOAD_BYTES
      );
    };

    /**
     * Commits a whole block or nothing: a truncated file block would leave the XML unbalanced.
     * A dropped block is recorded in `omitted`, so a file never silently looks empty.
     * ponytail: a block that does not fit is dropped entirely rather than partially emitted; the
     * omission record still names it. Emitting a partial block with a synthetic closing tag would
     * recover the remaining signatures if this matters.
     */
    const commit = (block: string[], label?: string): boolean => {
      if (!fits(block, TAIL_RESERVE_LINES, TAIL_RESERVE_BYTES)) {
        truncated = true;
        if (label !== undefined) omitted.push(label);
        return false;
      }
      for (const line of block) {
        payload.push(line);
        usedBytes += utf8Bytes(line) + 1;
      }
      return true;
    };

    for (const entity of entities) {
      const [rawPath = "", symbol = ""] = entity.split("::");
      const abs = await realpath(path.resolve(rawPath)).catch(() => null);
      // Confinement: reads never leave the workspace root, which also rejects symlinks that escape it.
      if (!abs || !withinRoot(abs, root)) continue;
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue; // directories, FIFOs, devices, oversized files
      const rel = toRel(abs);

      let rootNode: TsNode;
      let source: string;
      try {
        source = await readFile(abs, "utf8");
        // ponytail: silently skip unreadable/unparseable targets — a single bad path shouldn't fail the whole graph.
        // The MCP layer reports unmatched entities to the caller, so this stays honest at the tool boundary.
        const tree = (await parserFor(abs)).parse(source);
        if (!tree) continue;
        rootNode = tree.rootNode;
      } catch {
        continue;
      }

      let signatures = signaturesOf(rootNode);
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

      const block = [`<file path="${esc(rel)}">`];
      for (const signature of signatures) {
        const owner = signature.owner ? ` in="${esc(signature.owner)}"` : "";
        const params = signature.params ? ` params="${esc(signature.params)}"` : "";
        const returns = signature.returns ? ` returns="${esc(signature.returns)}"` : "";
        block.push(`<${signature.kind}${owner} name="${esc(signature.name)}"${params}${returns}/>`);
      }
      block.push("</file>");
      commit(block, rel);

      for (const child of rootNode.namedChildren) {
        if (!child || (child.type !== "import_statement" && child.type !== "export_statement")) continue;
        const specifier = child.childForFieldName("source")?.text.replace(/^['"]|['"]$/g, "");
        if (!specifier?.startsWith(".")) continue;
        const target = await resolveImport(abs, specifier, root);
        if (!target) continue;
        const key = `${rel}\u0000${target}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push([rel, target]);
      }
    }

    // Edge lines are self-closing, so committing them individually keeps the XML balanced.
    for (const [from, to] of edges) {
      if (!commit([`<edge from="${esc(from)}" to="${esc(to)}"/>`])) omittedEdges++;
    }

    /** Code-point clamp: slicing never splits a surrogate pair, and the element marks the clamp. */
    const omissionRecord = (rel: string): string => {
      const points = [...rel];
      const clamped = points.length > MAX_OMITTED_PATH_CHARS;
      const shown = clamped ? `${points.slice(0, MAX_OMITTED_PATH_CHARS).join("")}\u2026` : rel;
      return `<omitted path="${esc(shown)}"${clamped ? ' path-truncated="true"' : ""} reason="payload-cap"/>`;
    };

    const closing = "</graph>";
    if (!truncated) {
      payload.push(closing);
    } else {
      // Exact counts, so a dropped block is never presented as a file with no declarations.
      const summary =
        `<truncated payload="partial" graph="complete" max-lines="${MAX_PAYLOAD_LINES}"` +
        ` max-bytes="${MAX_PAYLOAD_BYTES}" omitted-files="${omitted.length}" omitted-edges="${omittedEdges}"/>`;
      // Path records take whatever the summary and closing tag leave (no reserve left to hold back);
      // a record that does not fit is skipped, and the counts in `summary` still account for it.
      const named: string[] = [];
      for (const rel of omitted) {
        const record = omissionRecord(rel);
        if (!fits([...named, record, summary, closing], 0, 0)) continue;
        named.push(record);
      }
      for (const record of named) payload.push(record);
      payload.push(summary, closing);
    }

    return { nodes: [...nodes.values()], edges, verbatimPayload: payload.join("\n") };
  }
}
