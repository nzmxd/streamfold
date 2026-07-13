# 设计文档索引

## 阅读顺序

1. [调研与总体设计](research-and-design.md)
   - 查看 GitHub 非官方接口方案的取舍。
   - 了解内置 Chromium、Session API 适配器、本地存储与同步边界。
   - 查看账号、内容、指标和同步任务的数据模型。

2. [界面与功能设计](interface-and-feature-design.md)
   - 查看工作台、账号、内容、数据、插件和设置六个模块。
   - 查看账号分组、备注、独立浏览器窗口、身份核验和同步流程。

3. [可交互界面原型](../prototypes/social-account-manager.html)
   - 切换账号分组并搜索账号。
   - 查看账号总览、浏览器入口、内容数据和设置页签。
   - 原型使用静态示例数据，不连接真实平台。

4. [MVP 实现状态](implementation-status.md)
   - 查看当前已完成的账号、内容、统计、插件和浏览器能力。
   - 查看尚未接入的平台、自动同步和发布打包范围。

5. [加密备份与恢复](backup-and-restore.md)
   - 查看 `.svbackup` 的范围、加密参数、回滚和登录会话边界。

6. [小红书 Session API 适配器](xiaohongshu-identity-adapter.md)
   - 查看固定 JSON 接口、作品列表与指标响应捕获、身份核验和停止条件。

## 实现边界

- 账号登录在应用内置 Chromium 的独立窗口中完成，每个账号使用独立持久 Session Partition。
- 平台数据只来自固定 JSON API 或平台页面自身发起的 XHR/Fetch JSON 响应。
- 当前没有平台页面 DOM 解析、手动 JSON/CSV 导入或 Cookie 导入入口。
- 设置页的 JSON/CSV 是本地数据导出；加密备份用于完整 SQLite 备份与恢复，两者都不会导入平台采集数据。

## 文档状态

| 文档 | 状态 | 用途 |
|---|---|---|
| 调研与总体设计 | v0.4 | API 接入策略与架构依据 |
| 界面与功能设计 | v0.4 | 当前页面结构与使用流程 |
| 可交互界面原型 | v0.1 | 关键页面布局与交互验证 |
| MVP 实现状态 | v0.4 | 实现范围、限制和验证结果 |
| 加密备份与恢复 | v0.3 | 完整数据库备份格式与恢复保护 |
| 小红书 Session API 适配器 | v0.4 | 首个平台 API、身份和数据同步说明 |

## 后续建议补充

- `database-schema.md`：SQLite 表结构、索引与迁移策略。
- `security-model.md`：进程隔离、会话边界、接口白名单和插件审计。
- `development-plan.md`：平台接入里程碑、验收标准和测试方案。
- `adr/`：记录关键架构决策及其变更原因。
