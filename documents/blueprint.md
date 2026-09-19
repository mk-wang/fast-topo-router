# fast-topo-router 设计蓝图

> 通用 Agent 前置网关：图结构物理裁剪 + 强类型高速战术决策。
> 本文档是项目的 canonical 设计基线；后续设计文档统一放 `documents/`。

## 定位

为 Claude Code / Omp / Codex 等终端 Agent 服务的 **Smart Ingestion & Gatekeeping Layer**。
与 fast-jev-compaction（事后清理）不同，本框架是**事前拦截与门禁（Pre-Ingestion Guard）**：

- 保护 prompt 缓存——输入在到达前沿模型前已裁剪干净，不触发 compaction 导致 cache miss。
- 高确定性——用代码级有向图提供决策支持，避免 Agent 盲目 grep 迷失调用链。

## 两阶段过滤流水线

### 第一层：Topology-driven Space Committer（`TopoCompactor`，Ripwire 哲学）

- 对工作区做无损、高速静态骨架提取，产出带权依赖图。
- 确定性算法（AST / 调用图 / churn 活跃度）剪掉约 90% 无关路径。
- 输出 `CompactedGraph`：节点（id + churn/complexity 等元数据）+ 有向边 + `verbatimPayload`（供大模型阅读的精炼 XML 黄金上下文，不含实现细节噪音）。

### 第二层：TypeSafe Tactical Router（`TopoDecisionRouter`，Jev 哲学）

- 接收精简图，不做自然语言总结，直接转化为强类型问题。
- 低成本低延迟模型（Jev API 或本地 Ollama 强约束输出）在 ~100ms 内返回类型化分支，
  例如 `{"is_critical_dependency": true, "recommended_test_action": "Unit"}`。
- `DecisionSchema` 对每个字段声明类型与枚举约束，输出只允许标量。

### 第三层：Agent 消费

- 框架把「黄金代码骨架 + 确定性测试建议」打包交给前沿 Agent。
- Agent 不再自行探索 call tree 或盲目全量跑测，直接精准编码 + 单跑指定测试。

## 代码骨架

```
src/
  core/
    compactor.ts   # TopoNode / CompactedGraph / TopoCompactor（抽象类，冻结边界）
    decision.ts    # RouterOutputShape / DecisionSchema / TopoDecisionRouter（抽象类，冻结边界）
  compactors/
    code-compactor.ts  # CodeCompactor：Tree-sitter TS/TSX 骨架提取
  routers/
    ollama-router.ts   # OllamaRouter：本地 Ollama 强类型分支路由
  index.ts         # FastTopoRouter.processIngress(entities, schema) + 公共导出
tests/             # vitest 测试与 fixtures（不进 tsconfig include）
documents/
  blueprint.md     # 本文档
```

## MVP 状态（2026-09-19）

两个 MVP 均已落地并通过 `typecheck + vitest + build` 门禁：

1. **CodeCompactor**：web-tree-sitter + tree-sitter-wasms，TS/TSX 签名骨架 + import 边 + XML
   payload。已知上限（源码内 `ponytail:` 注释）：无调用链边、无 churn 元数据、仅相对路径
   import。web-tree-sitter 锁定 0.25.10——0.27 与 tree-sitter-wasms 0.1.13 的 wasm 不兼容，
   升级任一需成对验证。
2. **OllamaRouter**：零依赖 fetch → `/api/chat`，DecisionSchema 转 JSON Schema 结构化输出，
   逐字段类型 + 枚举校验，违规即抛错。已知上限：无重试/修复循环。
3. **JevRouter**（`src/routers/jev-router.ts`）：TypeSafe Jev API（`POST /v1/systemone`，Bearer，
   默认读 `JEV_KEY` 环境变量）。boolean→noul、string+enum→choice；number/无枚举 string 无
   Jev 映射直接抛错。已用真实 key 完成端到端冒烟（本仓库源文件 → 决策
   `{"is_critical_dependency":false,"recommended_test_action":"Unit"}`，全程 <1s）。

## 实测效果（bench/bench.ts，`bun run bench`）

| 目标集 | 基线（全文+一跳 import） | 裁剪后 | 节省 | compact | route (Jev) |
|---|---|---|---|---|---|
| fast-jev-compaction 3 文件 | ~7486 tok | ~741 tok | -90.1% | 31ms | 779ms |
| fast-jev-compaction 全 7 文件 | ~7668 tok | ~1429 tok | -81.4% | 24ms | 553ms |

token 为 chars/4 估算。决策为单次 Jev API 调用，端到端 <1s。

下一步候选：真实仓库端到端冒烟（compactor → router → Ollama 本地模型）、调用链边、MCP 服务封装。
