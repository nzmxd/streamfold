# 小红书 Session API 适配器

> 适用版本：归页 Streamfold 0.4.0
>
> 插件 ID：`xiaohongshu-session-api`

## 1. 当前能力

适配器使用账号自己的内置 Chromium Session，同步小红书创作中心的本人数据。

| 能力 | 接口 | 数据 |
|---|---|---|
| 登录用户资料 | `GET /api/galaxy/user/info` | `redId`、`userName`、`userAvatar`、`userDesc` |
| 创作中心资料 | `GET /api/galaxy/creator/home/personal_info` | 小红书号、昵称、简介、关注、粉丝、累计获赞与收藏、创作等级 |
| 账号指标 | `GET /api/galaxy/creator/data/note_detail_new` | 7 日与 30 日浏览、平均观看、主页浏览、互动和新增粉丝 |
| 本人作品列表 | `/api/galaxy/v2/creator/note/user/posted` | 作品 ID、标题、发布时间、类型及接口提供的基础指标 |
| 旧作品列表兼容 | `/api/galaxy/creator/note/user/posted` | 与 v2 路径相同用途，仅在页面实际请求该路径时接受 |
| 作品分析 | `/api/galaxy/creator/datacenter/note/analyze/list` | 浏览、点赞、收藏、评论和分享 |
| 作品正文摘要 | `GET https://edith.xiaohongshu.com/web_api/sns/capa/postgw/note/detail` | 校验 `data.id` 后读取 `data.desc`，标准化后最多保存 500 个 Unicode 字符 |

作品管理结果是内容列表基线；作品分析结果按作品 ID 合并并覆盖对应指标。数据分析页没有返回的作品仍保留在内容列表中，其缺失指标保存为 `null`。若作品管理或分析 JSON 已包含 `desc`，直接使用该字段；否则只使用作品 ID 与类型构造创作中心编辑路由补取详情，不依赖公开原帖的 `xsec_token`。

## 2. 传输方式

### 2.1 同源固定 JSON 请求

身份、资料与账号指标接口不需要单独构造签名。用户发起核验或同步时，主进程会为该账号取得后台 workspace lease，必要时在隐藏的 `https://creator.xiaohongshu.com` 页面准备同源环境，再执行固定 `GET` 请求。用户不需要预先打开浏览器窗口。

- 只接受预置的 `user/info`、`personal_info` 和 `note_detail_new` 三个接口路径。
- 使用当前账号 Session 的登录语义和 `credentials: include`。
- 禁止重定向，`Accept` 固定为 JSON。
- 以流方式读取正文，超过 256 KiB 立即中止。
- 返回后再次校验精确 origin、路径、状态码和 JSON Content-Type。

使用页面同源请求是为了保持创作中心实际的浏览器请求语义，而不是读取页面内容。

后台创建的 workspace 在最后一个 lease 释放后自动销毁；若接口表明登录失效，则该 workspace 会提升为同一个可见的官方浏览器窗口，让用户完成登录后继续使用原 Session。已有可见窗口会直接复用，不会为一次同步再创建第二份会话。

### 2.2 页面自身 JSON 响应捕获

作品管理、作品分析和作品详情接口由平台页面生成请求参数。适配器的处理步骤是：

1. 连接该账号页面的 Chromium DevTools Protocol `Network` 域。
2. 列表与指标打开固定作品管理页或数据分析页；摘要补全只根据已经校验的本人作品 ID 和类型打开 `https://creator.xiaohongshu.com/publish/update?id=<作品ID>&noteType=normal|video`。
3. 只接受 Fetch/XHR 类型且 URL 命中精确接口白名单的响应。作品详情必须是页面自身发出的 `GET https://edith.xiaohongshu.com/web_api/sns/capa/postgw/note/detail`，并且查询参数只能各有一个 `edit_mode`、`note_id` 和 `source`；适配器不读取这些参数值、请求头或请求正文。
4. 在 `Network.loadingFinished` 后通过 `Network.getResponseBody` 读取 JSON 正文。
5. 作品管理响应通过 `page` 游标与 `tags[].notes_count` 判断目标范围是否完整；显示仍有下一页时，发送有上限的 `PageDown` 输入触发继续加载，并捕获新的白名单 JSON 响应，此过程不查询页面元素。
6. 详情响应中的作品 ID 必须与当前请求作品一致；同一页面产生的其他详情响应不会进入该作品摘要。
7. 没有待完成响应且达到短暂静默窗口后结束捕获并解析结果。
8. 无论成功或失败都关闭 `Network` 域并分离调试通道。

