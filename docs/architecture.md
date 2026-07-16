# 运行架构

> 适用版本：归页 Streamfold 0.7.0
>
> 更新日期：2026-07-15
>
> 本文同时汇总进程、数据库与安全边界；产品方案取舍见[设计决策](design-decisions.md)。

## 1. 技术栈与入口

| 层 | 当前实现 | 主要入口 |
|---|---|---|
| 桌面运行时 | Electron 43 | `src/main/index.ts` |
| 管理界面 | Vue 3 + TypeScript | `src/renderer/src/App.vue` |
| 构建 | electron-vite 5、Vite 7 | `electron.vite.config.ts` |
| 本地数据库 | Node.js `node:sqlite` | `src/main/database.ts` |
| 数据库迁移 | `PRAGMA user_version`，当前 v16 | `src/main/storage/migrations.ts` |
| 安装包 | electron-builder | `package.json` 的 `build` 配置 |
| 在线更新 | electron-updater | `src/main/update-service.ts` |
| 测试 | Vitest + 源码/安装目录 Electron smoke | `*.test.ts`、`scripts/smoke*.mjs` |

`src/main/index.ts` 是组合根：创建数据库、浏览器管理器、平台适配器、任务查询、批量队列、插件自动化、导出、备份、设置和更新服务，并把这些服务注册到受限 IPC。

## 2. 进程与信任边界

```mermaid
flowchart LR
    UI["Vue 管理界面\napp://shell"] --> PRELOAD["管理 preload\n固定业务 API"]
    PRELOAD --> IPC["主进程 IPC\n来源和参数校验"]
    IPC --> SERVICES["账号、内容、插件、设置、\n备份、更新等服务"]
    SERVICES --> DB[("social-vault.sqlite")]
    SERVICES --> MEDIA[("profile-media 缓存")]
    SERVICES --> BM["BrowserManager"]
    BM --> TOOLBAR["本地浏览器工具栏\napp://browser"]
    BM --> REMOTE["远程平台页面\nWebContentsView"]
    REMOTE --> API["官方 HTTPS JSON API"]
    SERVICES --> UPDATE["公开 GitHub Release\n独立更新链路"]
```

### 管理窗口

- 从自定义安全协议 `app://shell` 加载本地构建产物。
- 开启 `contextIsolation`、`sandbox` 和 `webSecurity`，关闭 Node 集成、`webviewTag` 和拖放导航。
- `src/preload/index.ts` 只暴露 `SocialVaultApi` 中声明的方法，不暴露原始 `ipcRenderer`。
- `src/main/ipc.ts` 同时校验主窗口 `webContents`、主框架和 `app://shell` 来源，并对所有输入执行白名单解析。

### 账号浏览器窗口

账号浏览器不是嵌入主界面的网页区域，而是一个独立 `BrowserWindow`：

- 顶部工具栏从 `app://browser` 加载，使用单独的 `src/preload/browser.ts`。
- 平台页面运行在工具栏下方的 `WebContentsView` 中，不加载 preload，也没有 IPC、Node.js、数据库或文件系统能力。
- 每个账号只保留一个 workspace；再次打开会聚焦现有窗口。
- 远程视图禁用 DevTools、下载、站点权限、弹窗和非官方顶层导航。

## 3. 账号会话与浏览器生命周期

账号创建时生成 UUID，并固定使用：

```text
persist:social:<account_uuid>
```

该持久 Session Partition 隔离 Cookie、缓存、LocalStorage、IndexedDB 和 Service Worker。关闭账号浏览器窗口不会清除 Session；“退出登录”会清理该 Partition 的认证缓存、网络缓存和全部站点存储；“永久删除”还会删除本地账号及其关联数据。

核验或同步不要求用户预先打开窗口。`BrowserManager` 为操作获取 workspace lease：

1. 有现成 workspace 时复用。
2. 没有时在后台创建不可见 workspace，并准备平台同源页面。
3. 会话有效时完成操作并在最后一个 lease 释放后销毁纯后台 workspace。
4. 登录失效时把同一个 workspace 提升为可见窗口，供用户在官方页面重新登录。

应用不会从外部 Chrome 读取登录数据，也不会把 Session 写入 SQLite 或加密备份。

