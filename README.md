# Social Vault

面向个人社媒账号的数据管理与统计客户端。产品使用内置 Chromium 管理本人账号的登录会话，通过只读平台插件采集本人资料、本人内容及其统计数据。

当前已完成首个可运行 MVP：账号、分组、备注、SQLite、本地受控 IPC 和安全内置 Chromium 已落地。真实平台身份识别与数据采集插件尚未接入，避免在审计完成前触碰真实账号数据。

## 设计文档

- [调研与总体设计](docs/research-and-design.md)：GitHub 非官方接口调研、平台接入判断、技术架构、插件协议、数据模型与安全边界。
- [界面与功能设计](docs/interface-and-feature-design.md)：信息架构、账号分组与备注、内置浏览器、内容中心、数据分析、插件中心及版本优先级。
- [可交互界面原型](prototypes/social-account-manager.html)：账号分组、账号切换、数据总览、内置浏览器、内容数据和备注设置的交互演示。
- [MVP 实现状态](docs/implementation-status.md)：当前已经实现、尚未实现、安全边界和验收结果。
- [文档索引](docs/README.md)：文档阅读顺序和后续文档规划。

## 当前核心决策

- 桌面端采用 Electron、Vue 3 和 TypeScript。
- 使用 Electron 内置 Chromium，不要求用户安装或连接外部浏览器。
- 主窗口采用“账号列表 + 账号详情”双栏布局；每个账号的 Chromium 页面在独立大窗口中运行，不嵌入狭窄详情栏。
- 登录只进入已审核的平台官方 HTTPS 页面；登录阶段不运行采集插件，证书或域名异常时立即停止。
- 每个账号使用独立持久化 Session Partition，隔离登录凭证和站点存储。
- 平台能力以只读插件形式接入，采集前校验当前登录账号归属。
- 本地别名、分组、标签和备注仅保存在本机，不写回社媒平台。
- 默认使用 SQLite 本地存储，不考虑收费 API、收费代理或验证码服务。
- 不承诺账号风险为零；平台拒绝托管 Chromium 登录时不修改 UA、不伪造指纹，也不导入外部浏览器 Cookie 绕过限制。

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
pnpm preview
```

首次运行会在 Electron 的用户数据目录创建 `social-vault.sqlite`。登录 Cookie 由每个账号自己的 Chromium Session Partition 保存，不写入该 SQLite 数据库。
