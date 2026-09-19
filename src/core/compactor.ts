/**
 * Topology compactor engine: prunes large, multidimensional workspaces
 * into a minimal structure tree containing only topological relations and metadata.
 */
export interface TopoNode {
  id: string; // Unique entity identifier (e.g. function name, file path)
  metadata: {
    churn?: number; // Change frequency / churn
    complexity?: number; // Cyclomatic complexity
    [key: string]: unknown;
  };
}

export interface CompactedGraph {
  nodes: TopoNode[];
  edges: [string, string][]; // Directed dependency edges [[caller, callee]]
  verbatimPayload: string; // Pruned high-density context for frontier LLM consumption
}

export abstract class TopoCompactor {
  /** Concrete extractors implement physical pruning (codebases, legal docs, financial graphs, etc.) */
  abstract compact(targetEntities: string[]): Promise<CompactedGraph>;
}
