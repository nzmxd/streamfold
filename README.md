# 归页 / Streamfold

账号归位，内容成册。归页是一款面向个人社媒账号的数据管理与统计桌面客户端，使用内置 Chromium 管理本人账号的登录会话，通过平台 JSON API 同步本人资料、本人内容和可见统计指标。

当前版本为 `0.4.0`。小红书创作中心的身份核验、资料、账号指标和作品指标已经接入；微博、抖音和知乎保留平台插件入口，尚未开放数据同步。

## 已实现功能

- 管理小红书、微博、抖音和知乎的多个本人账号空间，每个账号使用独立持久 Chromium Session。
- 本地别名、备注、标签、自定义分组、排序、批量分组与暂停、默认账号和同步范围管理。
- 每个账号使用独立的大尺寸浏览器窗口完成官方入口登录，关闭窗口后保留该账号会话。
- 小红书 `xiaohongshu-session-api`：在登录页面同源请求固定 JSON API，并捕获作品管理与数据分析页面发起的签名 JSON 响应。
- API 身份预览与本人确认、同步前后身份一致性检查、登录失效与身份不匹配阻断。
- 资料、账号指标、作品和作品指标快照事务写入；支持 `profile_only`、`recent_20` 和 `recent_100` 三种同步范围。
- 工作台、跨账号内容中心、7/30/90/365 天分析、账号排行和内容类型分布。
- JSON 账号、内容与指标快照结构化导出、CSV 内容导出，以及按账号清空本地历史数据。
- AES-256-GCM + scrypt 加密的完整 SQLite 备份与恢复；备份不包含 Chromium 登录 Session。

平台采集链路只接受 JSON API 数据。项目不提供平台页面 DOM 解析路径，也不提供手动 JSON/CSV 数据导入插件；JSON/CSV 仅用于导出本地统计。

## 设计文档

- [调研与总体设计](docs/research-and-design.md)：GitHub 方案调研、API 接入策略、技术架构、插件边界与数据模型。
- [界面与功能设计](docs/interface-and-feature-design.md)：账号分组与备注、独立浏览器窗口、内容中心、数据分析和插件中心。
- [品牌与界面系统](docs/brand-and-ui-system.md)：归页品牌、浅深色主题、原生标题栏、应用弹窗和账号浏览器设计规范。
- [可交互界面原型](prototypes/social-account-manager.html)：账号列表、账号详情、浏览器入口、内容数据和备注设置的交互演示。
- [MVP 实现状态](docs/implementation-status.md)：当前实现范围、未完成项和验证范围。
- [加密备份与恢复](docs/backup-and-restore.md)：备份范围、密码学参数、数据库回滚和登录会话边界。
- [小红书 Session API 适配器](docs/xiaohongshu-identity-adapter.md)：接口白名单、网络响应采集、身份核验和停止条件。
- [文档索引](docs/README.md)：推荐阅读顺序。

## 当前核心决策

- 桌面端采用 Electron、Vue 3 和 TypeScript，本地数据使用 SQLite。
- 使用 Electron 内置 Chromium，不要求用户安装外部浏览器或扩展。
- 主窗口采用“账号列表 + 账号详情”双栏布局；平台页面在账号独立窗口中运行。
- 每个账号绑定独立 `persist:social:<uuid>` Session Partition。
- 平台插件统一采用 `session_api` 模式，只能访问清单声明的官方 HTTPS 主机与固定接口。
- 普通接口由账号浏览器在创作中心同源发起固定 `GET` 请求；需要页面签名的接口通过 Chromium DevTools Protocol 读取对应 XHR/Fetch 的 JSON 响应。
- 当前只开放小红书适配器；其他平台必须完成单独的接口确认、字段校验和测试账号验收后才能启用。
- 本地别名、分组、标签和备注不写回社媒平台。
- 不采用收费 API、收费代理或验证码服务。

## 本地开发

要求 Node.js 22.13+ 与 pnpm 10+。

```powershell
pnpm install
pnpm dev
```

验证与生产构建：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm test:smoke
pnpm preview
```

首次运行会在 Electron 用户数据目录创建 `social-vault.sqlite`。平台登录状态由账号对应的 Chromium Session Partition 保存，不写入该 SQLite 数据库。