## 4. 平台同步分层

同步代码分成四层：

| 层 | 职责 | 当前实现 |
|---|---|---|
| 平台路由 | 根据账号绑定的贡献点选择适配器 | `platform-sync-service.ts`、`plugins/platform-adapter-registry.ts` |
| 插件宿主 | Manifest、授权、QuickJS、事件、计划和包生命周期 | `src/main/plugins/` |
| 事务服务 | 锁、限频、身份状态、任务、头像和数据库提交 | 内置平台服务、`plugins/sandbox-platform-adapter.ts` |
| API 与解析 | 固定端点、分页、字段校验、标准化和身份前后复验 | 内置平台模块、签名 QuickJS 适配器 |
| 浏览器传输 | 同源固定 GET 或精确 XHR/Fetch JSON 响应捕获 | `browser-manager.ts` |

小红书和知乎继续使用可信内置 TypeScript 实现；随应用签名分发的 X 适配器与第三方适配器使用相同 Manifest v2 合同，在独立 Utility Process 的 QuickJS 上下文运行。所有适配器都由动态扩展注册中心发现，账号绑定具体贡献点。QuickJS 入口只能调用声明并获授权的 `platform.getJson` / `platform.captureJson`，不能取得页面或 Session 对象。完整合同与供应链见[开放插件系统](plugin-system.md)。

### JSON 数据传输

当前只有两条数据路径：

1. 在账号自己的已登录页面环境中，对固定白名单端点执行同源 `GET`。
2. 对需要平台页面生成请求上下文的接口，使用 Chromium DevTools Protocol 的 `Network` 域捕获按固定路径或声明式 GraphQL 操作名精确匹配的 Fetch/XHR JSON 响应。

第二条路径只使用请求方法和 URL 来匹配响应，再读取响应正文；不会从页面 DOM 或 HTML 提取数据。响应在进入业务模型前还会校验协议、主机、路径、状态码、Content-Type、大小、分页、ID、计数和字符串长度。

## 5. 主动同步与持久队列

```mermaid
sequenceDiagram
    participant U as 用户
    participant R as Renderer
    participant S as 平台事务服务
    participant B as BrowserManager
    participant P as 平台 JSON API
    participant D as SQLite
    U->>R: 单账号同步或创建账号/分组批次
    R->>S: accounts:sync / accounts:enqueue-sync-batch
    S->>D: 原子创建批次与排队任务
    S->>S: 按账号与适配器取得执行锁
    S->>S: 校验插件、授权、互斥与最小间隔
    S->>D: 创建或接管 managed_sync 任务并标记 running
    S->>B: 获取账号 workspace lease
    B->>P: 同步前读取并校验身份
    B->>P: 获取资料、内容和可见指标
    B->>P: 同步后再次校验身份
    S->>S: 严格解析并标准化
    S->>D: 单事务提交资料、内容、快照和成功任务
    S-->>R: 返回统计与提示
    S->>B: 释放 workspace lease
```

关键约束：

- 新账号默认不授权同步；首次身份绑定后仍需用户在账号设置中启用。
- 同一账号的核验、账号同步和需要该 Session 的插件任务互斥；同一适配器串行，不同适配器可以并行。
- 小红书插件最小间隔为 60 秒；知乎插件最小间隔为 300 秒。
- 采集前后身份必须与本地 `remote_id` 一致，采集期间切换账号会使整次同步失败。
- `commitManagedSync` 会在事务内再次核对账号授权范围、任务状态和插件启用状态。
- 内容按 `(account_id, remote_id)` 去重；完全未变化的连续指标不会新增内容快照。

`SyncBatchService` 把每个账号保存为独立任务，使用 `AsyncLocalStorage` 把预创建任务交给现有适配器，因此批量执行仍复用同一身份复验、限频和原子提交链路。排队任务在重启后继续执行；残留的校验/提交任务转为 `interrupted`，旧记录不会被覆盖。只有排队状态可取消，失败或中断重试会创建带 `retry_of_job_id` 的新尝试。

