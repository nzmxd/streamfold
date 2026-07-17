# 平台适配器

> 适用版本：归页 Streamfold 0.7.7
>
> 本文汇总当前可用平台的接口、字段和停止条件。共同的进程、数据库与安全边界见[运行架构](architecture.md)。

## 1. 共同合同

小红书和知乎是可信内置实现，X 是随应用签名分发的 QuickJS 实现；三者都注册为 Manifest v2 `platform.adapter` 贡献点并使用统一宿主编排。第三方适配器同样在 QuickJS 沙箱运行，其合同、权限和发布流程见[开放插件系统](plugin-system.md)。现有适配器都遵守以下规则：

- 只处理用户在归页中创建、登录并确认归属的本人账号。
- 只使用固定同源 JSON `GET`，或精确匹配的平台 Fetch/XHR JSON 响应。
- 不解析 DOM、HTML 或页面可见文本，不读取 Cookie、请求头、请求正文、密码或验证码。
- 不生成或逆向平台签名，不提供代理轮换、指纹修改和平台写操作。
- 同步前后复验稳定身份；账号切换、分页不完整或结构异常时整次事务不提交。
- 未提供的指标保存为 `null`，不补成零；内容按账号和远端 ID 去重。

同步范围统一为 `profile_only`、`recent_20` 和 `recent_100`。当前由用户主动发起单账号或账号/分组批量同步；平台账号自动同步计划尚未开放。

## 2. 小红书

插件 ID：`xiaohongshu-session-api`，版本 0.4.0，最小同步间隔 60 秒。

### 接口与数据

| 用途 | 固定来源 | 主要数据 |
|---|---|---|
| 当前身份 | `GET creator.xiaohongshu.com/api/galaxy/user/info` | `redId`、昵称、头像、简介 |
| 创作者资料 | `GET creator.xiaohongshu.com/api/galaxy/creator/home/personal_info` | 小红书号、关注、粉丝、累计获赞与收藏、创作等级 |
| 账号指标 | `GET creator.xiaohongshu.com/api/galaxy/creator/data/note_detail_new` | 7/30 日浏览、互动和新增粉丝 |
| 本人作品 | `/api/galaxy/v2/creator/note/user/posted` | ID、标题、时间、类型和基础指标 |
| 作品分析 | `/api/galaxy/creator/datacenter/note/analyze/list` | 曝光、观看、封面点击率、点赞、评论、收藏、涨粉、分享、人均观看时长和弹幕 |
| API 摘要 | `GET edith.xiaohongshu.com/web_api/sns/capa/postgw/note/detail` | 校验 `data.id` 后读取 `data.desc` |

身份、资料和账号指标使用已登录创作中心页面中的固定同源请求。作品列表和详情由平台页面产生请求上下文，`BrowserManager` 通过 Chromium DevTools Protocol 捕获精确主机、路径和 Fetch/XHR 类型的 JSON 响应。作品分析先捕获页面首个 JSON 响应，再在同一官方页面上下文中按固定 `type=0`、`page_num`、`page_size` 发起只读 JSON `GET` 补齐目标页；不会读取页面 DOM、Cookie 或请求头。

作品指标采用动态定义保存：原有观看、点赞、评论、分享和收藏继续保留兼容列，其余指标写入 v12 的 `content_metric_definitions` 与 `content_snapshot_metrics`。封面点击率统一保存为 0 到 1 的比例，人均观看时长以秒保存；平台缺失或仍在统计的值保持 `null`。内容详情会按指标定义展示全部可用指标，并可切换任意指标查看本地快照历史。

摘要只取 JSON `data.desc`，清除控制字符、合并空白并截断到 500 个 Unicode 字符。已保存的非空摘要不重复请求；每次同步最多补取 10 条，相邻详情请求至少间隔 2 秒。公开原帖的签名参数不参与摘要请求。

### 身份与完整性

1. 首次核验同时读取 `user/info` 与 `personal_info`，两个稳定账号 ID 必须一致。
2. 用户在 5 分钟有效期内确认绑定后，适配器再次读取并交叉校验身份。
3. 每次同步前后都复验远端 ID；任一次与本地绑定不一致即回滚。
4. 作品管理列表是内容基线，分析结果只按同一作品 ID 合并。
5. `total`、`has_more`、页码或 `tags[].notes_count` 显示仍有未捕获内容时，适配器继续进行有上限的分页；作品分析按 `data.total` 补齐目标范围。任一列表无法完成目标范围时返回 `INCOMPLETE_CAPTURE`，不会提交部分指标。

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

