# 知乎 Session API 适配器

> 插件 ID：`zhihu-session-api`
> 版本：0.2.0
> 更新日期：2026-07-14

## 1. 目标与范围

适配器复用归页中对应知乎账号的持久 Chromium Session，同步当前登录用户本人的资料、回答、文章和可见指标。本人内容以知乎创作中心“内容管理”使用的 JSON API 为主数据源；这是已登录本人可见的第一方接口，不是网页文本采集。实现也参考 OpenCLI 的 [知乎适配器](https://github.com/jackwener/OpenCLI/tree/main/clis/zhihu) 与 [PR #1986](https://github.com/jackwener/OpenCLI/pull/1986)，但不依赖 OpenCLI 的扩展、Browser Bridge、守护进程或通用命令运行时。

当前不采集粉丝/关注用户明细、收藏夹、草稿和关注流，也不执行发布、删除、点赞、评论、关注或私信操作。完整正文不在核心采集范围；阅读、赞同、评论和收藏仅保存创作中心接口对当前本人账号实际返回的值。

## 2. 接口白名单

所有请求都在 `https://www.zhihu.com` 第一方页面上下文中执行固定 `GET`，仅允许以下路径和查询参数：

| 数据 | 接口 |
|---|---|
| 当前身份 | `/api/v4/me?include=url_token` |
| 本人资料 | `/api/v4/members/{url_token}?include=...` |
| 创作中心本人内容（主数据源） | `/api/v4/creators/creations/v2/all?start=0&end=0&limit=20&offset=...&need_co_creation=1&sort_type=created` |
| 公开回答（遗留解析/参考） | `/api/v4/members/{url_token}/answers?limit=20&offset=...&include=...` |
| 公开文章（遗留解析/参考） | `/api/v4/members/{url_token}/articles?limit=20&offset=...&include=...` |
| 公开想法（遗留解析/参考） | `/api/v4/members/{url_token}/pins?limit=20&offset=...` |

传输层不接受 Renderer 或插件传入任意 URL。创作中心 `paging.next` 必须仍是相同路径和固定参数，并且 `offset` 按页大小递增；响应中的 `paging.totals` / `totals_real` 用于校验是否完整取回当前账号可见作品。公开列表的解析器和严格分页校验仍保留作为研究参考，但当前同步不会在创作中心接口失败时静默降级到公开列表；这避免丢失本人才能看到的指标却被误报为同步成功。

用户不需要预先打开“内容管理”页面。后台 workspace 可在已登录 Session 中直接请求这个固定 JSON API；适配器不查询 DOM、不读取页面可见文本，也不模拟点击“全部”、“文章”或“回答”标签。

## 3. 身份绑定

1. 后台获取该账号的 workspace lease；没有可用页面时打开固定知乎官方页面，但不显示窗口。
2. 请求 `/api/v4/me`，读取稳定 `id/uid`、本次 `url_token` 和昵称。
3. 请求当前 `url_token` 对应的成员资料，并验证稳定 ID、handle 与 `/me` 一致。
4. 首次绑定先返回 5 分钟有效的身份预览，用户确认后再次读取两组数据。
5. 写入稳定 ID 作为 `accounts.remote_id`；`url_token` 只用于本次请求，不作为身份主键。
6. 每次同步前后再次读取 `/me`，发现账号切换时整次同步失败且不提交数据。

创作中心接口本身只能在当前登录账号的会话中返回本人内容，但适配器仍不把“能请求成功”当作身份证明：同步前后的 `/me` 必须都与本地绑定的稳定 ID 一致，列表结果也要通过内容类型、ID 和 URL 映射校验。

401、403、登录重定向或登录 HTML 响应会把同一个账号浏览器窗口显示出来供用户重新登录。429 会停止当前同步并进入受限状态，不循环重试。

## 4. 字段映射

### 4.1 账号资料

| 知乎字段 | 本地字段 |
|---|---|
| `id` / `uid` | `remoteId`，始终按字符串处理 |
| `name` | 平台昵称 |
| `avatar_url` | 经白名单缓存后的头像 |
| `headline` / `description` | 简介 |
| `following_count` | 关注数 |
| `follower_count` | 粉丝数 |
| `answer_count + articles_count + pins_count` | 内容总数；任一分项缺失时为 `null` |
| `voteup_count` | 累计获赞 |
| `favorited_count` | 获收藏 |
| `thanked_count` | 感谢数，仅在同步结果中保留 |

缺失字段保持 `null`，不会补成零。累计获赞和获收藏分别写入账号快照；两者的汇总值仅由实际可用项计算。

### 4.2 本人内容

| 类型 | 本地远端键 | 标题/摘要 | 指标 | 原帖链接 |
|---|---|---|---|---|
| 回答 | `answer:{questionId}:{answerId}` | 问题标题、API 摘要 | 阅读、赞同、评论、收藏 | `https://www.zhihu.com/question/{questionId}/answer/{answerId}` |
| 文章 | `article:{articleId}` | 标题、API 摘要 | 阅读、赞同、评论、收藏 | `https://zhuanlan.zhihu.com/p/{articleId}` |
| 想法（遗留解析） | `pin:{pinId}` | API 摘要，无标题时使用本地占位标题 | 点赞、评论、转发 | `https://www.zhihu.com/pin/{pinId}` |

创作中心 `reaction.read_count`、`vote_up_count`、`comment_count` 和 `collect_count` 分别映射到本地的浏览、点赞/赞同、评论和收藏指标。不同类型或不同时期的响应没有某个字段时，对应本地值保持 `null`，不伪造为零；`like_count` 不与赞同重复相加。

适配器只使用 JSON 中的标题、摘要和结构化指标，不读取页面正文。打开原帖前，主进程会再次校验协议、主机、路径和远端键完全对应，并拒绝查询参数、锚点、显式端口和仿冒域名。

## 5. 分页与同步范围

- `profile_only`：身份、资料与账号指标，不请求内容列表。
- `recent_20`：创作中心统一列表读取第一页，按创作时间保留最近 20 条。
- `recent_100`：创作中心统一列表最多读取 5 页，保留最近 100 条。
- 每页固定 20 条，最多 100 条；`paging.next` 只允许固定参数和递增 offset，`is_end`、`totals`、`totals_real` 必须与实际页数和行数一致。重复下一页、异常 offset、重复内容 ID、未知内容类型、超出响应上限或分页不完整都会终止整次同步。
- 创作中心接口失败或返回未知内容类型时整次同步失败，不会静默改用公开成员列表。未来若引入显式降级模式，必须保留身份校验、分页完整性检查和清晰的指标缺失状态。
- 同账号操作互斥，知乎平台同时只运行一个同步任务。
- 插件同步最小间隔为 300 秒，推荐自动同步间隔仍为 24 小时；当前版本只提供用户主动同步。

## 6. 传输与存储边界

- 页面上下文脚本只执行白名单 `fetch`，使用 `credentials: include`、`redirect: manual` 和 `Accept: application/json`。
- 页面不获得业务 preload、IPC、数据库或文件系统权限。
- 单个列表响应不超过 512 KiB，单列表累计响应不超过 2 MiB，请求超时 12 秒。
- 响应必须来自精确 `www.zhihu.com` URL，并通过 HTTP 状态、JSON Content-Type、字段类型、长度、计数和时间戳校验。
- 头像只接受 `pic.zhimg.com`、`pic1` 至 `pic4`、`pica`、`picb` 和 `picx.zhimg.com`，重定向不得跳到其他平台域名族。
- 账号资料、账号快照、内容、内容快照与成功任务在同一 SQLite 事务中提交。

## 7. 验证状态

已覆盖纯 API 解析、ID 精度保护、缺失字段、创作中心回答/文章与遗留想法映射、安全分页、重复数据、异常响应、登录失效、限流、身份变化、事务提交、头像来源、原帖链接、平台路由、生产构建和 Electron 冒烟测试。已登录真实账号的创作中心响应实测为 32 条内容（26 篇文章、6 条回答），统一列表两页可完整返回，并且包含阅读、赞同、评论和收藏指标。

仍需用补充测试账号确认空列表、原帖打开、401/403/429 和账号切换的实际响应形状。若线上响应与 fixture 不一致，应更新白名单和严格解析器；不能增加页面内容回退。
