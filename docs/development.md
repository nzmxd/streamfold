# 开发与发布

> 适用版本：归页 Streamfold 0.7.7

## 1. 环境

- Node.js 22.21.1 或更高的兼容版本
- pnpm 10.x；仓库声明的版本为 10.24.0
- Windows、macOS 或 Linux 桌面环境

安装依赖并启动开发模式：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 由 electron-vite 同时启动主进程、preload 和 Renderer。首次运行会在 Electron 用户数据目录的 `social-vault` 中创建数据库和 Chromium 数据。

## 2. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动开发版桌面应用 |
| `pnpm test` | 运行全部 Vitest 单元/服务测试 |
| `pnpm test:watch` | 监听模式运行 Vitest |
| `pnpm test:ui` | 构建后使用 Playwright Electron API 在隔离数据目录中运行界面回归（任务中心、批量预览、矮窗口、插件弹窗、控件和主题） |
| `pnpm typecheck` | 检查 Vue/Renderer 与 Node/Electron TypeScript |
| `pnpm build` | 类型检查并构建到 `out/` |
| `pnpm test:smoke` | 生成当前平台安装目录并执行资源检查、真实 Electron 与 QuickJS 冒烟 |
| `pnpm test:smoke:dev` | 直接使用开发 Electron 执行快速界面冒烟或截图（受本机图形环境影响） |
| `pnpm plugin:official-webhook:verify` | 验证随应用分发的官方 Webhook 包、签名与固定信任信息 |
| `pnpm plugin:official:verify` | 验证随应用分发的全部官方 QuickJS 插件、签名与固定信任信息 |
| `pnpm test:package-plugins -- release` | 检查安装目录中的沙箱入口、QuickJS 依赖和签名插件资源 |
| `pnpm test:package-runtime -- release` | 启动安装目录应用并在真实 Utility Process 中执行 QuickJS Smoke |
| `pnpm test:update-artifacts` | 按环境变量校验更新清单引用、SHA-512、blockmap 和安装目录更新源 |
| `pnpm benchmark:content-search` | 生成 10 万条本地内容并记录 FTS 首屏查询延迟；结果用于回归比较，不作为跨设备承诺 |
| `pnpm preview` | 预览生产构建 |
| `pnpm dist:dir` | 生成未打包安装器的应用目录 |
| `pnpm dist:win` | 生成 Windows NSIS 和 ZIP |
| `pnpm dist:mac` | 生成 macOS DMG 和 ZIP |
| `pnpm dist:linux` | 生成 Linux AppImage 和 `tar.gz` |

安装包输出到 `release/`。应在目标操作系统的原生 runner 上构建对应平台包；本地跨平台打包结果不能替代原生验收。

### 10 万条内容基准

`pnpm benchmark:content-search` 使用确定性内存数据集，排除建库时间，记录而不硬编码跨设备阈值。2026-07-15 的 Windows 最终发布验证以 10 万条内容、20 万条观察和快照运行：普通 FTS 关键词首屏 5 次中位数 `1.54 ms`；20 页内部批量分页读取为 `3671.91 ms`；约 `22.37 MB` CSV 序列化为 `288.60 ms`；全量可靠指标摘要为 `5919.52 ms`。这些数字只用于同环境回归对比，发布验收仍需结合真实磁盘数据库、更多动态指标和目标机器。

## 3. 源码地图