适配器不生成或破解接口签名，也不读取完整 Cookie 列表。平台页面 DOM、HTML 和可见文本不参与采集。

## 3. 使用流程

1. 在插件中心启用“小红书数据同步”。
2. 创建小红书账号空间；本地备注名可以留空。
3. 在账号详情点击“核验当前账号”。如果当前 Session 尚未登录，应用会显示该账号的官方浏览器窗口。
4. 在小红书创作中心完成登录，回到账号详情再次核验。
5. 首次绑定时核对 API 返回的昵称和小红书号，并在 5 分钟内确认；备注名留空时自动采用平台昵称。
6. 在设置与备注中选择 `profile_only`、`recent_20` 或 `recent_100`，开启同步。
7. 点击“立即同步”；应用在后台复用该账号会话，完成后在账号、内容和数据页面查看结果。

登录失效时，下次核验或同步会自动显示同一个账号浏览器窗口；切换了小红书账号后需要重新核验。当前没有后台定时同步，所有平台访问由用户主动触发。

## 4. 身份核验

### 首次绑定

1. 调用 `personal_info` 与 `user/info`；`red_num`/远端 ID 必须与 `redId` 一致，资料才可用于预览。
2. 生成 5 分钟有效的身份确认令牌。
3. 用户确认后再次调用并交叉校验两个资料接口。
4. 两次远端 ID 和昵称一致才写入账号绑定。

### 已绑定账号

- 当前远端 ID 必须与本地 `remote_id` 一致。
- 完整同步在采集前后各读取一次资料接口。
- 远端 ID 或昵称在同步期间变化时，整次任务不写入资料、内容或快照。
- 登录失效设置连接状态为 `login_required/expired`；身份不一致设置为 mismatch 并停止同步。

### 头像与资料缓存

- `userAvatar` 只接受 `https:`，主机必须属于 `xiaohongshu.com` 或 `xhscdn.com` 及其子域，且不能包含凭据、非默认端口或片段。
- 主进程下载时不携带账号凭据或 Referrer；每次重定向都重新校验来源，最多接受 3 次重定向。
- 仅接受 JPEG、PNG、WebP、GIF 和 AVIF，校验响应 MIME、文件头、Content-Length、实际正文长度和 512 KiB 上限。
- 文件按 SHA-256 内容哈希写入账号专属本地缓存，SQLite 只保存缓存键与 MIME 元数据。
- 账号模型向界面提供 `app://shell/media/avatars/...` 同源地址；路由再次校验账号 ID、缓存键、文件类型、文件头、哈希与大小，Renderer 不直接连接头像 CDN。

## 5. 作品合并与完整性

同步作品时依次读取作品管理和作品分析响应，再按需补齐摘要：

```text
作品管理列表 ──┐
               ├─ 按作品 ID 合并 ─→ 标准化内容与指标快照
作品分析列表 ──┘
                         │
                         └─ 摘要为空 ─→ 打开创作中心编辑路由并串行捕获详情 JSON
```

- 作品管理接口接受 `data.notes` 与 `data.data.notes`，并兼容已确认的 `note_list`、`items` 或 `list` 包装字段。
- 远端 ID 兼容 `note_id`、`noteId`、`id`、`item_id` 和 `display_id` 等已确认字段。
- 标题、发布时间和类型只从 JSON 字段读取。
- 摘要只取 JSON 的 `desc`；清除控制字符、合并多余空白，并按 Unicode 字符截断到 500 字。
- 详情 JSON 的 `data.id` 必须与当前作品 ID 完全一致；公开原帖链接及其签名参数不参与摘要请求。
- 已保存的非空摘要不重复请求详情；单次同步最多补取 10 条，相邻详情请求至少间隔 2 秒，剩余项目由后续同步继续。
- 分析接口指标优先用于同 ID 作品；没有分析记录的作品保留基础信息和可用指标。
- 返回的 `total`、`has_more`、`page` 或 `tags[].notes_count` 表示仍有未捕获内容且未达到请求范围时，拒绝返回不完整列表。
- 单次最多标准化 100 条作品；内容 ID 非法、分析页重复 ID 或超过上限时失败。