插件 ID：`zhihu-session-api`，版本 0.5.0，最小同步间隔 300 秒。

### 接口与数据

所有请求均在 `https://www.zhihu.com` 第一方页面上下文中执行固定 `GET`：

| 用途 | 固定接口 | 主要数据 |
|---|---|---|
| 当前身份 | `/api/v4/me?include=url_token` | 稳定账号 ID、当前 `url_token` 和昵称 |
| 本人资料 | `/api/v4/members/{url_token}?include=...` | 头像、简介、关注、粉丝、内容数、累计获赞和获收藏 |
| 创作中心本人内容 | `/api/v4/creators/creations/v2/all?start=0&end=0&limit=20&offset=...&need_co_creation=1&sort_type=created` | 回答、文章、想法、视频的 ID、标题、API 摘要、发布时间和当前指标 |
| 账号周期汇总 | `/api/v4/creators/analysis/realtime/member/aggr?tab=all[&start=YYYY-MM-DD&end=YYYY-MM-DD]` | 指定周期或累计的流量、互动和高级指标 |
| 账号每日趋势 | `/api/v4/creators/analysis/realtime/member/daily?tab=all&start=YYYY-MM-DD&end=YYYY-MM-DD` | 每日指标、发布数、点击率和完成率 |
| 内容分析列表 | `/api/v4/creators/analysis/realtime/content/list?type=...&limit=20&offset=...` | 按回答、文章、想法和视频读取本人内容的完整指标 |
| 单内容汇总 | `/api/v4/creators/analysis/realtime/content/aggr?type=...&token=...` | 单篇内容当前聚合指标 |
| 单内容每日趋势 | `/api/v4/creators/analysis/realtime/content/daily?type=...&token=...&start=YYYY-MM-DD&end=YYYY-MM-DD` | 单篇内容最多 90 天的官方日趋势 |
| 遗留解析参考 | `/api/v4/members/{url_token}/answers`、`articles`、`pins` | 兼容解析与测试，不作为创作中心失败时的降级数据源 |

当前同步以创作中心统一列表为主数据源，不会在该接口失败时静默降级到公开成员列表。用户不需要预先打开“内容管理”页面，后台 workspace 会直接发起固定请求。

账号资料映射包括稳定 ID、昵称、头像、简介、关注、粉丝、内容总数、累计获赞与获收藏。账号动态指标保存最近 7 天、14 天、30 天、累计和最近 30 天的每日记录：

- 流量：阅读 `pv`、展现 `show`、播放 `play`；
- 互动：赞同 `upvote`、喜欢 `like`、评论 `comment`、收藏 `collect`、分享 `share`、互动 `reaction`、转发 `re_pin`；
- 变化：新增赞同/喜欢，以及赞同和喜欢的增加、减少；
- 效率：发布数 `publish_cnt`、点击率 `click_rate`、阅读完成率 `read_finished_rate`、播放完成率 `play_finished_rate`；
- 高级：正向互动率 `advanced.positive_interact_percent`、关注者转化 `advanced.follower_translate`。

比例统一保存为 0 到 1。正向互动率的原始值按百分数处理，例如平台返回 `0.2` 表示 `0.2%`，落库为 `0.002`。关注者转化是允许为负数的数量。`advanced.status` 为 `unnormal_by_level`、`unnormal_by_pv` 或 `updating` 时，高级指标保存为 `null` 并保留状态，不显示为零。

内容指标严格区分“赞同”和“喜欢”。兼容快照的 `likes` 列继续表示知乎赞同，动态指标 `content_likes` 表示官方喜欢；同时保存展现、阅读、播放、评论、收藏、分享、互动、转发及其他可用变化指标。回答使用 `answer:{questionId}:{answerId}`，文章使用 `article:{articleId}`，想法使用 `pin:{pinId}`，视频使用 `zvideo:{videoId}`，并保存经过验证的官方原帖 URL。想法摘要只读取 API JSON 的 `excerpt`、`excerpt_title` 或 `content[]` 文本块，不读取页面 DOM。

### 身份与分页

1. `/api/v4/me` 返回稳定 ID、当前 `url_token` 和昵称。
2. 成员资料中的稳定 ID 与 handle 必须和 `/me` 一致。
3. 首次绑定需要 5 分钟有效的预览确认，确认时再次读取两组数据。
4. `url_token` 只用于当次请求，稳定 ID 才写入 `accounts.remote_id`。
5. 同步前后 `/me` 都必须与本地绑定一致。

