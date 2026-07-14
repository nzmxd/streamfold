# 平台适配器

> 适用版本：归页 Streamfold 0.6.0
>
> 本文汇总当前可用平台的接口、字段和停止条件。共同的进程、数据库与安全边界见[运行架构](architecture.md)。

## 1. 共同合同

小红书和知乎是可信内置实现，但已注册为 Manifest v2 `platform.adapter` 贡献点并使用统一宿主编排。第三方适配器在 QuickJS 沙箱运行，其合同、权限和发布流程见[开放插件系统](plugin-system.md)。现有两项内置适配器都遵守以下规则：

- 只处理用户在归页中创建、登录并确认归属的本人账号。
- 只使用固定同源 JSON `GET`，或精确匹配的平台 Fetch/XHR JSON 响应。
- 不解析 DOM、HTML 或页面可见文本，不读取 Cookie、请求头、请求正文、密码或验证码。
- 不生成或逆向平台签名，不提供代理轮换、指纹修改和平台写操作。
- 同步前后复验稳定身份；账号切换、分页不完整或结构异常时整次事务不提交。
- 未提供的指标保存为 `null`，不补成零；内容按账号和远端 ID 去重。

同步范围统一为 `profile_only`、`recent_20` 和 `recent_100`。当前只支持用户主动触发，不提供后台定时或批量同步。

## 2. 小红书

插件 ID：`xiaohongshu-session-api`，最小同步间隔 60 秒。

### 接口与数据

| 用途 | 固定来源 | 主要数据 |
|---|---|---|
| 当前身份 | `GET creator.xiaohongshu.com/api/galaxy/user/info` | `redId`、昵称、头像、简介 |
| 创作者资料 | `GET creator.xiaohongshu.com/api/galaxy/creator/home/personal_info` | 小红书号、关注、粉丝、累计获赞与收藏、创作等级 |
| 账号指标 | `GET creator.xiaohongshu.com/api/galaxy/creator/data/note_detail_new` | 7/30 日浏览、互动和新增粉丝 |
| 本人作品 | `/api/galaxy/v2/creator/note/user/posted` | ID、标题、时间、类型和基础指标 |
| 作品分析 | `/api/galaxy/creator/datacenter/note/analyze/list` | 浏览、点赞、收藏、评论和分享 |
| API 摘要 | `GET edith.xiaohongshu.com/web_api/sns/capa/postgw/note/detail` | 校验 `data.id` 后读取 `data.desc` |

身份、资料和账号指标使用已登录创作中心页面中的固定同源请求。作品列表、分析和详情由平台页面产生请求上下文，`BrowserManager` 通过 Chromium DevTools Protocol 捕获精确主机、路径和 Fetch/XHR 类型的 JSON 响应。

摘要只取 JSON `data.desc`，清除控制字符、合并空白并截断到 500 个 Unicode 字符。已保存的非空摘要不重复请求；每次同步最多补取 10 条，相邻详情请求至少间隔 2 秒。公开原帖的签名参数不参与摘要请求。

### 身份与完整性

1. 首次核验同时读取 `user/info` 与 `personal_info`，两个稳定账号 ID 必须一致。
2. 用户在 5 分钟有效期内确认绑定后，适配器再次读取并交叉校验身份。
3. 每次同步前后都复验远端 ID；任一次与本地绑定不一致即回滚。
4. 作品管理列表是内容基线，分析结果只按同一作品 ID 合并。
5. `total`、`has_more`、页码或 `tags[].notes_count` 显示仍有未捕获内容时，适配器继续进行有上限的分页；无法完成目标范围时返回 `INCOMPLETE_CAPTURE`。

单次最多保存 100 条作品。固定接口响应最多 256 KiB，单个捕获响应最多 512 KiB，捕获总量最多 2 MiB。头像只接受小红书或 `xhscdn.com` HTTPS 域名族，经逐跳重定向、MIME、文件头、长度和 512 KiB 上限校验后缓存。

### 错误处理

