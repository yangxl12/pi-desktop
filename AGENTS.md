# Pi Desktop 开发指南

本文件适用于整个仓库。目标是让改动保持小、可验证，并守住现有分层边界。

## 项目概览

Pi Desktop 是独立的 npm workspaces + TypeScript 项目，由 Electron 壳、Node Host、原生 JavaScript Renderer 和 Pi RPC 子进程组成。仓库不包含 Pi 源码；运行时来自 `desktop-pi-bridge` 中精确锁定的 npm 依赖。

- `apps/desktop`：应用装配、HTTP Host、Electron 主进程、Renderer 和打包脚本。
- `packages/desktop-protocol`：跨层命令、事件、实体、错误码和运行时校验。
- `packages/desktop-core`：平台无关的业务编排、状态和 Port 接口。
- `packages/desktop-pi-bridge`：Pi RPC、LF 分隔 JSONL、事件归一化和崩溃恢复。
- `packages/desktop-storage`：SQLite 元数据和 Pi session JSONL 索引。
- `packages/desktop-mcp`：MCP STDIO/HTTP 客户端、工具策略和限制。
- `doc`：架构与发布背景；若文档和代码冲突，以当前代码、manifest 和测试为准。

推荐阅读顺序：`renderer/app.js` -> `desktop-protocol` -> `host/main.ts` -> `desktop-core/application.ts` -> `desktop-core/ports.ts` -> 对应 adapter。

## 快速开始

要求 Node.js `>=22.19.0`，使用根目录 lockfile。

```powershell
npm install --ignore-scripts

# 只启动 Host，浏览器访问 http://127.0.0.1:4317
npm run dev --workspace=@earendil-works/pi-desktop

# 启动完整 Electron 开发端，使用隔离的 .pi-dev 数据和 4318 端口
npm run dev:desktop --workspace=@earendil-works/pi-desktop
```

不要提交或手工修改 `node_modules/`、`dist/`、`.pi-dev/`、`.pi-desktop/` 等生成物和本地数据。

## 架构规则

1. 依赖方向保持为 `protocol <- core <- adapters <- apps/desktop`。`core` 不得依赖 Electron、SQLite、MCP SDK 或 Pi 内部实现。
2. 跨层功能按 `protocol -> core -> adapter/host -> renderer` 修改，并同步补测试。不要在 Renderer 中复制领域规则。
3. Pi 专属的 CLI 参数、RPC 命令、事件和资源解析留在 `desktop-pi-bridge`；会话格式解析留在 storage 的 Pi 边界。
4. 禁止引用相邻的 `../pi` checkout。Pi 只能使用 registry 中的精确版本；升级按 `doc/pi-runtime-upgrade.md` 同时更新 manifest、lockfile 并做 RPC smoke test。
5. Pi RPC 必须保持严格的 LF 分隔 JSONL 和 request id 关联。session JSONL 是会话事实源，SQLite 只是可重建索引，不要双写完整 transcript。
6. 密钥只留在 Host/系统凭据存储中；日志、诊断、公开 state 和 Renderer 都不得出现 secret。保持 loopback token、Origin 校验和 Electron sandbox 边界。
7. Renderer 当前是原生 HTML/CSS/JavaScript。除非任务明确要求，不引入新的前端框架或构建链。

## 编码与改动习惯

- 先读相关实现、测试和 `git status`，保留用户已有改动；只修改任务需要的文件。
- 使用 ESM、TypeScript 严格类型和 `node:` 内置模块导入。Biome 采用 tab 缩进、120 字符行宽。
- 通过 workspace 包名跨包导入，不从其他包的 `src` 深层路径取实现细节。
- 变更公开命令、事件或错误时保持兼容，先更新 schema/types，再更新生产者和消费者。
- 测试放在对应 workspace 的 `test/`；修 bug 时至少增加一个能复现问题的回归测试。
- 不静默吞错。对外返回稳定错误码，对内记录已脱敏且可定位的诊断信息。

## 验证

先运行受影响 workspace 的测试，再执行仓库级检查：

```powershell
# 示例：单个 workspace
npm run test --workspace=@earendil-works/pi-desktop-core

# 所有已有 workspace 测试
npm run test --workspaces --if-present

# 解耦检查、Biome 格式/静态检查、TypeScript no-emit
npm run check

git diff --check
```

注意：`npm run check` 包含 Biome `--write`，可能格式化源码，运行后必须检查 diff。UI/运行时改动还要启动完整 Electron 流程做实际 smoke test；打包改动需额外运行 `release:preflight` 和对应打包流程，并验证产物内的 RPC 与主题资源。

完成时说明改了什么、运行了哪些命令、结果如何，以及仍未验证的风险；不要把“代码能编译”当作桌面流程已经可用。
