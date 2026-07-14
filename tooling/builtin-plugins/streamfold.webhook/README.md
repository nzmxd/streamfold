# Streamfold Webhook

归页官方 Webhook 插件。它通过归页的受限数据和公网 HTTPS 代理发送经过用户授权的数据。

此目录是官方插件包的源码。发布资源由仓库根目录的构建脚本生成，并使用仓库外保存的 Ed25519 私钥签名。

## 发布资源

校验仓库中已固定的签名包：

```text
pnpm plugin:official-webhook:verify
```

重新生成发布资源时，通过 `STREAMFOLD_OFFICIAL_PLUGIN_PRIVATE_KEY_FILE` 指向安全保存的 Ed25519 PKCS#8 私钥，再运行：

```text
pnpm plugin:official-webhook:build
```

`--generate-local-key` 只用于首次本地开发。它把私钥写入 Git 已忽略的 `.local-plugin-signing` 目录；正式发布前应将私钥迁移到受控的发布 Secret，且不得提交、打印或打入安装包。

构建会同时更新以下可提交文件：

- `resources/plugins/streamfold.webhook-<version>.streamfold-plugin`
- `trust.json`
- `src/main/plugins/official-webhook-trust.generated.ts`

信任模块中的发布者公钥与包摘要会进入主进程 ASAR；安装包只额外携带签名后的插件包，不携带本目录源码或私钥。