`TaskQueryService` 只读聚合 `jobs` 与 `plugin_runs`，向 Renderer 提供统一摘要、筛选、批次和详情。失败记录不可变且永久保留；`task_attention_resolutions` 单独记录用户处置，后续同类任务成功时自动消解旧失败，只有未解决项进入“需要处理”。插件宿主继续提供持久事件 Outbox 和计划队列；计划支持间隔、每天、每周和每月 cadence，按系统本地时区计算，错过多个周期只补跑一次。所有事件/定时计划默认关闭，由用户选择账号或分组后启用。账号批量同步目前由用户主动发起。

## 6. 本地数据与媒体

主数据库位于 Electron 用户数据目录下的 `social-vault.sqlite`。为兼容旧版本，应用名称虽然已经改为 Streamfold，用户数据目录仍固定为 `social-vault`。

平台头像不直接交给 Renderer 下载。`ProfileMediaStore` 会校验允许的 CDN、逐跳重定向、MIME、文件头、声明大小和实际大小，再按 SHA-256 内容哈希写入 `profile-media`。Renderer 只能通过 `app://shell/media/...` 读取缓存。

### 主要数据表

| 表 | 用途与关键约束 |
|---|---|
| `accounts` | 平台身份、本地整理、状态、同步授权与唯一 Session Partition；同平台非空远端 ID 不重复 |
| `groups` / `account_groups` | 分组及账号多对多关系；删除分组不删除账号 |
| `account_snapshots` | 关注、粉丝、内容数及账号指标时间序列；缺失指标为 `NULL` |
| `account_metric_definitions` | 平台账号周期指标的名称、值类型、单位、分组和稳定排序 |
| `account_metric_snapshots` / `account_metric_values` | 每日、7/14/30 天与累计账号指标；支持平台状态、缺失值、负数关注者转化和同周期修订 |
| `contents` | 标准化内容、API 摘要、官方原帖 URL、本地备注、收藏和最近观察时间；账号内远端 ID 唯一 |
| `content_snapshots` | 内容指标时间序列；连续指标完全相同时跳过重复快照 |
| `content_tags` | 内容本地标签；随内容级联删除 |
| `content_observations` | 每次成功同步返回内容的观察凭据，关联任务和可选指标快照 |
| `content_metric_semantics` | 按适配器贡献点和包哈希固化的指标测量语义与标准映射 |
| `content_fts` | 标题、摘要、备注和标签的可重建 FTS5 trigram 外部内容索引 |
| `plugin_installations` / `plugin_contributions` | 包来源、签名状态、版本、贡献点与启用状态 |
| `plugin_grants` / `plugin_configs` | 贡献点授权、配置和加密 Secret 状态 |
| `plugin_schedules` | 用户启用的账号/分组计划、间隔或日历 cadence、连续失败与熔断状态 |
| `plugin_events` / `plugin_event_deliveries` | 事务后 Outbox、至少一次投递、重试和幂等 ID |
| `plugin_runs` | 手动、事件和定时运行记录 |
| `job_batches` | 批量同步的稳定 ID、触发来源、临时同步范围和创建时间 |
| `jobs` | 账号同步任务、批次绑定、适配器、尝试次数、重试链、阶段与结果 |
| `task_attention_resolutions` | 失败任务的用户处置状态；不修改不可变任务历史 |
| `sync_cursors` | 预留的分页/增量游标；当前主动同步按安全上限重新读取 |
| `app_settings` | 主题、更新、导出、备份和恢复时间等本机设置 |

SQLite 以 `DatabaseSync` 打开，关闭扩展加载并启用 defensive、外键与 WAL。主要账号从表使用 `ON DELETE CASCADE`；Chromium Partition 和头像文件由主进程服务另行清理。

schema 通过 `PRAGMA user_version` 逐版迁移，当前为 v16。迁移在 `BEGIN IMMEDIATE` 事务中执行；数据库版本高于应用支持版本时拒绝打开。v9 增加开放插件数据，v10 删除不可达的文件导入批次表，v11 新增任务批次与重试元数据，v12 新增平台动态内容指标定义和快照值表，v13 新增账号周期指标定义、快照和值表，v14 增加计划 cadence，v15 增加任务失败处置，v16 增加内容收藏/标签、观察、版本化指标语义和 FTS5 索引。既有账号、内容、快照和任务历史不删除；旧快照没有采集过的扩展指标保持未知。

