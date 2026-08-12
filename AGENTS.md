# Pi Desktop 开发指南

适用于整个仓库。目标是让改动保持小、可验证，并守住现有分层边界。

## 项目概览

npm workspaces + TypeScript 项目：Electron 壳、Node Host、原生 JavaScript Renderer、Pi RPC 子进程。仓库不含 Pi 源码；运行时来自 `desktop-pi-bridge` 中精确锁定的 npm 依赖。

- `apps/desktop`：装配、HTTP Host、Electron、Renderer、打包。
- `packages/desktop-protocol`：跨层命令、事件、实体、错误码和运行时校验。
- `packages/desktop-core`：平台无关的业务编排、状态和 Port 接口。
- `packages/desktop-pi-bridge`：Pi RPC、LF 分隔 JSONL、事件归一化、崩溃恢复。
- `packages/desktop-storage`：SQLite 元数据和 Pi session JSONL 索引。
- `packages/desktop-mcp`：MCP 客户端、工具策略和限制。
- `doc`：架构与发布背景；与代码冲突时以代码、manifest 和测试为准。

推荐阅读顺序：`renderer/app.js` → `desktop-protocol` → `host/main.ts` → `desktop-core/application.ts` → `desktop-core/ports.ts` → 对应 adapter。

## 快速开始

Node.js `>=22.19.0`，使用根目录 lockfile。

```powershell
npm install --ignore-scripts

# 仅启动 Host，浏览器访问 http://127.0.0.1:4317
npm run dev --workspace=@earendil-works/pi-desktop

# 完整 Electron 开发端，隔离 .pi-dev 数据和 4318 端口
npm run dev:desktop --workspace=@earendil-works/pi-desktop
```

不提交或手改 `node_modules/`、`dist/`、`.pi-dev/`、`.pi-desktop/` 等生成物和本地数据。

## 架构规则

1. 依赖方向保持 `protocol <- core <- adapters <- apps/desktop`。`core` 不得依赖 Electron、SQLite、MCP SDK 或 Pi 内部实现。
2. 跨层功能按 `protocol -> core -> adapter/host -> renderer` 修改并同步补测试；领域规则不复制进 Renderer。
3. Pi 专属的 CLI 参数、RPC 命令、事件和资源解析留在 `desktop-pi-bridge`；会话格式解析留在 storage 的 Pi 边界。
4. 禁止引用相邻 `../pi` checkout。Pi 只用 registry 精确版本；升级按 `doc/pi-runtime-upgrade.md` 同步 manifest、lockfile 并做 RPC smoke test。
5. Pi RPC 保持严格 LF 分隔 JSONL 和 request id 关联。session JSONL 是会话事实源，SQLite 只是可重建索引，不要双写完整 transcript。
6. 密钥只留在 Host/系统凭据存储；日志、诊断、公开 state 和 Renderer 不得出现 secret。保持 loopback token、Origin 校验和 Electron sandbox 边界。
7. Renderer 保持原生 HTML/CSS/JavaScript；除非任务明确要求，不引入新框架或构建链。

## 编码与改动习惯

- 先读实现、测试和 `git status`，保留用户已有改动；只修改任务需要的文件。
- 使用 ESM、TypeScript 严格类型和 `node:` 导入；Biome 用 tab 缩进、120 字符行宽。
- 通过 workspace 包名跨包导入，不从其他包 `src` 深层路径取实现细节。
- 变更公开命令、事件或错误时保持兼容，先更新 schema/types，再更新生产者和消费者。
- 测试放对应 workspace 的 `test/`；修 bug 至少增加一个能复现的回归测试。
- 不静默吞错。对外返回稳定错误码，对内记录已脱敏且可定位的诊断。

## 调试与排查

- 改了渲染层"却还报错"，先 Ctrl+Shift+R 强刷：`npm run dev` 只重启 Host，不会给已打开的标签页推送新 JS；重启服务端不等于刷新页面。
- 渲染层报错优先复现而非猜测：用仓库自带 Electron 二进制写小脚本（`loadURL` + 监听 `console-message` + `executeJavaScript` 模拟点击）抓真实报错。
- `/api/*` 需要 loopback token：先 GET `/` 取 `pi_desktop_token` cookie，再带 WebSession 请求；无 token 一律 401。
- Biome 只检查 TS，renderer 的 JS/HTML/CSS 无自动测试；改动后至少 `node --check` + Electron 冒烟验证。

## 验证

先运行受影响 workspace 的测试，再执行仓库级检查：

```powershell
# 单个 workspace
npm run test --workspace=@earendil-works/pi-desktop-core

# 所有已有 workspace 测试
npm run test --workspaces --if-present

# 解耦检查、Biome 格式/静态检查、TypeScript no-emit
npm run check

git diff --check
```

注意：`npm run check` 含 Biome `--write`，运行后必须检查 diff。UI/运行时改动需启动完整 Electron 流程做 smoke test；打包改动需跑 `release:preflight` 和对应打包流程，并验证产物内 RPC 与主题资源。

完成时说明改了什么、运行了哪些命令、结果如何、仍未验证的风险；不要把"代码能编译"当作桌面流程已可用。
