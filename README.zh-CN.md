# fast-topo-router

[English](README.md) | 中文

面向终端 AI Agent（Claude Code、Omp、Codex）的确定性、强类型上下文路由网关。

可选的代码导航与模型建议组件，不替代正常工程检查：

1. **拓扑裁剪器**（Ripwire 哲学）：提取签名与 import 依赖边用于定位；修改代码前仍须读取相关实现。
2. **战术路由器**（Jev 哲学）：提供强类型模型建议。格式正确不等于判断正确，建议不能授权跳过必要测试或审查。

真实 TypeScript 仓库实测（`bun run bench`），基线为 Agent 全文读取目标文件 + 其一跳 import：

| 目标 | Agent 全文读取 | 经网关裁剪后 | 节省 |
|---|---|---|---|
| 3 个源文件 | 约 7,500 tokens | 约 740 tokens | **-90%** |
| 全 7 文件模块 | 约 7,700 tokens | 约 1,400 tokens | **-81%** |

以上是历史样本，token 按字符数/4 估算，不代表实际计费节省或任务端到端加速。裁剪约 30ms，Jev 请求约 0.5–0.8s；本地 Ollama 耗时尚未测量。

## 安装与快速开始

```sh
bun install
```

下面的库调用示例会显式请求远端 Jev。MCP 默认也保留路由功能，操作者可用 `TOPO_ENABLE_ROUTING=0` 关闭。

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

## 在 Codex / Omp / Claude Code 中使用（MCP）

MCP server 提供可选的本地导航，不替代正常文件读取：

```sh
bun run build
codex mcp add fast-topo-router -- node /abs/path/fast-topo-router/dist/mcp/server.js
```

默认提供 `topo_compact` 和 `topo_route`，操作者可用 `TOPO_ENABLE_ROUTING=0` 关闭路由，
服务端同时阻止工具发现和直接调用。正常采用有效路由判断，不强制主模型重判一遍。
技术失败时返回建议不可用并保留已有骨架，不伪造 `None`/`false`；原本必需的检查不变。
兜底与外发说明见 [`documents/integration-mcp.md`](documents/integration-mcp.md)。

## 开发

```sh
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run build       # 产出 dist/
bun run bench       # token 节省 / 延迟基准（1 次 Jev API 调用）
```

## 许可证

MIT