| 情况 | 行为 |
|---|---|
| 401/403 或登录错误 | 标记需要登录，并显示同一个账号浏览器 workspace |
| 406 或要求未支持签名 | 停止当前操作 |
| 429/461/471 或验证/风控响应 | 停止后续详情请求，任务失败并进入冷却 |
| 可选详情暂时超时 | 保留已有摘要；资料、列表和指标可提交并记录提示 |
| 非 JSON、超限、重复 ID、列表不完整 | 拒绝本次内容提交 |
| 身份变化 | 返回身份不匹配，整次同步回滚 |

已使用本人测试账号完成 8 条作品在线验收：6 条详情 JSON 返回非空摘要，另 2 条平台 `data.desc` 本身为空。

## 3. 知乎

插件 ID：`zhihu-session-api`，版本 0.2.0，最小同步间隔 300 秒。

### 接口与数据

所有请求均在 `https://www.zhihu.com` 第一方页面上下文中执行固定 `GET`：

| 用途 | 接口 |
|---|---|
| 当前身份 | `/api/v4/me?include=url_token` |
| 本人资料 | `/api/v4/members/{url_token}?include=...` |
| 创作中心本人内容 | `/api/v4/creators/creations/v2/all?start=0&end=0&limit=20&offset=...&need_co_creation=1&sort_type=created` |
| 遗留解析参考 | `/api/v4/members/{url_token}/answers`、`articles`、`pins` |

当前同步以创作中心统一列表为主数据源，不会在该接口失败时静默降级到公开成员列表。用户不需要预先打开“内容管理”页面，后台 workspace 会直接发起固定请求。

账号资料映射包括稳定 ID、昵称、头像、简介、关注、粉丝、内容总数、累计获赞与获收藏。回答使用 `answer:{questionId}:{answerId}`，文章使用 `article:{articleId}`；保存标题、API 摘要、阅读、赞同、评论、收藏及经过验证的官方原帖 URL。

### 身份与分页

1. `/api/v4/me` 返回稳定 ID、当前 `url_token` 和昵称。
2. 成员资料中的稳定 ID 与 handle 必须和 `/me` 一致。
3. 首次绑定需要 5 分钟有效的预览确认，确认时再次读取两组数据。
4. `url_token` 只用于当次请求，稳定 ID 才写入 `accounts.remote_id`。
5. 同步前后 `/me` 都必须与本地绑定一致。

`recent_20` 读取一页，`recent_100` 最多读取五页；每页固定 20 条。`paging.next` 必须保持固定路径和查询参数，`offset` 按页大小递增，`is_end`、`totals`、`totals_real` 与实际结果必须一致。重复 URL、异常 offset、重复内容 ID、未知内容类型和分页不完整都会使整次同步失败。

单个列表响应最多 512 KiB，累计最多 2 MiB，请求超时 12 秒。头像仅接受已列入白名单的 `zhimg.com` 图片主机。401/403 或登录重定向会显示同一账号浏览器；429 会停止同步，不循环重试。

已使用本人测试账号完成创作中心两页 32 条内容在线验收，包括 26 篇文章、6 条回答及其阅读、赞同、评论和收藏指标。仍需补充空列表、真实 401/403/429 与登录账号切换场景验收。

## 4. 计划中平台

微博与抖音目前只有官方入口、隔离 Session 和账号浏览器，没有开放数据同步。将插件从 `planned` 改为 `available` 前，必须完成：

- 本人稳定身份接口与登录失效识别；
- 资料、内容、指标的固定 JSON 来源和字段映射；
- 主机、路径、方法、分页、大小和身份变化测试；
- 空列表、限流、账号切换及真实本人测试账号验收。

## 5. 调研来源

- [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI)：同源固定请求、平台适配器组织和知乎接口参考。
- [ReaJason/xhs](https://github.com/ReaJason/xhs)、[jackwener/xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli)、[jzOcb/xhs-note-health-checker](https://github.com/jzOcb/xhs-note-health-checker)：小红书接口与响应形状交叉核对。

这些项目只用于调研。归页不运行其插件、Bridge、守护进程或签名实现。
