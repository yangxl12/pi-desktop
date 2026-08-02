# Pi Desktop 阶段 0 基线

本文是 `pi-desktop-architecture-optimization-solution.md` 阶段 0 的可重复基线记录。它冻结当前默认 runtime 的事实，不把未来替代引擎、远程 runtime、并行 runtime 或跨平台凭据支持当成已经实现的能力。

## 已冻结事实

- 默认 Pi runtime 版本：`0.83.0`，来源为 `packages/desktop-pi-bridge/package.json` 的 `@earendil-works/pi-coding-agent` 依赖。
- RPC 入口通过 `import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")` 定位；Host 可用 `PI_DESKTOP_RPC_ENTRY` 覆盖入口。
- RPC 使用 LF 分隔的 JSONL。请求类型、响应形状和 `get_state`、`get_messages`、`get_commands`、`prompt`、`steer`、`follow_up`、`abort`、session、model、thinking 命令见 `packages/desktop-pi-bridge/src/rpc-types.ts`。
- Pi 事件在 `packages/desktop-pi-bridge/src/normalize.ts` 归一化为 ready/state/message/tool/abort/error/diagnostic 事件；阶段 2 的 `AgentEvent` 只在 core 边界增加 runtime-neutral 名称，旧事件值保持兼容。
- Pi session JSONL 是 transcript 的事实源，fixture 为 `packages/desktop-pi-bridge/test/fixtures/pi-0.83-session.jsonl`。SQLite 只保存可重建的 metadata index。
- 运行时资源至少包括 RPC bundle、`dist/modes/interactive/theme/dark.json`、`light.json` 和 renderer/lucide 资源；打包脚本必须在 smoke 前检查文件存在。

## 不可回归清单

每次阶段改造都应执行并记录以下结果：

1. `npm run check` 通过。
2. `npm run test:desktop-protocol`、`npm run test:desktop-core`、`npm run test:desktop-pi-bridge`、`npm run test:desktop-storage` 和 `npm run test:desktop-mcp` 通过。
3. `npm run spike --workspace=@earendil-works/pi-desktop` 能输出当前 Node、Pi RPC 入口、默认快捷键和 MCP 传输报告。
4. 真实 Pi RPC 能完成启动、ready、prompt streaming、abort、session switch、model/thinking 设置和正常退出；敏感值不能出现在事件或诊断中。
5. `PiSessionFileRepository` 能读取本文件并从 `message` entries 重建摘要；坏 JSONL 只进入 diagnostics，不阻塞其他 session。
6. Host `/api/state`、`/api/events`、`/api/command` 的鉴权、错误状态码和 SSE 重连行为符合阶段 1 契约。
7. 纯源码启动和 Electron/打包启动都检查 Pi 子进程、主题 JSON、renderer 和单实例生命周期。

## 决策门

以下决定仍需产品/发布范围确认，当前实现不隐式假设：

| 决策 | 当前默认 | 影响 |
| --- | --- | --- |
| 第一批替代 runtime | 未决定；阶段 2 只提供 fake contract provider | 不承诺远程 HTTP/WebSocket 数据驻留和账号方案 |
| 旧 Pi session | 继续保留原 JSONL；阶段 0-2 仍以 Pi 路径兼容 | 只读/import-required 状态留到 Session Codec 阶段 |
| Host 端口 | loopback 固定端口 + 每次启动随机 token | Electron 和纯浏览器开发路径都必须携带 cookie/token；动态端口协商留后续阶段 |
| runtime 并行度 | 单活动 runtime | 不引入 Runtime Pool 或跨项目并行资源上限 |
| 模型协议 | 现有 Pi openai-compatible 配置 | Anthropic/local/multimodal 属于 Model Gateway 阶段 |
| MCP consent | 默认拒绝 | 真实 ConsentBroker、策略粒度和撤销方式属于 ToolGateway 阶段 |
| Linux 凭据 | 当前使用内存 store | 不把不安全保存伪装成持久 OS secret 能力 |
| 发布目标 | 先验证现有 Windows x64 路径 | macOS/Linux、签名、自动更新和回滚需单独门禁 |

## 可重复命令

在仓库根目录运行：

```text
npm run check
npm run test:desktop-protocol
npm run test:desktop-core
npm run test:desktop-pi-bridge
npm run test:desktop-storage
npm run test:desktop-mcp
npm run spike --workspace=@earendil-works/pi-desktop
```

开发 Host 使用 `npm run dev --workspace=@earendil-works/pi-desktop`，默认监听 `http://127.0.0.1:4317`。Electron 开发脚本使用独立的 `.pi-dev/desktop-dev` 和 `4318`，不得覆盖生产 Pi 状态。