## 6. 数据校验与限制

| 项目 | 限制 |
|---|---|
| JSON API 主机 | 仅 `creator.xiaohongshu.com` 与 `edith.xiaohongshu.com` 的对应固定用途；`www.xiaohongshu.com` 仅用于保存并打开官方原帖链接 |
| 头像来源 | 仅小红书 HTTPS 域名与 CDN，最多 512 KiB |
| 固定接口正文 | 每个最多 256 KiB |
| 捕获接口正文 | 每个最多 512 KiB |
| 捕获总量 | 最多 2 MiB |
| 作品数量 | 最多 100 条 |
| 详情补全 | 每次最多 10 条，严格串行，相邻请求至少 2 秒 |
| 身份确认令牌 | 5 分钟 |
| 身份核验最小间隔 | 60 秒 |
| 同步最小间隔 | 60 秒 |
| 并发 | 同账号互斥，同平台单同步 |

所有响应在进入数据库前校验：

- 精确协议、主机、路径、无意外用户名/密码/端口。
- HTTP 状态与 JSON Content-Type。
- 平台 envelope 的成功状态和 `data` 字段。
- ID 格式、字符串长度、非负整数、时间戳和内容类型。
- 捕获页完整性、重复 ID 和累计响应大小。

## 7. 错误与停止条件

| 情况 | 行为 |
|---|---|
| 401/403 或平台返回登录错误 | 标记需要登录，并将当前后台 workspace 提升为同一个可见账号浏览器窗口 |
| 406 或接口要求未支持的签名 | 终止当前操作 |
| 429/461/471、验证或风控响应 | 立即停止后续详情请求，任务失败并将账号置于冷却状态 |
| 可选详情捕获超时或结构暂时变化 | 保留既有摘要，资料、列表和指标仍可提交；任务结果记录后续补齐提示 |
| 非 JSON、超限或字段结构变化 | 拒绝响应，不写入部分数据 |
| 作品列表不完整 | 返回 `INCOMPLETE_CAPTURE`，不提交本次作品数据 |
| 身份不匹配 | 返回 `IDENTITY_MISMATCH`，整次同步回滚 |

接口不可用时不会改用平台页面 DOM，也没有手动文件导入兜底。

## 8. 数据提交

通过校验的数据映射到统一账号、内容和快照模型：

- 平台账号 ID、昵称、简介、创作等级、头像缓存元数据、30 日账号指标、内容、内容指标和成功任务在一个 SQLite 事务中提交。
- 关注、粉丝及累计获赞与收藏写入 `account_snapshots`，保留时间变化；账号资料直接展示最新绑定值。
- 7 日指标保留在适配器响应模型中；当前账号汇总快照使用 30 日指标。
- 内容以 `(account_id, remote_id)` 去重。
- 作品摘要写入 `contents.body_excerpt`，既有非空摘要在下次同步前合并回结果；详情补全失败不会用空字符串覆盖它。
- 指标值允许为 `null`，表示平台接口没有提供，不能用零替代。
- 同时间相同快照保持幂等，失败任务保留错误码和错误信息；成功任务同时保存摘要补齐 warning。

2026-07-14 使用已登录本人测试账号完成在线验收：8 条作品全部同步，其中 6 条详情 JSON 返回并落库非空 `data.desc`；另 2 条官方详情的 `data.desc` 本身为空，界面会明确标记为平台未提供摘要，不会生成或猜测正文。

## 9. 参考来源

- [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI)：创作者接口、页面同源请求和网络响应采集方式参考。
- [ReaJason/xhs](https://github.com/ReaJason/xhs)：作品管理与公开 `/feed` 方案的调研参考；公开详情方案不在归页运行时使用。
- [jackwener/xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli)：公开作品详情方案的调研参考；其 POST 载荷和签名逻辑不在归页运行时使用。
- [jzOcb/xhs-note-health-checker](https://github.com/jzOcb/xhs-note-health-checker)：v2 作品列表响应形状交叉验证。

归页当前清单固定参考标识为 `opencli-b0f84c99-creator-detail`。这些项目仅作为调研与接口行为参考；运行时使用归页自己的白名单传输、解析、身份核验和数据库事务实现。