| 路径 | 维护内容 |
|---|---|
| `src/main/index.ts` | 应用启动、窗口、托盘、自定义协议和服务装配 |
| `src/main/ipc.ts` | 管理 IPC、调用者校验和维护状态 |
| `src/main/browser-manager.ts` | 账号窗口、Session、导航保护和 JSON 传输 |
| `src/main/database.ts` | 账号、内容、分析、任务和事务仓库 |
| `src/main/storage/migrations.ts` | SQLite schema 与逐版迁移 |
| `src/main/*-api.ts` | 平台固定端点、严格解析和标准化 |
| `src/main/*-api-service.ts` | 平台锁、限频、任务、头像和提交编排 |
| `src/main/services/` | 账号级执行锁、任务状态机、批量同步队列与统一任务查询 |
| `src/main/plugins/` | Manifest、注册中心、包/目录验证、QuickJS 宿主、权限、事件与生命周期 |
| `packages/plugin-sdk/` | 插件合同、Manifest 构建器、测试宿主和打包签名 CLI |
| `tooling/plugin-catalog-template/` | 可复制到独立目录仓库的 Schema、签名脚本和 CI 工作流 |
| `src/preload/` | 两个本地窗口的最小能力桥接 |
| `src/shared/` | 主进程、preload、Renderer 共用合同 |
| `src/renderer/src/features/` | 工作台、账号、内容、数据、任务、插件、设置和在线更新 UI |
| `resources/icons/`、`build/` | 运行时和安装包图标 |
| `.github/workflows/` | CI 与标签发布流程 |

## 4. 修改业务合同

跨进程能力应按以下顺序修改：

1. 在 `src/shared/*-contracts.ts` 或 `contracts.ts` 定义最小输入、输出和枚举。
2. 在 `src/main/validation.ts` 增加运行时输入解析；不要只依赖 TypeScript 类型。
3. 在主进程服务实现业务规则。
4. 在 `src/main/ipc.ts` 注册固定通道并保持发送者校验。
5. 在 `src/preload/index.ts` 或 `browser.ts` 暴露窄化方法。
6. 在 Renderer 调用业务方法，不直接构造 Electron IPC。
7. 为合同解析、服务状态和界面展示增加测试。

不要把文件路径、任意 URL、任意 JavaScript、数据库对象、`ipcRenderer` 或 Session 对象暴露给 Renderer。

## 5. 开发插件和平台适配器

普通第三方插件通过 Manifest v2、SDK 和签名目录接入，不应修改 `src/main/index.ts`、`BrowserManager`、Renderer 平台枚举或数据库提交代码。平台信息、固定 JSON 端点、捕获规则、图片域名和原帖 URL 模板都由 `platform.adapter` 贡献点声明，账号绑定具体贡献点。

开发流程、入口方法、标准数据集、权限、QuickJS 限制、打包签名、目录 PR 和开发者模式统一见[开放插件系统](plugin-system.md)。小红书和知乎属于可信内置实现；修改它们仍需更新[平台适配器](platform-adapters.md)并完成真实本人账号验收。

## 6. 数据采集实现规则

- 只接受固定 JSON API 或精确匹配的页面 Fetch/XHR JSON 响应。
- 不解析 DOM、HTML 或页面可见文本，不增加 DOM 回退。
- 不接收手动 Cookie、请求头、请求正文或平台数据文件。
- 不复刻或逆向平台签名；需要页面请求上下文时让官方页面正常发起请求，只读取目标 JSON 响应。
- 适配器先严格解析为平台类型，再转换为标准化数据；未知或缺失指标使用 `null`。
- 采集前后都验证稳定身份，返回结果只能整体事务提交。
- 所有列表必须有内容上限、页数上限、响应大小上限和重复 ID 检查。
- 错误信息进入 UI 前应清洗，不能泄漏文件路径、内部网络详情或平台响应正文。

## 7. 数据库变更

不要直接修改旧迁移。增加 schema 时：

1. 提升 `CURRENT_SCHEMA_VERSION`。
2. 新增一个从前一版本到新版本的幂等迁移函数。
3. 在 `BEGIN IMMEDIATE` 事务中执行迁移并最后设置 `PRAGMA user_version`。
4. 补充全新数据库、旧版本升级、失败回滚和重开测试。
5. 更新[运行架构](architecture.md)中的表结构及备份兼容说明。

数据库写入由主进程拥有。跨表同步使用 `commitManagedSync()` 一类事务方法，不在 Renderer 或平台解析层拆散写入。

## 8. 测试策略

