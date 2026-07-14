# streamfold-plugins 静态目录模板

此目录可复制为独立的 `streamfold-plugins` 仓库。它只发布静态文件，不包含市场后台，也不保存目录根私钥。

## 文件约定

| 路径 | 用途 |
|---|---|
| `catalog.source.json` | 维护者审核的目录条目；不含时间和根签名 |
| `schema/catalog-v1.schema.json` | 应用实际读取的签名目录 JSON Schema |
| `public/catalog.json` | CI 生成的签名目录；不提交 Git |
| `public/packages/` | 可选的插件包静态托管目录 |
| `scripts/catalog.mjs` | 与应用相同域分离、UTF-8 键排序和 Ed25519 签名规则 |
| `.github/workflows/` | PR 校验及受保护环境中的手动签名、GitHub Pages 发布 |

最终 `catalog.json` 的有效期默认 7 天，应用拒绝过期或超过 31 天有效期的目录。每个 `(pluginId, version)` 只能出现一次。

## 初始化独立仓库

1. 将本模板内容复制到一个空仓库，保留隐藏的 `.github` 和 `.gitignore`。
2. 在 GitHub Pages 中选择 **GitHub Actions** 作为发布源。
3. 创建受保护环境 `plugin-catalog-release`，要求维护者审批。
4. 在该环境保存 Secret `CATALOG_ROOT_PRIVATE_KEY_BASE64`：内容为 Ed25519 PKCS#8 私钥 PEM 文件的 Base64。
5. 添加 Repository Variable `CATALOG_ROOT_PUBLIC_KEY`：内容为对应 Ed25519 SPKI 公钥 DER 的 Base64，或完整 PEM。
6. 保护默认分支，并要求 `Validate plugin catalog` 通过。
7. 合并审核过的条目后，手动运行 `Sign and publish plugin catalog`。

不要把真实 owner、仓库 URL 或根公钥写进模板。创建实际目录仓库后再填写条目的 HTTPS 下载地址，并把同一个根公钥配置给归页发布构建。

## 发布者接入

发布者应先使用 `@streamfold/plugin-sdk`：

```text
streamfold-plugin validate <plugin-directory>
streamfold-plugin pack <plugin-directory>
streamfold-plugin sign <package.streamfold-plugin> --key <publisher-private.pem>
streamfold-plugin verify <package.signed.streamfold-plugin> --public-key <publisher-public.pem>
```

目录 PR 应同时提供：

- 签名后的 `.streamfold-plugin`；
- 原始 ZIP 文件的 `sha256:<64 个小写十六进制字符>`，不是 `signature.json` 的内容摘要；
- Manifest 中相同的插件 ID、版本和 `publisher.keyId`；
- 发布者 Ed25519 SPKI 公钥及其轮换说明；
- 应用兼容范围、权限差异和审核说明。

维护者应在受信任环境重新运行 SDK 的 `verify`，核对归档 SHA-256，并确认下载 URL **直接返回 HTTP 200**。应用目录下载器不跟随重定向；建议把包放在 `public/packages/` 或其他可直接响应的 HTTPS 静态源。

撤销版本时保留原条目和包摘要，把 `revoked` 改为 `true` 并填写 `revokedReason`。不要删除被撤销版本，因为客户端需要用签名目录识别已安装版本。

## 本地验证

要求 Node.js 22.13 或更高版本，不需要安装依赖：

```text
npm run validate

# 签名，仅在隔离的发布环境执行
CATALOG_ROOT_PRIVATE_KEY_BASE64=... npm run sign

# 公钥可以是 PEM 或 SPKI DER Base64
CATALOG_ROOT_PUBLIC_KEY=... npm run verify
```

根私钥应离线生成并至少保留一个离线恢复副本。若选择 CI 托管私钥，应使用受保护 Environment、最小化管理员和 Actions 权限，并在每次签名前人工审核默认分支的工作流与签名脚本变更。
