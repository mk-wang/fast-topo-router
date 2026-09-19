# fast-topo-router

[English](README.md) | 中文

面向终端 AI Agent（Claude Code、Omp、Codex）的确定性、强类型上下文路由网关。

两阶段前置流水线——在前沿模型看到你的工作区**之前**运行的门禁：

1. **拓扑裁剪器**（Ripwire 哲学）：静态剪掉约 85% 的无关工作区熵，压缩成高密度子图——函数签名 + import 依赖边，零函数体。
2. **战术路由器**（Jev 哲学）：对子图做**强类型**决策（布尔 / 枚举分支，不生成自由文本），绕过嘈杂的多轮 LLM 探索，削减 token 账单，保护 prompt 缓存。

真实 TS 仓库实测：**输入 token 减少 81~90%**，裁剪约 30ms，单次 Jev 决策端到端约 550ms（`bun run bench`）。

## 安装与快速开始

```sh
bun install
```

```ts
import { CodeCompactor, FastTopoRouter, JevRouter } from "fast-topo-router";

const gateway = new FastTopoRouter(
  new CodeCompactor(),                        // Tree-sitter 骨架提取器（TS/TSX）
  new JevRouter(),                            // TypeSafe Jev API；读取 JEV_KEY 环境变量
);

const { decision, contextForFrontierLLM } = await gateway.processIngress(
  ["src/foo.ts"],
  {
    is_critical_dependency: { type: "boolean", description: "改动该文件是否会引发上游模块崩溃？" },
    recommended_test_action: { type: "string", enum: ["Unit", "Integration", "None"] },
  },
);
// decision: { is_critical_dependency: false, recommended_test_action: "Unit" }
// contextForFrontierLLM: 供 Agent 上下文使用的精炼 XML 骨架
```

## 组件

| 组件 | 模块 | 后端 |
|---|---|---|
| `TopoCompactor` / `TopoDecisionRouter` | `src/core/` | 抽象契约，零依赖——自带实现 |
| `CodeCompactor` | `src/compactors/` | web-tree-sitter WASM，TS/TSX |
| `JevRouter` | `src/routers/` | TypeSafe Jev API（`JEV_KEY`） |
| `OllamaRouter` | `src/routers/` | 本地 Ollama，零依赖，无需 API key |

设计基线：[`documents/blueprint.md`](documents/blueprint.md)。

## 开发

```sh
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run build       # 产出 dist/
bun run bench       # token 节省 / 延迟基准（1 次 Jev API 调用）
```

## 许可证

MIT