当前测试按以下边界组织：

- 纯解析：平台端点、字段、分页、原帖 URL、异常响应和大小限制。
- 浏览器传输：CDP 事件、请求匹配、响应正文、后台 workspace lease 与 Session 隔离。
- 服务：插件启用、身份预览、互斥、限频、错误状态、任务和头像缓存。
- 任务：批次原子创建、分组解析、临时范围、同适配器串行、跨适配器并行、取消、重试、失败处置、日历 cadence 和重启恢复。
- 数据库：v0 → v16 迁移、约束、事务、快照/观察、FTS、可靠分析、备份恢复和账号隔离。
- Renderer：展示映射、筛选、图表、排版、侧栏和弹窗行为。
- Electron smoke：`app://` 页面、preload API、主题、更新 API、两个账号 Partition 隔离、浏览器 User-Agent 和图标。
- Electron UI 回归：任务中心最小窗口、批量同步预览、矮窗口设置卡片、Webhook 权限与配置弹窗、复选框/开关状态、弹窗滚动和 `Esc` 关闭、浅色/深色主题。

提交前建议至少执行：

```powershell
pnpm test
pnpm sdk:test
pnpm typecheck
pnpm build
pnpm test:ui
pnpm benchmark:content-search
pnpm test:smoke
pnpm plugin:official:verify
git diff --check
```

网络相关平台验收不应加入默认 CI，也不要在测试夹具中保存真实 Session、Cookie 或响应中的个人信息。

## 9. CI、打包与发布

`.github/workflows/ci.yml` 在 `master`、`main` 的推送与 Pull Request 上使用 Node.js 22.21.1、pnpm 10.24.0 和冻结锁文件执行应用与 SDK 测试、官方插件校验、类型检查、生产构建和 Electron UI 回归。该最低补丁版本规避了 Windows 上旧版实验性 `node:sqlite` 关闭后仍占用 WAL/数据库文件的问题。

`.github/workflows/release.yml` 支持手动打包和版本标签发布：

- 手动触发只生成保留 14 天的 Actions 构件，不创建 Release。
- 标签必须是严格的稳定 SemVer，例如 `v0.7.0`，并与 `package.json` 版本一致。
- Windows、macOS、Linux 在各自原生 runner 上打包；三个任务都成功后才汇总 Release。
- 每个平台打包后都会检查 `plugin-sandbox.js`、QuickJS 运行资源和官方签名 Webhook 包。
- 已发布的同名 Release 拒绝覆盖；失败运行留下的同名 draft 会在重跑时删除并重新创建，完整上传后再标记为 latest。

远程插件目录是可选能力。配置 Actions Variable `STREAMFOLD_PLUGIN_CATALOG_ROOT_KEY`（Ed25519 SPKI DER Base64）后，目录 URL 固定为同一 GitHub 所有者的 `https://<owner>.github.io/streamfold-plugins/catalog.json`；未配置时工作流会把 URL 和根公钥同时编译为空，“发现”页显示未配置，但不阻塞内置插件、签名 Webhook 或应用发布。根私钥不得进入仓库或 Actions。

官方 Webhook 与 X 适配器源码位于 `tooling/builtin-plugins`，提交的签名包位于 `resources/plugins`。日常验证运行 `plugin:official:verify`；只排查旧 Webhook 时仍可使用兼容命令。需要重签时，通过 `STREAMFOLD_OFFICIAL_PLUGIN_PRIVATE_KEY_FILE` 指向受保护的 Ed25519 私钥后运行 `plugin:official:build`；私钥不得进入仓库、Actions 构件或安装包。

| 平台 | 用户构件 | 在线更新资产 | 应用内更新边界 |
|---|---|---|---|
| Windows | NSIS `.exe`、`.zip` | `latest.yml`、安装包和 blockmap | NSIS 安装版；ZIP 手动更新 |
| macOS | `.dmg`、`.zip` | 无 | 当前构件未签名，使用 DMG/ZIP 手动更新；完成 Developer ID 签名与公证后再启用应用内更新 |
| Linux | `.AppImage`、`.tar.gz` | `latest-linux.yml`、AppImage | 仅 AppImage；`tar.gz` 手动更新 |

