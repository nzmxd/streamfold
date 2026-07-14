# 账号问候示例

这是一个最小第三方动作插件，只演示两件事：

1. 通过 `accounts.read` 权限读取用户明确授权的账号摘要；
2. 返回可 JSON 序列化的运行结果。

插件入口不访问 DOM，不直接读取 Cookie，也不使用 Node.js API。它只调用宿主提供的 `streamfold.data.read`。

```powershell
pnpm exec tsc -p packages/plugin-sdk/tsconfig.json
node packages/plugin-sdk/dist/cli.js validate examples/plugins/hello-action
node packages/plugin-sdk/dist/cli.js pack examples/plugins/hello-action
```

发布前先通过 `keygen` 生成 Ed25519 密钥，再用 `sign` 创建签名包。私钥不应提交到 Git。
