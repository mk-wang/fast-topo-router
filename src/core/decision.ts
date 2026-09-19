import type { CompactedGraph } from "./compactor.js";

/** Strongly-typed router output: scalar branch values only, no free text */
export type RouterOutputShape = Record<string, string | number | boolean>;

/** Single decision field definition: scalar type + optional enum constraint */
export interface DecisionField {
  type: "string" | "number" | "boolean";
  enum?: readonly (string | number | boolean)[];
  description?: string;
}

export type DecisionSchema = Record<string, DecisionField>;

export abstract class TopoDecisionRouter<T extends RouterOutputShape> {
  /**
   * @param graph Compacted topology graph from phase 1
   * @param schema Strongly-typed schema expected from the fast decision model (~100ms branching)
   */
  abstract route(graph: CompactedGraph, schema: DecisionSchema): Promise<T>;
}
