# Pi Desktop 阶段 6、7 实施记录

本文记录 `pi-desktop-architecture-optimization-solution.md` 阶段 6、7 在现有阶段 0-5 基础上的兼容实现。目标是把模型配置、历史读取和发布流程继续收敛到可替换的边界，不改变 Pi 0.83.0 的默认运行链路。

## 阶段 6：Model Gateway 与性能

### 已实现

- `desktop-core/src/model-gateway.ts` 提供 `ModelGateway`、模型协议、能力和凭据策略归一化。
- `ModelProfile` 增加可选的 `protocol`、`capabilities`、`credentialStrategy`；SQLite schema migration 3 保存这些元数据，仍只保存 `credentialRef`。
- `desktop-core/src/application.ts` 在启动 runtime 前通过 Model Gateway 解析 secret，Pi bridge 只接收短时 `apiKey`，公开状态和普通数据库不包含密钥明文。
- `desktop-pi-bridge/src/rpc-port.ts` 导出 `buildPiModelsJson()`，把通用模型能力翻译成 Pi `models.json`，并以环境变量引用密钥。
- `sessions.list` 支持 `limit/cursor`，`agent.getMessages` 支持消息分页；新增 `sessions.listAll`，Renderer 项目历史刷新优先使用一次 bulk 查询，旧 Host 自动回退到兼容路径。
- Renderer 将 `message.delta` 合并到单个消息节点，在 animation frame 内只更新对应 article；需要新增/删除节点时才执行完整消息区刷新。
- `PerformanceMetrics` 提供 bounded samples、平均值和 P95，供启动、命令、长会话和 Renderer 基线记录使用，不保存消息或工具参数。

### 验收命令

```powershell
npm run check
npm run test:desktop-core
npm run test:desktop-storage
npm run test:desktop-pi-bridge
node --check apps/desktop/src/renderer/app.js
```

## 阶段 7：迁移、发布与回滚

### 已实现

- `desktop-storage/src/migration.ts` 生成 provider/codec/session 兼容报告；只读扫描 Pi JSONL，不覆盖原始事实源。
- `apps/desktop/scripts/session-migration.ts` 提供 `migrate:sessions` 命令，可将扫描报告写入受限权限的 JSON 文件。
- SQLite 启动前继续执行 `backupBeforeMigration()`；发布 manifest 明确 sidecar、原子升级、启动失败回滚、保留用户数据和卸载策略。
- `release-preflight.mjs` 校验 release manifest、Node/sidecar 版本、Electron/Host/打包输入和回滚声明。Windows 签名仅在 `RELEASE_REQUIRE_SIGNING=1` 时成为门禁，未签名 NSIS 包可用于本地回归。
- Windows 目标收敛为已验证的 x64 NSIS；macOS 目标仍标记为需要签名和公证，不将未验证目标当作现状。

### 迁移和发布门禁

```powershell
npm run migrate:sessions --workspace=@earendil-works/pi-desktop -- <session-directory> <report.json> [metadata.sqlite]
npm run release:preflight --workspace=@earendil-works/pi-desktop
npm run package:windows --workspace=@earendil-works/pi-desktop
```

迁移失败时保留原始 Pi JSONL、SQLite backup 和报告；`historyAccess` 会明确区分 `continue`、`read-only`、`import-required`、`missing`，不会静默丢弃历史。

## 当前发布验证边界

阶段 7 已具备可重复的预检、备份、迁移报告和 Windows x64 NSIS 输入检查。真实安装/卸载、托盘、单实例、快捷键、Host/Pi child process 和空目录冷启动仍应在生成安装包后按发布矩阵逐项记录；签名和 macOS 公证不在本地未配置凭据时伪造为通过。

本轮实际发布回归记录：

- `Pi-Desktop-Setup-0.1.0-win11-x64.exe`，123,627,038 bytes。
- SHA-256：`9793FF62DC48C24BCBF7DB8168AA7D70E1B0FD04B302F55134D6BC78342C16B1`。
- 打包资源存在：`host.mjs`、`rpc-entry.mjs`、`main.mjs`、`dark.json`、`light.json`。
- 从独立工作目录启动打包 `rpc-entry.mjs`，`get_state` 返回 `success: true`；未执行真实安装器 UI、卸载和签名门禁，避免把未验证目标写成已验证事实。