工作流还生成 `SHA256SUMS.txt`。Windows/Linux 打包会解析 `latest*.yml`，逐项核对其引用文件、大小、SHA-512、blockmap，以及安装目录 `app-update.yml` 中的 GitHub owner/repo；不能只验证文件名存在。

### 客户端更新行为

只有标签工作流生成、包含 `app-update.yml` 且构建时明确启用更新的正式安装包才会连接更新源。默认启动 15 秒后检查，此后每 6 小时检查；发现版本后后台下载，必须由用户确认才重启安装。开发版、目录构建、未签名 macOS 构件和 Linux `tar.gz` 不执行应用内更新；Windows 以 NSIS 安装版为正式验收目标。

更新源是公开 GitHub Release，客户端不保存 GitHub Token。私有仓库需要分发读取凭据，不符合当前安全边界。Renderer 无权修改更新源、版本或安装文件；恢复数据库等业务操作进行时，主进程拒绝重启安装。

### 正式发布清单

1. 提升 `package.json` 版本；已经分发过的版本号不得复用。
2. 执行 `pnpm test`、`pnpm sdk:test`、`pnpm typecheck`、`pnpm build`、`pnpm test:ui`、`pnpm benchmark:content-search`、`pnpm test:smoke`、`pnpm plugin:official:verify` 与 `git diff --check`。
3. 确认没有提交 `.env`、证书、密钥、SQLite、Session、真实响应或个人数据。
4. 使用 `git commit -S` 创建签名提交，并使用 `git tag -s` 创建与版本完全一致的签名稳定标签。
5. 核对三个平台构件、Windows/Linux `latest*.yml`、blockmap、校验和及 draft Release，再正式发布。
6. 使用两个不同版本的正式安装包完成一次真实在线更新验收。

当前工作流关闭证书自动发现，默认构件未签名。正式对外分发前应完成 Windows Authenticode、macOS Developer ID 签名与 Apple 公证，并把签名凭据放入受保护的 GitHub Environment 或 Actions Secrets；不要提交证书、密码或令牌。

## 10. 当前状态与后续

已完成：

- 多账号隔离 Session、独立账号浏览器、后台 workspace lease 与登录失效提升窗口。
- 小红书、知乎和 X 的本人身份、资料、内容、指标与官方原帖链接同步。
- 账号整理、FTS5 内容检索、收藏与批量标签、筛选导出、可靠趋势分析和加密数据库备份恢复。
- v0 → v16 数据库迁移、自动化测试、生产构建与 Electron smoke。
- 账号/分组批量同步、持久排队与重试链、账号和适配器互斥、失败处置、统一任务中心与托盘任务摘要。
- 插件间隔/每天/每周/每月计划、本地时区执行、错过周期合并和连续失败熔断。
- Manifest v2、签名包/目录、QuickJS Utility Process、权限代理、事件 Outbox、计划队列、真实签名 Webhook 资源和 SDK/CLI。
- 三平台构建配置、GitHub CI/Release 工作流和客户端在线更新状态机。

尚未完成：

- 微博、抖音 Session API 适配器和真实本人账号验收。
- 小红书多页大账号、空作品、更多登录失效与 429/461/471 在线场景。
- 知乎空列表、真实 401/403/429 与账号切换在线场景。
- Windows/macOS 正式签名、公证，macOS 应用内更新，以及从较低正式版本升级到后续版本的真实验收。
- 媒体文件备份、XLSX 导出、分组拖拽和浏览器窗口位置恢复。

下一阶段优先完成三个已开放平台的真实多账号与长时间运行验收，建立签名插件目录，再补齐安装包代码签名和跨版本在线升级验收。详细版本范围、技术改造和验收门槛见[产品路线图](roadmap.md)。
