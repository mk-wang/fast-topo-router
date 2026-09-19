/**
 * 拓扑图裁剪引擎：把庞大、多维的文件及数据，
 * 压缩成只包含拓扑关联、质量元数据的极简结构树。
 */
export interface TopoNode {
  id: string; // 实体唯一标识（函数名、文件路径等）
  metadata: {
    churn?: number; // 变更活跃度
    complexity?: number; // 圈复杂度
    [key: string]: unknown;
  };
}

export interface CompactedGraph {
  nodes: TopoNode[];
  edges: [string, string][]; // 有向调用链 [[caller, callee]]
  verbatimPayload: string; // 供大模型最终阅读的裁剪后黄金上下文
}

export abstract class TopoCompactor {
  /** 子类实现具体的物理提取逻辑（代码库、法律文书、财务图谱等） */
  abstract compact(targetEntities: string[]): Promise<CompactedGraph>;
}
