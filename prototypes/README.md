# 界面原型

## 文件

- [social-account-manager.html](social-account-manager.html)：可以直接离线打开的完整单文件原型，已包含主题、组件样式和图标。
- [social-account-manager.fragment.html](social-account-manager.fragment.html)：用于继续编辑界面结构和交互的源片段。

## 查看方式

直接使用 Chrome、Edge、Firefox 或 Safari 打开 `social-account-manager.html`。原型不依赖 Node.js、构建工具、Codex 宿主样式或网络服务。

如果浏览器限制本地脚本，也可以在项目根目录启动任意静态文件服务器，再访问对应文件。例如：

```powershell
python -m http.server 8765
```

然后访问 `http://127.0.0.1:8765/prototypes/social-account-manager.html`。

## 已覆盖交互

- 按全部、未分组、登录异常和自定义分组筛选账号。
- 搜索账号并切换当前账号。
- 查看总览、内置浏览器、内容数据和设置与备注页签。
- 编辑本地别名、备注及账号所属分组。
- 展示账号状态、同步时间、指标卡片、趋势和最近内容。

## 原型边界

- 所有账号与统计数字均为演示数据。
- 内置浏览器区域仅表达最终产品布局，当前不会打开真实平台页面。
- 保存设置只修改当前页面内存，刷新页面后恢复初始数据。
- 原型不读取或保存 Cookie、密码等登录凭证。
