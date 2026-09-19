import type { CompactedGraph, TopoNode } from "./core/compactor.js";
import { TopoCompactor } from "./core/compactor.js";
import type { DecisionSchema, RouterOutputShape } from "./core/decision.js";
import { TopoDecisionRouter } from "./core/decision.js";

export { TopoCompactor } from "./core/compactor.js";
export type { CompactedGraph, TopoNode } from "./core/compactor.js";
export { TopoDecisionRouter } from "./core/decision.js";
export type { DecisionSchema, DecisionField, RouterOutputShape } from "./core/decision.js";

export interface IngressResult<T extends RouterOutputShape> {
  decision: T;
  contextForFrontierLLM: string;
}

export { CodeCompactor } from "./compactors/code-compactor.js";
export { JevRouter } from "./routers/jev-router.js";
export type { JevRouterConfig } from "./routers/jev-router.js";
export { OllamaRouter } from "./routers/ollama-router.js";
export type { OllamaRouterConfig } from "./routers/ollama-router.js";

export class FastTopoRouter<T extends RouterOutputShape> {
  constructor(
    private readonly compactor: TopoCompactor,
    private readonly router: TopoDecisionRouter<T>,
  ) {}

  /** 框架统一入口：物理裁剪（等高线剪枝）→ 强类型业务分支路由 */
  async processIngress(entities: string[], decisionSchema: DecisionSchema): Promise<IngressResult<T>> {
    const graph = await this.compactor.compact(entities);
    const decision = await this.router.route(graph, decisionSchema);
    return { decision, contextForFrontierLLM: graph.verbatimPayload };
  }
}
