# @streamfold/plugin-sdk

归页第三方插件 SDK，提供 v2 TypeScript 合同、Manifest 构建与校验、轻量测试宿主和打包签名 CLI。

## 构建

```powershell
pnpm exec tsc -p packages/plugin-sdk/tsconfig.json
node packages/plugin-sdk/dist/cli.js --help
```

发布为独立 npm 包后，可直接使用 `streamfold-plugin` 命令。

## 开发流程

```powershell
streamfold-plugin init my-plugin --id community.my-plugin --name "我的插件"
streamfold-plugin validate my-plugin
streamfold-plugin pack my-plugin
streamfold-plugin keygen --out-dir .keys --name publisher --key-id community.publisher.main
streamfold-plugin sign my-plugin/dist/community.my-plugin-0.1.0.streamfold-plugin --key .keys/publisher-private.pem
streamfold-plugin verify my-plugin/dist/community.my-plugin-0.1.0.signed.streamfold-plugin --public-key .keys/publisher-public.pem
```

所有写文件命令默认拒绝覆盖已有文件。`keygen` 只在输出目录保存私钥，CLI 不打印私钥内容。

## 包格式

生成文件扩展名为 `.streamfold-plugin`，内部是确定性 ZIP：

- 必须包含 `manifest.json`；
- 每个贡献点入口必须是清单声明的 QuickJS `.js` 文件；
- 可包含 `README*`、`LICENSE*` 与 `icons/` 下的图片；
- 发布包包含 `signature.json`，使用 Ed25519 对 `Streamfold Plugin Package v1` 域分离摘要签名；
- 拒绝路径穿越、符号链接、原生模块、未声明 JavaScript、重复路径以及超过宿主限制的包。

CLI 生成的包会与应用宿主使用相同的内容摘要算法、清单字段和入口白名单。

## 插件入口

入口使用 CommonJS 导出对象，每个可调用方法接收冻结的 `context` 和 JSON 输入：

```js
module.exports = {
  async run(context, input) {
    const accounts = await streamfold.data.read('accounts', { limit: 10 })
    return { ok: true, count: accounts.length }
  }
}
```

QuickJS 环境不提供 `process`、`require`、`Buffer`、`fetch` 或 DOM。网络、平台 Session JSON 和本地数据访问只能通过声明权限后的宿主 API 完成。

## 测试宿主

`createTestHost()` 用于单元测试可信的开发源码，可注入 `hostCall` 模拟平台和数据响应。它复刻公开 API，但不是安全沙箱；安全隔离仍由应用内的 QuickJS + utility process 宿主负责。

完整示例见 `examples/plugins/hello-action`。
