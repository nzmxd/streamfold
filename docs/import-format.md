# Social Vault JSON/CSV 导入格式

> 版本：1
> 适用客户端：Social Vault 0.2.0+

通用文件导入插件只读取用户在原生文件选择器中主动选择的 `.json` 或 `.csv` 文件。它没有网络权限，不读取浏览器 Cookie，也不保留原始文件或完整路径。

## 安全限制

- 文件必须为 UTF-8，最大 10 MB，单次最多 5,000 条内容和 5,000 个指标快照。
- 导入前只生成 5 分钟有效、绑定目标账号的一次性预览令牌。
- 用户必须勾选“这是本人账号数据”后才能提交。
- 出现 `cookie`、`token`、`password`、`authorization`、`credential`、`secret`、`session`、`apikey` 等敏感字段时整批拒绝。
- 内容链接必须是无用户名密码的 HTTPS URL；签名、授权码、票据、Key 等疑似凭证参数会拒绝整批导入，未知跟踪参数会在入库前移除，只保留少量公开内容 ID 参数。
- 所有指标必须是非负安全整数；日期必须是有效 ISO 8601 日期。
- 整批内容完成校验后才进入单个 SQLite 事务，任何身份冲突或格式错误都不会部分写入。
- 相同账号和 `remoteId` 的内容会更新，不会重复创建；相同内容和采集时间的快照会跳过。

## JSON

根对象可以包含：

| 字段 | 必填 | 说明 |
|---|---|---|
| `capturedAt` | 否 | 本批默认采集时间；省略时使用导入时间 |
| `account` | 否 | 本人账号身份与账号级指标 |
| `contents` | 是 | 内容数组 |

`account` 支持 `remoteId`、`remoteName`、`followers`、`following`、`contentCount` 和 `viewsTotal`。如果该本地账号已经绑定不同的 `remoteId`，整批导入会停止。

每条内容支持：

| 字段 | 必填 | 说明 |
|---|---|---|
| `remoteId` | 条件必填 | 平台内容 ID；缺失时必须提供 HTTPS `url`，客户端会据此生成稳定 ID |
| `type` | 是 | `article`、`post`、`image`、`video` 或 `answer` |
| `title` | 否 | 标题 |
| `bodyExcerpt` | 否 | 正文摘要，最多 5,000 字符 |
| `url` | 否 | 本人内容的 HTTPS 链接 |
| `publishedAt` | 否 | 发布时间 |
| `snapshots` | 否 | 多个历史指标快照 |
| `views` 等指标 | 否 | 不提供 `snapshots` 时可直接给出单个最新快照 |

快照字段为 `capturedAt`、`views`、`likes`、`comments`、`shares` 和 `favorites`。camelCase 与 snake_case 均可使用。

完整示例见 [social-vault-import.example.json](../examples/social-vault-import.example.json)。

## CSV

CSV 每行表示一条内容。必须包含 `type`，并至少包含 `remote_id` 或 `url`。推荐表头：

```text
remote_id,type,title,body_excerpt,url,published_at,captured_at,views,likes,comments,shares,favorites
```

解析器支持 RFC 4180 风格的引号、逗号、转义双引号和带换行的引用字段。CSV 不承载账号资料，因此只会把内容写入用户在导入向导中选择并确认的本地账号空间。

完整示例见 [social-vault-import.example.csv](../examples/social-vault-import.example.csv)。

## 语义说明

- 文件身份确认只表示用户确认数据归属，不把 Chromium 登录会话标记为有效。
- 导入是本地操作，不受账号“允许未来平台同步”开关影响，也不会请求社媒平台。
- 不同平台对浏览、播放、阅读和互动的定义不同，数据中心只提供趋势观察，不宣称跨平台口径完全等价。
