# Cloudflare 部署

## 首次部署

需要 Node.js 22.12+、自己的 Cloudflare 账号，并开通 Workers、D1 和 R2。每个实例供一人使用。

1. 获取源码，在仓库根目录安装依赖并登录 Cloudflare：

   ```bash
   npm ci
   npx wrangler login
   ```

2. 创建数据库、私有文件桶，复制配置模板：

   ```bash
   npx wrangler d1 create xvi-note
   npx wrangler r2 bucket create xvi-note-files
   cp wrangler.selfhost.example.jsonc wrangler.selfhost.jsonc
   ```

   如果同一账号内名称已占用，使用其他名称。已有 `wrangler.selfhost.jsonc` 时直接编辑，不要用模板覆盖。

3. 编辑 `wrangler.selfhost.jsonc` 的 `env.production`：

   | 配置 | 填入内容 |
   | --- | --- |
   | `account_id` | Cloudflare 账号 ID，可在控制台查看或运行 `npx wrangler whoami` |
   | `name` | 本实例的 Worker 名称 |
   | `d1_databases[0].database_name` | 刚创建的 D1 名称 |
   | `d1_databases[0].database_id` | 创建 D1 时返回的数据库 ID |
   | `r2_buckets[0].bucket_name` | 刚创建的 R2 桶名 |

   保持绑定名称 `DB`、`FILES` 不变。R2 不开放公开访问。模板默认启用 `workers.dev`，无需先准备域名；如果使用自己的域名，可将 `workers_dev` 改为 `false`，并在同一生产环境添加 `"routes": [{ "pattern": "note.example.com", "custom_domain": true }]`，域名需由该 Cloudflare 账号管理。

   `wrangler.jsonc` 仅用于本地开发，保留其中本地资源名称可继续使用已有 `.wrangler/state`。`wrangler.selfhost.jsonc` 已加入 Git 忽略，更新源码时保留；模板中的 `main`、`assets.directory`、兼容日期等运行配置若随版本改变，需要同步到自己的配置。不要将 Secrets 写入任何 Wrangler 配置。

4. 分别生成两个独立随机值，设置生产 Secrets：

   ```bash
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url') + '\n')"
   npm run cf -- secret put APP_SECRET
   # 再运行一次生成命令，使用不同的值：
   npm run cf -- secret put SETUP_TOKEN
   ```

   将生成值粘贴到对应的交互输入中；首次设置时 Wrangler 可能提示创建 Worker。妥善保管两个值，`SETUP_TOKEN` 用于首次设置密码，`APP_SECRET` 用于服务端密码校验及 AI Key 加密。不要提交到 Git 或公开设置链接。

5. 构建、迁移并部署：

   ```bash
   npm run deploy
   ```

   它依次执行构建、生产 D1 迁移和 Worker 部署，任一步失败即停止。`npm run cf -- <命令>` 固定使用 `wrangler.selfhost.jsonc` 的 `production` 环境。使用 pnpm 时运行 `pnpm run deploy`，不要省略 `run`。

6. 打开部署输出的 HTTPS 地址，加上 `/#setup=你的SETUP_TOKEN`，自行设置登录密码。令牌位于 URL 片段中，进入页面后移除；初始化后不能再次使用。普通笔记可以直接使用，AI 功能需要在设置中另行配置自己的 DeepSeek API Key。

7. 确认新建和保存笔记、重新登录、上传附件正常。在 Cloudflare 控制台确认清理 Cron 已启用（每 30 分钟），并在网页版「设置 → 备份与恢复」导出一次 ZIP。

## 升级与故障恢复

### 升级

如果旧版将生产配置放在 `wrangler.jsonc` 的 `env.production` 中，更新源码前先将该文件复制为 `wrangler.selfhost.jsonc`（已有文件时不要覆盖），保留原账号、域名、D1 和 R2 绑定。新版发布命令从这个独立文件读取配置。