`raw_retention_days` 目前没有原始平台响应存储或清理消费者，也不代表支持 JSON/CSV 平台数据导入。

## 7. 安全控制

安全设计假设平台页面、网络响应和 Renderer 都不可信：

- 管理窗口和本地工具栏启用 `contextIsolation`、sandbox 与 `webSecurity`，关闭 Node 集成和 `webviewTag`。
- 远程平台视图没有 preload、IPC、Node.js、数据库或文件系统能力；拒绝权限、下载、新窗口、无效 TLS 与 HTTP Basic/Digest 登录提示。
- 顶层导航和重定向使用平台精确 HTTPS hostname 白名单；平台所需的安全子框架资源不按顶层主机规则拦截。
- 每个 IPC 通道固定，并校验发送窗口、主框架、`app://` 来源和运行时参数结构。
- 业务参数在 Renderer 跨越 `contextBridge` 前先去除响应式代理并编码为受限 JSON；Preload 再校验通道白名单、载荷大小和嵌套深度后才调用 Electron IPC。
- Renderer 不能传入数据库路径、任意文件路径、更新源、任意平台 URL、任意脚本、Cookie 或 Session 对象。
- 平台响应进入模型前校验协议、主机、路径、方法、查询参数、状态、Content-Type、大小、分页、ID 和字段范围。
- 原帖打开前再次匹配平台、内容类型、远端 ID、官方主机和固定路径。

SQLite 主文件当前未静态加密，应结合操作系统账号、磁盘加密和文件权限保护。JSON/CSV 导出为明文；`.svbackup` 使用 AES-256-GCM 与 scrypt。正式分发仍需 Windows/macOS 代码签名与 Apple 公证，更新清单哈希不能替代发布者签名。

## 8. 导出、备份与恢复

- JSON/CSV 导出由 `ExportService` 从标准化数据库记录生成；JSON schema v3 包含账号周期指标历史，CSV 会处理中英文逗号、引号、换行和表格公式前缀。
- `.svbackup` 由 `BackupService` 从脱敏后的 SQLite 临时副本生成，使用 AES-256-GCM 与 scrypt 加密；副本会清除插件 Secret，把第三方插件、贡献点和计划置为待重新安装状态，并剥离可重建的 FTS 索引以缩小便携备份。
- 创建或恢复备份会拒绝仍在运行的账号/插件后台任务；恢复随后进入全局维护状态、暂停新调度并关闭账号浏览器，在临时数据库完成格式、schema、完整性和外键校验并重建 FTS 后才替换现有数据库。
- Session Partition、头像文件和 `.streamfold-plugin` 包不进入数据库备份；恢复后会清理相关会话并要求重新核验，第三方插件需从目录重新安装并重新填写 Secret。

## 9. 在线更新

更新服务只在有 `app-update.yml` 的正式安装包中启用；开发、smoke/review、缺少更新源以及非 AppImage 的 Linux 包均标记为不支持，不发起检查。

- 默认启动 15 秒后检查，此后每 6 小时检查。
- 发现版本后自动后台下载，安装必须由用户确认。
- 更新服务使用 electron-updater 的应用级网络链路，不复用任何社媒账号 Session。
- Renderer 不能指定更新源、版本或文件路径。
- 数据恢复或其他受跟踪业务操作运行时，主进程拒绝重启安装。

发布端约束见[开发与发布](development.md)。

## 10. 代码目录

```text
src/
├─ main/                 Electron 主进程、服务、数据库和平台适配器
│  ├─ plugins/           扩展注册、沙箱、权限、事件、目录和包生命周期
│  ├─ services/          账号执行锁、任务状态机、批量队列和统一任务查询
│  └─ storage/           SQLite 迁移
├─ preload/              管理窗口与账号浏览器的窄化桥接
├─ renderer/             Vue 管理界面与浏览器工具栏
│  └─ src/features/      工作台、账号、内容、分析、任务、插件、设置和更新模块
└─ shared/               IPC 两侧共用的合同和枚举
```

开发、测试和发布步骤见[开发与发布](development.md)，平台端点与字段见[平台适配器](platform-adapters.md)。
