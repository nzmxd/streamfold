# 开发与发布

> 适用版本：归页 Streamfold 0.4.0

## 1. 环境

- Node.js 22.13.0 或更高的 22.x 版本
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
| `pnpm typecheck` | 检查 Vue/Renderer 与 Node/Electron TypeScript |
| `pnpm build` | 类型检查并构建到 `out/` |
| `pnpm test:smoke` | 生产构建后启动真实 Electron 做隔离和界面冒烟 |
| `pnpm preview` | 预览生产构建 |
| `pnpm dist:dir` | 生成未打包安装器的应用目录 |
| `pnpm dist:win` | 生成 Windows NSIS 和 ZIP |
| `pnpm dist:mac` | 生成 macOS DMG 和 ZIP |
| `pnpm dist:linux` | 生成 Linux AppImage 和 `tar.gz` |

安装包输出到 `release/`。应在目标操作系统的原生 runner 上构建对应平台包；本地跨平台打包结果不能替代原生验收。

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
| `src/main/plugins/registry.ts` | 内置平台插件清单与可用状态 |
| `src/preload/` | 两个本地窗口的最小能力桥接 |
| `src/shared/` | 主进程、preload、Renderer 共用合同 |
| `src/renderer/src/features/` | 六个业务页面和在线更新 UI |
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

## 5. 新增平台适配器

当前插件系统是“内置适配器注册表”，不是动态加载目录。新增平台通常涉及：

1. **平台定义**：在 `src/shared/contracts.ts` 增加平台 ID，在 `src/main/platforms.ts` 增加官方登录页、主页和精确主机清单。
2. **传输合同**：定义适配器只需要的 `getJson`/响应捕获接口，不让服务直接拿到 `WebContents`。
3. **API 层**：新增 `<platform>-api.ts`，集中维护端点、分页、响应上限、字段解析和身份前后复验。
4. **浏览器传输**：在 `BrowserManager` 中实现固定同源 GET 或精确 XHR/Fetch JSON 响应捕获，并验证最终 URL、状态和 Content-Type。
5. **事务服务**：新增 `<platform>-api-service.ts`，实现 `SessionApiPlatformService` 的 `verifyIdentity`、`confirmIdentity`、`sync`、互斥和限频。
6. **插件清单**：在 `src/main/plugins/registry.ts` 声明能力、允许主机、最小间隔、风险级别和可用状态。
7. **平台路由**：在 `src/main/index.ts` 的 `PlatformSyncService` 组合中注册适配器。
8. **测试与验收**：覆盖传输白名单、异常响应、身份变化、分页完整性、事务回滚，再用本人测试账号完成真实响应验收。
9. **文档**：更新[平台适配器](platform-adapters.md)，并在平台状态表中明确可用范围。

只有完成真实账号身份、空列表、分页、登录失效、限流和账号切换验收后，才能把清单从 `planned` 改为 `available`。

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
- 数据库：迁移、约束、事务、快照去重、分析、备份恢复和账号隔离。
- Renderer：展示映射、筛选、图表、排版、侧栏和弹窗行为。
- Electron smoke：`app://` 页面、preload API、主题、更新 API、两个账号 Partition 隔离、浏览器 User-Agent 和图标。

提交前建议至少执行：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm test:smoke
git diff --check
```

网络相关平台验收不应加入默认 CI，也不要在测试夹具中保存真实 Session、Cookie 或响应中的个人信息。

## 9. CI、打包与发布

`.github/workflows/ci.yml` 在 `master`、`main` 的推送与 Pull Request 上使用 Node.js 22.13.0、pnpm 10.24.0 和冻结锁文件执行测试、类型检查与生产构建。

`.github/workflows/release.yml` 支持手动打包和版本标签发布：

- 手动触发只生成保留 14 天的 Actions 构件，不创建 Release。
- 标签必须是严格的稳定 SemVer，例如 `v0.5.0`，并与 `package.json` 版本一致。
- Windows、macOS、Linux 在各自原生 runner 上打包；三个任务都成功后才汇总 Release。
- 已存在同名 Release 时拒绝覆盖；发布先创建 draft，完整上传后再标记为 latest。

| 平台 | 用户构件 | 在线更新资产 | 应用内更新边界 |
|---|---|---|---|
| Windows | NSIS `.exe`、`.zip` | `latest.yml`、安装包和 blockmap | NSIS 安装版；ZIP 手动更新 |
| macOS | `.dmg`、`.zip` | `latest-mac.yml`、ZIP 和 blockmap | 需要签名应用；DMG 用于首次/手动安装 |
| Linux | `.AppImage`、`.tar.gz` | `latest-linux.yml`、AppImage | 仅 AppImage；`tar.gz` 手动更新 |

工作流还生成 `SHA256SUMS.txt`。`latest*.yml` 中的 SHA-512 是 electron-updater 发现和校验资源所必需的资产，不能只上传安装包。

### 客户端更新行为

只有标签工作流生成、包含 `app-update.yml` 的正式受支持安装包启用更新。默认启动 15 秒后检查，此后每 6 小时检查；发现版本后后台下载，必须由用户确认才重启安装。开发版、目录构建、Windows ZIP 和 Linux `tar.gz` 不执行应用内更新。

更新源是公开 GitHub Release，客户端不保存 GitHub Token。私有仓库需要分发读取凭据，不符合当前安全边界。Renderer 无权修改更新源、版本或安装文件；恢复数据库等业务操作进行时，主进程拒绝重启安装。

### 正式发布清单

1. 提升 `package.json` 版本；已经分发过的版本号不得复用。
2. 执行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm test:smoke` 与 `git diff --check`。
3. 确认没有提交 `.env`、证书、密钥、SQLite、Session、真实响应或个人数据。
4. 提交代码并创建与版本完全一致的稳定标签。
5. 核对三个平台构件、`latest*.yml`、blockmap、校验和及 draft Release，再正式发布。
6. 使用两个不同版本的正式安装包完成一次真实在线更新验收。

当前工作流关闭证书自动发现，默认构件未签名。正式对外分发前应完成 Windows Authenticode、macOS Developer ID 签名与 Apple 公证，并把签名凭据放入受保护的 GitHub Environment 或 Actions Secrets；不要提交证书、密码或令牌。

## 10. 当前状态与后续

已完成：

- 多账号隔离 Session、独立账号浏览器、后台 workspace lease 与登录失效提升窗口。
- 小红书、知乎本人身份、资料、内容、指标与官方原帖链接同步。
- 账号整理、内容检索、趋势分析、JSON/CSV 导出和加密数据库备份恢复。
- v0 → v8 数据库迁移、243 项测试、生产构建与 Electron smoke。
- 三平台构建配置、GitHub CI/Release 工作流和客户端在线更新状态机。

尚未完成：

- 微博、抖音 Session API 适配器和真实本人账号验收。
- 小红书多页大账号、空作品、更多登录失效与 429/461/471 在线场景。
- 知乎空列表、真实 401/403/429 与账号切换在线场景。
- 串行批量同步、定时同步、Retry-After 调度和连续失败熔断。
- Windows/macOS 正式签名、公证，以及公开 GitHub 仓库的首次 Release/在线更新验收。
- 媒体文件备份、XLSX 导出、分组拖拽和浏览器窗口位置恢复。

优先顺序是先补足现有平台异常场景，再实现串行批量同步，最后逐个平台开放新适配器。