1. 在网页版导出整库 ZIP，保存在部署环境之外；确认待发送内容已同步。备份不含登录密码、AI Key 和仅存本机的草稿，另行保管 `APP_SECRET`、实例配置和 Android 正式签名。
2. 查看目标版本的 `docs/releases/<版本>.txt`，更新源码，运行 `npm ci`。保留 `wrangler.selfhost.jsonc`，按模板变化同步运行配置，继续使用原来的 D1、R2 和 Secrets。
3. 运行 `npm run deploy`。构建失败时线上版本不变；迁移成功但部署失败时，数据库可能已经更新，修正原因后重新部署同一版本，已应用的迁移不会重复执行。
4. 在网页版确认登录、旧笔记阅读、新建保存和附件下载正常。Android 包内包含界面，网站部署不会更新已安装 APK；需要升级界面时另行构建并使用相同签名覆盖安装，见 [Android 发布](android.md#更新签名与发布)。

### 发布失败或页面异常

- 构建或配置错误：根据终端错误修正后重试，确认实例配置的资源名称和 ID 对应自己的账号。
- 前端启动或显示异常：使用错误页的「重新加载」或「回到首页」，必要时复制错误详情。恢复后检查「设置 → 待发送」及笔记草稿；不要以清除站点数据或卸载应用作为首个修复步骤，这会丢失尚未同步的本机内容。
- 新 Worker 版本异常：可用 `npm run cf -- rollback` 按提示回退 Worker。回退不会撤销 D1 迁移、R2 文件变化，也不会回退已安装的 APK；仅在旧代码仍兼容当前数据库时使用，参见 [Cloudflare 回滚说明](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)。
- 忘记登录密码：按下方[密码重置说明](#密码与密钥)操作。

### 备份与恢复

在网页版导出整库 ZIP，恢复时新建目录并保留当前资料。加密备份需要原密码，恢复后由设备修复附件和内部链接；操作与验证方法见[备份与恢复](backups.md)。

## 密码与密钥

登录密码在浏览器中使用独立随机盐和 PBKDF2 SHA-256 计算 60 万次，Worker 再以 `APP_SECRET` 做 HMAC-SHA256 校验；D1 保存校验值与公开参数，不保存原密码或可直接登录的派生值。内容加密使用单独设置的密码，见[本地加密](encryption.md)。

忘记登录密码时，在有部署权限的终端运行：

```bash
npm run reset-password -- --local
# 或重置远端实例：
npm run reset-password -- --remote --url https://你的站点
```

重置先锁定登录与初始化入口、撤销会话，再轮换设置令牌并开放一次密码设置。资料保留，中断时保持锁定，修正错误后重新执行；本地重置后需重启开发服务。重置登录密码不能恢复内容加密密码。

日常升级保留 `APP_SECRET`；轮换它需要重置登录密码并重新保存 AI Key。

## 清理频率

Cron 仍每 30 分钟触发，会话、回收站、备份任务等常规维护保持原频率。按计划触发时间（UTC）分流：无引用文件在 00:00、06:00、12:00、18:00 扫描；请求去重记录每天 00:00 清理，仅删除超过 7 天的记录，使用 `created_at` 索引查找。

设置里的手动清理、永久删除回收站内容及清空青藜会话仍会立即触发文件扫描，不额外清理去重记录。每次最多选取 200 个符合条件的对象，按每批 20 个删除；R2 删除成功后才删除 D1 记录并释放容量。失败批次保留标记和容量，其他批次继续，失败或超出上限的对象留待后续清理。

草稿预留期为 24 小时，到期后等待下一次文件扫描；无引用对象在实际删除前仍计入空间，积压时可能需要多轮清理。

## 平台差异与限制

- **D1 迁移解析**：云端对触发器中未加括号的 `CASE … END` 报 `incomplete input`，本地却能通过。迁移里的 CASE 表达式一律加括号，见 [workers-sdk#4727](https://github.com/cloudflare/workers-sdk/issues/4727)。
- **PBKDF2 次数上限**：云端 Workers 最多 100,000 次（[workerd 限制](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h)），本地不受限。因此 600,000 次 PBKDF2 在浏览器中计算，服务端用 `APP_SECRET` 做带域标识的 HMAC-SHA256 校验；不要为通过限制而降低次数。
- **D1 全文索引**：正文搜索用 FTS5 虚拟表（`note_text_index`，trigram 分词）。`wrangler d1 export` 对虚拟表存在限制；日常备份请使用页间的整库 ZIP，它不导出可重建的全文索引，也不会改动源数据库。
- **D1 单次限制**：免费方案每次调用最多 50 条查询、单个绑定值 2 MB，备份恢复按此分块（见 `worker/backups.ts`）。

## 用量与费用

应用的 8 GB 内容上限不是费用封顶。Workers、D1 和 R2 的免费额度由账号内项目共享，大正文读写、批量清理等操作也可能超过免费 CPU 预算；根据自己的资料量和使用情况检查用量。

部署前核对官方额度与计费：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2 计费](https://developers.cloudflare.com/r2/pricing/)。DeepSeek 调用使用自己的 API Key，单独计费。
