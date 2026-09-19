import type { CompactedGraph } from "./compactor.js";

/** 强类型路由输出：只允许标量分支值，不生成自由文本 */
export type RouterOutputShape = Record<string, string | number | boolean>;

/** 决策 schema 中单个问题的形状：类型 + 可选枚举约束 */
export interface DecisionField {
  type: "string" | "number" | "boolean";
  enum?: readonly (string | number | boolean)[];
  description?: string;
}

export type DecisionSchema = Record<string, DecisionField>;

export abstract class TopoDecisionRouter<T extends RouterOutputShape> {
  /**
   * @param graph 第一阶段输出的精简拓扑图
   * @param schema 期望小模型返回的强类型 JSON 结构（Jev 哲学：100ms 内出分支）
   */
  abstract route(graph: CompactedGraph, schema: DecisionSchema): Promise<T>;
}