`recent_20` 读取一页，`recent_100` 最多读取五页；创作内容和内容分析列表均固定每页 20 条，允许的 `offset` 为 0、20、40、60、80。创作内容的 `paging.next` 必须保持固定路径和查询参数；内容分析列表允许平台省略 `paging.next`，此时宿主只按当前固定端点生成下一页。若平台返回 `next`，仍必须通过相同的主机、路径、类型、页大小和递增 offset 校验。

两组列表都校验 `is_end`、`totals`、`totals_real`、重复内容 ID/token 和采集期间总数变化。异常 offset、跨类型下一页、未知内容类型或分页不完整都会使整次同步失败，不提交部分指标。回答、文章、想法和视频的分析列表分别分页，再按平台内容 ID 或 token 与创作内容合并。

指标日期只接受有效的 `YYYY-MM-DD`，单次日趋势范围为 1 到 90 天；内容 token 只接受受限字符并由 `URLSearchParams` 编码。单个列表响应最多 512 KiB，累计最多 2 MiB，请求超时 12 秒。头像仅接受已列入白名单的 `zhimg.com` 图片主机。

401/403、登录重定向，以及 HTTP 200 中的 `{code: 401|403, msg: "no auth"}` 都按登录失效处理；429 会停止同步，不循环重试。知乎未登录时，账号汇总可能返回全 `null`、每日接口可能返回全零，因此任何指标都只能位于同步前后两次 `/api/v4/me` 身份复验之间。身份变化、登录失效或风控响应会使整个同步事务回滚。

0.6.2 的自动化测试覆盖固定端点白名单、日期和 token 校验、五页分页、缺失 `next`、重复内容、赞同/喜欢分离、想法和视频、负数关注者转化、高级指标不可用状态、登录失效 JSON、响应大小与同步前后身份复验。0.6.3 进一步兼容内容分析列表的顶层 `content_token`、非负安全整数 token/ID 和平铺数值 `reaction` 指标，同时继续拒绝不安全整数与非法结构。此前本人测试账号已完成创作中心两页 32 条内容在线验收；周期和高级指标仍应使用本人账号完成脱敏响应验收。

## 4. X

插件 ID：`streamfold.x`，版本 1.1.2；随应用签名分发，在 QuickJS Utility Process 中运行。首次安装或从旧版未授权状态升级时默认启用并建立受托授权，用户之后仍可关闭包、贡献点或收窄授权。手动同步间隔默认且最少为 5 分钟，可配置到 24 小时；自动计划最短 1 小时，建议周期 24 小时。

X 适配器不接入开发者平台或付费 API，也不配置 Bearer Token。它只在账号自己的隔离 Chromium Session 中打开 X 官方页面，并被动捕获网页已经发出的只读 JSON 响应：

账号浏览器会移除 Electron 与应用自身的 User-Agent 包装产品标识，同时保留真实操作系统和应用内置 Chromium 版本，使 X 与知乎使用一致的标准 Chromium 登录身份。这不是指纹伪装；X 返回临时登录限制、验证或风控时，归页不会自动重试或绕过，必须等待平台解除后由用户继续官方登录流程。

| 用途 | 页面响应 | 主要数据 |
|---|---|---|
| 当前登录态 | `GET api.x.com/1.1/account/settings.json` | 当前已登录账号的 `screen_name`；只作为会话与账号切换证明 |
| 本人资料（初次绑定） | `GET x.com/i/api/graphql/{queryId}/UserByScreenName` | 稳定 `rest_id`、handle、昵称、头像、简介、关注、粉丝和帖子数 |
| 本人资料（确认与复核） | `GET x.com/i/api/graphql/{queryId}/UserByRestId` | 使用已绑定的稳定 `rest_id` 重新核验本人资料 |
| 本人帖子 | `GET x.com/i/api/graphql/{queryId}/UserTweets` | 原创帖、引用帖、媒体类型、发布时间和可见互动指标 |

`queryId` 会随 X Web 发布变化，因此 Manifest 声明固定 GraphQL 操作名，宿主只允许一个受限 query ID 路径段并精确匹配 `UserByScreenName`、`UserByRestId` 或 `UserTweets`。适配器看不到 query ID、查询变量、请求头、Cookie 或请求正文，也不会读取页面 DOM。

### 身份与资料

