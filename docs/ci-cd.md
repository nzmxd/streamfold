# GitHub CI/CD

项目在 `.github/workflows` 中提供两条 GitHub Actions 流程。

## 持续集成

`ci.yml` 在 `master`、`main` 的推送与 Pull Request 上运行，也支持手动触发。流程使用 Node.js 22.13.0、pnpm 10.24.0 和锁文件安装依赖，依次执行：

```powershell
pnpm test
pnpm typecheck
pnpm build
```

CI 使用 `windows-latest`，与当前主要桌面验收环境保持一致。并发组会取消同一分支上已经过时的运行。

## 打包与发布

`release.yml` 在推送形如 `v0.4.0` 的版本标签时运行，也可以手动触发。手动触发只生成可下载的工作流构件；版本标签触发还会创建或更新 GitHub Release。

流程先运行测试和类型检查，再分别在对应原生 runner 上生成：

- Windows：NSIS 安装包与 ZIP。
- macOS：DMG 与 ZIP。
- Linux：AppImage 与 `tar.gz`。

发布任务会合并三组构件，生成 `SHA256SUMS.txt`，然后使用 GitHub 自动提供的 `GITHUB_TOKEN` 发布，不需要额外的发布令牌。

## 本地打包命令

```powershell
pnpm dist:dir
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

跨平台安装包应在对应操作系统上生成。输出目录为 `release/`。

## 签名说明

当前工作流默认生成未签名构件，避免在仓库中保存证书或密钥。正式对外分发前，应在 GitHub Environments 或 Actions Secrets 中配置 Windows 代码签名与 Apple Developer/公证凭据，并将发布 job 绑定到受保护环境。不要把证书、密码或 Apple API 私钥提交到仓库。
