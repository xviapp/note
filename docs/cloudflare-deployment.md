# Cloudflare 部署

## 正式环境

| 项目          | 值                                                    |
| ------------- | ----------------------------------------------------- |
| 地址          | https://note.xvi.app（关闭 `workers.dev` 与预览地址） |
| Wrangler 环境 | `production`                                          |
| Worker        | `xvi-note`                                            |
| D1            | `xvi-note` / `6ee905d7-80bf-46fa-a35c-80d839581ff7`   |
| R2            | `xvi-note-files`，公开访问关闭                        |
| 清理任务      | 每 30 分钟                                            |

生产 D1、R2 与本地 `.wrangler/state` 相互独立。首次设置链接和初始密钥保存在 Git 忽略的 `.wrangler/deploy/`（目录 0700、文件 0600），不写入文档。更新使用 `pnpm run deploy`（或 `npm run deploy`），它依次构建、应用生产迁移、部署，并保留线上 Secrets；`pnpm deploy` 是 pnpm 内置命令，不能省略 `run`。远端密码重置命令固定使用 `production` 环境。

## 平台差异与限制

- **D1 迁移解析**：云端对触发器中未加括号的 `CASE … END` 报 `incomplete input`，本地却能通过。迁移里的 CASE 表达式一律加括号，见 [workers-sdk#4727](https://github.com/cloudflare/workers-sdk/issues/4727)。
- **PBKDF2 次数上限**：云端 Workers 最多 100,000 次（[workerd 限制](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h)），本地不受限。因此 600,000 次 PBKDF2 在浏览器中计算，服务端用 `APP_SECRET` 做带域标识的 HMAC-SHA256 校验；不要为通过限制而降低次数。
- **D1 单次限制**：免费方案每次调用最多 50 条查询、单个绑定值 2 MB，备份恢复按此分块（见 `worker/backups.ts`）。

## 免费额度与 CPU

首次部署时的云端冒烟测试中，登录、改密、上传、PDF 分段读取等请求 CPU 在 10 ms 以内，但接近 1 MiB 的正文读写（约 20 ms）和永久删除（约 13 ms）超过 [Workers Free 的 10 ms 标称预算](https://developers.cloudflare.com/workers/platform/limits/)。请求都能完成，但不能承诺所有操作始终在免费 CPU 预算内；出现限制时应调整实现或部署预算，不降低密码强度、不限制既定正文容量，也不自动升级套餐。容量与压力验收应在单独测试站点进行，每项至少重复 10 次，用 Workers Observability 的事件 CPU 时间记录最大值与 P95。

R2 / D1 / Workers 的免费额度由账户内项目共享，应用的 8 GB 内容上限不是费用封顶；部署前请核对官方最新额度：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2 计费](https://developers.cloudflare.com/r2/pricing/)。
