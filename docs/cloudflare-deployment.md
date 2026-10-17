# Cloudflare 部署

## 首次部署

需要 Node.js 22.12+、Cloudflare 账号，以及 Workers、D1、R2。

1. 安装依赖并登录：

   ```bash
   npm ci
   npx wrangler login
   ```

2. 创建数据库、私有文件桶，复制配置：

   ```bash
   npx wrangler d1 create xvi-note
   npx wrangler r2 bucket create xvi-note-files
   cp wrangler.selfhost.example.jsonc wrangler.selfhost.jsonc
   ```

   名称已占用时另取名称。已有实例配置时不要覆盖。

3. 填写 `wrangler.selfhost.jsonc` 的 `env.production`：

   | 配置 | 内容 |
   | --- | --- |
   | `account_id` | 账号 ID，运行 `npx wrangler whoami` 查看 |
   | `name` | Worker 名称 |
   | `d1_databases[0].database_name` | D1 名称 |
   | `d1_databases[0].database_id` | 创建 D1 时返回的 ID |
   | `r2_buckets[0].bucket_name` | R2 桶名 |

   绑定名保持 `DB` 和 `FILES`，R2 不开放公开访问。模板使用 `workers.dev`；自定义域名需由同一账号管理，在生产环境设 `workers_dev: false` 并添加：

   ```json
   { "routes": [{ "pattern": "note.example.com", "custom_domain": true }] }
   ```

4. 生成两个不同的随机值，分别设置 Secrets：

   ```bash
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url') + '\n')"
   npm run cf -- secret put APP_SECRET
   # 再生成一个值，用于 SETUP_TOKEN：
   npm run cf -- secret put SETUP_TOKEN
   ```

   首次设置时 Wrangler 可能询问是否创建 Worker。`APP_SECRET` 用于登录校验和 AI Key 加密，`SETUP_TOKEN` 用于首次设置密码；不要写入配置或提交到 Git。

5. 部署：

   ```bash
   npm run deploy
   ```

   命令依次构建、迁移 D1、部署 Worker，任一步失败即停止。使用 pnpm 时运行 `pnpm run deploy`。

6. 打开 `https://你的站点/#setup=你的SETUP_TOKEN` 设置密码。初始化后链接失效，不要公开。确认笔记保存、附件下载正常，Cron 每 30 分钟运行，再导出一次[备份](backups.md)。

`npm run cf -- <命令>` 使用实例配置的 `production` 环境。`wrangler.selfhost.jsonc` 已被 Git 忽略，更新源码时保留；模板中的运行配置有变化时同步修改。本地开发使用 `wrangler.jsonc` 和 `.wrangler/state`。

## 升级与故障恢复

### 升级

旧版若把生产配置写在 `wrangler.jsonc`，更新源码前先复制到 `wrangler.selfhost.jsonc`，保留账号、域名和资源绑定。

1. 导出整库备份，确认待发送内容已同步。
2. 查看目标版本的发布说明，更新源码并运行 `npm ci`。沿用原 D1、R2 和 Secrets。
3. 运行 `npm run deploy`，检查登录、阅读、保存和附件下载。

网页部署不更新 APK。Android 用原签名重新构建和安装，见[发布说明](android.md#更新签名与发布)。

### 发布失败或页面异常

- 构建失败：修正错误后重试，线上版本不变。
- 迁移成功但部署失败：数据库可能已更新，修正后重新部署同一版本；已应用的迁移不重复执行。
- Worker 异常：可运行 `npm run cf -- rollback`。它不回退 D1、R2 或 APK，旧代码必须兼容当前数据库，见 [Cloudflare 回滚说明](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)。
- 页面异常：重新加载或回到首页，恢复后检查草稿及待发送。清除站点数据或卸载应用会丢失未同步内容。

备份操作见[备份与恢复](backups.md)。

## 密码与密钥

忘记登录密码时，在部署端运行：

```bash
npm run reset-password -- --local
# 远端实例：
npm run reset-password -- --remote --url https://你的站点
```

重置保留资料，撤销会话并生成新设置链接。中断时保持锁定，修正后重试；本地重置后需重启开发服务。登录密码重置不能找回[内容加密密码](encryption.md)。

升级保留 `APP_SECRET`。轮换它后需重置登录密码，并重新保存 AI Key。

登录校验在浏览器中执行 60 万次 PBKDF2，再由 Worker 用 `APP_SECRET` 做 HMAC-SHA256；D1 不保存原密码或可直接登录的派生值。

## 清理频率

常规维护每 30 分钟执行；无引用文件在 UTC 00:00、06:00、12:00、18:00 扫描，去重记录每天清理一次，保留至少 7 天。手动清理、永久删除和清空会话会触发文件扫描。

每轮最多回收 200 个对象，R2 删除成功后才释放容量。草稿预留 24 小时，到期后等待清理；积压文件可能需要多轮处理。

## 平台差异与限制

- 迁移触发器中的 `CASE … END` 加括号，避免云端报 `incomplete input`，见 [workers-sdk#4727](https://github.com/cloudflare/workers-sdk/issues/4727)。
- Workers 的 PBKDF2 次数受限，密码派生放在浏览器，不降低次数。
- 全文索引是可重建数据，不进入整库备份。含 FTS 虚拟表的数据库导出有限制，日常备份用应用的 ZIP。
- 备份恢复按 D1 单次查询数和绑定值大小限制分块。

## 用量与费用

应用的 8 GB 上限不等于费用上限。账号内项目共享免费额度，大正文读写和批量清理可能超过免费 CPU 预算。DeepSeek 另按自己的 API Key 计费。

额度与计费：[Workers](https://developers.cloudflare.com/workers/platform/limits/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2](https://developers.cloudflare.com/r2/pricing/)。
