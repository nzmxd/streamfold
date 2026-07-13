# 小红书登录身份核验适配器

## 当前范围

0.3.0 首次开放 `xiaohongshu-managed-browser`，仅实现：

- `probe`：判断当前创作中心页面处于可核验、待登录、安全验证或尚未就绪状态；
- `whoami`：从当前页面可见账号控件中读取并交叉核对远端 ID 与昵称。

它不读取文章、指标、Cookie、Token、LocalStorage 或网络响应，也不执行发布、删除、点赞、评论等写操作。

## 运行步骤

1. 在插件中心主动启用“小红书登录身份核验”。
2. 打开该账号的独立浏览器，通过 `https://creator.xiaohongshu.com/` 官方入口手动登录。
3. 页面加载完成后，在账号详情或浏览器工具栏点击“核验身份”。
4. 首次结果只生成 5 分钟有效的预览；用户核对昵称与远端 ID 并确认本人身份后，插件再次读取当前页面。
5. 两次身份完全一致才写入“插件已核验”；已绑定 ID 与当前可见 ID 不一致时，账号进入 mismatch 并停止同步。

## 脚本安全边界

- 两段脚本均为随应用构建的固定源码、固定版本和固定 SHA-256；源码与哈希不匹配时模块加载失败。
- 通过 Electron isolated world 执行，不向远程页面暴露 preload 或 IPC。isolated world 隔离 JavaScript 上下文，但不是网络或凭证权限沙箱；安全性依赖随应用内建、人工审计并固定哈希的脚本。
- 运行前再次校验账号平台、当前精确 HTTPS hostname、窗口加载状态和脚本哈希。
- 结果只允许固定字段、枚举、证据代码和长度；页面 URL 会排除查询参数与片段。
- 构建期源码检查会拒绝常见网络 API、Cookie/Storage、动态代码执行和 DOM 写操作，作为固定哈希与人工审计之外的纵深保护，而不是通用第三方脚本沙箱。
- 身份核验按账号互斥，普通重试至少间隔 60 秒；检测到验证码或安全验证后进入 30 分钟冷却。

## 停止条件

- 登录页：标记登录失效，不执行 `whoami`。
- 验证码或安全验证：停止并进入 30 分钟冷却。
- 页面结构无法提供一致 ID 与昵称：保持未核验，不猜测身份。
- 未来页面变更导致脚本失效：更新脚本版本与哈希并重新使用专用测试账号验收。

能力设计参考 [OpenCLI Xiaohongshu adapter](https://opencli.info/docs/adapters/browser/xiaohongshu.html) 和 [OpenCLI 源码仓库](https://github.com/jackwener/opencli) 的只读创作者命令范围；Social Vault 未引入其 Browser Bridge、Cookie 提取、写操作或任意第三方插件执行能力。
