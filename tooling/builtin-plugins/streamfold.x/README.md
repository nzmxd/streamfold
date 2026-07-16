# Streamfold X adapter

归页内置的 X 平台适配器。它在用户明确授权后，通过受限浏览器会话被动读取 X 已登录网页自身产生的 JSON 响应，用于同步本人公开资料和本人原创或引用帖子。

## 数据范围

- 身份核验始终先读取 `account/settings.json` 的登录 handle，再以 `UserByScreenName` 返回的 `rest_id` 作为稳定账号 ID。
- 支持仅资料、最近 20 条和最近 100 条三种范围。
- 排除回复、纯转帖及其他账号内容；帖子链接统一为 `https://x.com/i/web/status/{id}`。
- 映射浏览、点赞、回复、转帖、书签和引用数；不把账号主动点赞数当作收到的累计点赞。

## 安全边界

插件不使用 X 开发者 API、API Key、Cookie 导入、请求头读取、DOM 解析或自动验证码。登录和登录挑战必须由用户在 X 页面中手动完成。X 内部网页接口变化、限流或挑战可能使同步暂时失败。

Copyright 2026 Streamfold Contributors. Licensed under Apache-2.0.
