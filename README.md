# Social Vault

面向个人社媒账号的数据管理与统计客户端。产品使用内置 Chromium 管理本人账号的登录会话，通过只读平台插件采集本人资料、本人内容及其统计数据。

当前版本为 `0.3.0`。在 0.2 的本地数据闭环之上，新增小红书创作中心固定只读 `probe + whoami` 身份核验、分组排序与批量管理，以及完整 SQLite 加密备份恢复。小红书文章与指标读取及其他平台适配器仍保持关闭，等待逐平台专用账号验收。

## 已实现功能

- 管理小红书、微博、抖音和知乎的多个本人账号空间，每个账号使用独立持久 Chromium Session。
- 本地别名、备注、标签、自定义分组、排序、批量分组/暂停、默认账号、同步策略、断开会话和永久删除。
- 工作台、跨账号内容中心、7/30/90/365 天分析、账号排行和内容类型分布。
- 内置、无网络权限的 JSON/CSV 文件导入插件；导入前预览并要求本人数据确认。
- 内容与账号指标快照、重复导入幂等、身份冲突阻断和持久任务记录。
- JSON 账号、内容与指标快照结构化导出，CSV 内容导出，以及按账号清空本地历史数据。
- AES-256-GCM + scrypt 加密的完整 SQLite 备份与恢复；恢复后强制暂停同步并重新核验身份。
- 小红书创作中心登录身份核验：固定脚本版本及 SHA-256，首次绑定需要预览和本人确认，并在提交前再次核验。当前内建脚本只读取可见 DOM；isolated world 用于上下文隔离，不被表述为网络或凭证沙箱。

“官方域名”只表示当前页面通过域名白名单校验，不表示已经登录；“本人已确认”表示用户确认导入文件归属；只有显示“插件已核验”及核验时间才表示专用插件确认了当前可见身份。

## 设计文档

- [调研与总体设计](docs/research-and-design.md)：GitHub 非官方接口调研、平台接入判断、技术架构、插件协议、数据模型与安全边界。
- [界面与功能设计](docs/interface-and-feature-design.md)：信息架构、账号分组与备注、内置浏览器、内容中心、数据分析、插件中心及版本优先级。
- [可交互界面原型](prototypes/social-account-manager.html)：账号分组、账号切换、数据总览、内置浏览器、内容数据和备注设置的交互演示。
- [MVP 实现状态](docs/implementation-status.md)：当前已经实现、尚未实现、安全边界和验收结果。
- [JSON/CSV 导入格式](docs/import-format.md)：字段、限制、安全校验和可直接使用的示例文件。
- [加密备份与恢复](docs/backup-and-restore.md)：备份范围、密码学参数、数据库回滚和登录会话边界。
- [小红书身份核验适配器](docs/xiaohongshu-identity-adapter.md)：固定脚本、隔离执行、核验流程与停止条件。
- [文档索引](docs/README.md)：文档阅读顺序和后续文档规划。

## 当前核心决策

- 桌面端采用 Electron、Vue 3 和 TypeScript。
- 使用 Electron 内置 Chromium，不要求用户安装或连接外部浏览器。
- 主窗口采用“账号列表 + 账号详情”双栏布局；每个账号的 Chromium 页面在独立大窗口中运行，不嵌入狭窄详情栏。
- 登录只进入已审核的平台官方 HTTPS 页面；登录阶段不运行采集插件，证书或域名异常时立即停止。
- 每个账号使用独立持久化 Session Partition，隔离登录凭证和站点存储。
- 平台能力以只读插件形式接入，采集前校验当前登录账号归属。
- 当前可执行插件包括通用文件导入和小红书登录身份核验；微博、抖音、知乎适配器仍为“规划中”。小红书插件当前只做 `probe + whoami`，不读取文章或指标。
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
pnpm test:smoke
pnpm preview
```

首次运行会在 Electron 的用户数据目录创建 `social-vault.sqlite`。登录 Cookie 由每个账号自己的 Chromium Session Partition 保存，不写入该 SQLite 数据库。

可以从 [JSON 示例](examples/social-vault-import.example.json) 或 [CSV 示例](examples/social-vault-import.example.csv) 开始测试导入。导入器拒绝 Cookie、Token、密码、Authorization 等敏感字段，且不会保留原始文件或完整文件路径。