1. 每次身份读取先捕获 `account/settings`；宿主在首个匹配响应到达前不会因短暂网络静默提前结束，收到响应后再按静默窗口收敛，并严格遵守数量、正文和总时长上限。
2. 每次都按当前 handle 打开资料页并返回实际登录身份；初次绑定使用其 `rest_id` 作为不可变远端账号 ID。
3. 确认和同步复验再打开 `/i/user/{rest_id}`，以 `UserByRestId` 交叉验证已绑定的稳定 ID；若实际登录账号已切换，宿主会把账号标记为身份不一致。
4. 同步前后都重复上述验证；退出登录、切换账号或 handle/ID 不一致时整次事务不提交。

昵称优先读取资料 `core.name`，handle 读取 `core.screen_name`，头像读取 `avatar.image_url`，简介读取 `profile_bio.description`；同时兼容旧版 `legacy` 字段。关注和粉丝映射为通用资料指标，`statuses_count` 保存为平台帖子总数。X 的 `favourites_count` 表示账号主动点赞数，不等于本人内容收到的赞，因此不会误映射为累计获赞。

### 内容与指标

只保存作者稳定 ID 等于绑定账号的原创帖和引用帖；回复、纯转帖、推广注入、墓碑内容及其他账号帖子均不保存。长帖优先读取 `note_tweet.note_tweet_results.result.text`，普通帖读取 `legacy.full_text`。包含视频或 GIF 时保存为 `video`，否则包含图片时为 `image`，其余为 `post`。

帖子远端 ID 始终保留为十进制字符串，原帖统一使用可重定向且不依赖 handle 的 `https://x.com/i/web/status/{tweetId}`。通用快照字段映射如下：

- `views.count` → 浏览；
- `favorite_count` → 点赞；
- `reply_count` → 回复；
- `retweet_count` → 转帖；
- `bookmark_count` → 书签；
- `quote_count` → 动态指标“引用”。

缺失浏览或互动值保存为 `null`。所有计数必须是非负安全整数，账号和帖子 ID 从不转换为 JavaScript Number。

### 分页与停止条件

`recent_20` 最多捕获 3 个时间线响应，`recent_100` 最多捕获 8 个；每个响应当前包含约 20 个时间线条目。适配器按 Bottom cursor 检查推进、去重并过滤不属于本人作品的条目，达到授权目标数后截断。账号本身内容少且时间线明确终止时允许返回较少结果；仍有 Bottom cursor 但响应数、20 秒捕获时间或 2 MiB 总量达到上限时返回不完整采集错误，不提交部分数据。

HTTP 401/403 按登录失效处理，429 按平台限流处理；身份捕获缺失、资料捕获缺失、响应结构变化和稳定 ID 复核失败使用独立的固定诊断码。GraphQL errors、重复游标、冲突内容、非法日期/计数或响应超限都会终止本次任务。验证码和登录挑战只由用户在账号浏览器中手动完成。

自动化夹具覆盖当前 `core`/`avatar`/`profile_bio` 资料结构、旧版 legacy 回退、长帖、图片/视频、引用、回复与纯转帖过滤、64 位以上字符串 ID、分页终止和不完整回滚。发布前仍需使用本人测试账号在应用隔离 Session 中完成 20/100 条在线验收，且不得保存真实 Cookie、请求头或完整响应。

## 5. 计划中平台

微博与抖音目前只有官方入口、隔离 Session 和账号浏览器，没有开放数据同步。将插件从 `planned` 改为 `available` 前，必须完成：

- 本人稳定身份接口与登录失效识别；
- 资料、内容、指标的固定 JSON 来源和字段映射；
- 主机、路径、方法、分页、大小和身份变化测试；
- 空列表、限流、账号切换及真实本人测试账号验收。

## 6. 调研来源

- [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI)：同源固定请求、平台适配器组织和知乎接口参考。
- [chouheiwa/zhixi](https://github.com/chouheiwa/zhixi)：知乎创作中心账号汇总、内容日趋势和指标字段交叉核对。
- [ReaJason/xhs](https://github.com/ReaJason/xhs)、[jackwener/xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli)、[jzOcb/xhs-note-health-checker](https://github.com/jzOcb/xhs-note-health-checker)：小红书接口与响应形状交叉核对。
- [d60/twikit](https://github.com/d60/twikit)：X Web GraphQL 操作、游标和字段形状交叉核对；归页未采用其 Cookie、请求头构造、登录或写操作实现。

这些项目只用于调研。归页不运行其插件、Bridge、守护进程或签名实现。
