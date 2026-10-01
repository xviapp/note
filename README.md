# 页间 · 私人笔记库

适配电脑和手机的单人笔记 Web 应用。首次通过专属链接设置一个密码，以后只用密码登录。打开笔记直接阅读，编辑器在确认后才加载。

## 已实现

- 树形目录；Markdown、纯文本笔记可继续包含子节点；支持新建、重命名、拖动、菜单移动与删除。
- Markdown 渲染、标题目录、任务列表、代码与表格；内部链接使用稳定节点 ID；外部网页另开标签页。
- PDF 页码跳转与缩放；PNG、JPEG、GIF、WebP、AVIF 图片放大及双指缩放；文件可作为节点或附件。同一附件另建文件节点时复用原文件。
- 默认只读；先确认全库编辑，再确认单篇正文编辑；电脑源码与预览并排，手机切换显示；手动保存、离开草稿提示、冲突保留草稿。
- 7 天回收站、当前版本加最近 5 个历史版本、收藏、最近 20 项访问记录。
- Markdown、纯文本及 PDF 阅读位置本地记录、最多每 30 秒云端同步；切换笔记时补写，版本检查避免旧进度覆盖新进度。
- 修改密码、退出当前设备或所有设备、部署端重置密码。
- 全库默认 8 GB，上限可调，80% 用量提醒；历史、回收站、待清理文件和上传预留均计入空间。

正文最多 1 MiB，单文件最多 50 MB。附件最多 100 个。超额时可以继续阅读、收藏、删除和清理。全文搜索、整库导出导入和离线内容库不在此版本范围内。

## 本地运行

需要 Node.js 22.12 或更新版本。

```bash
npm ci
npm run dev
```

启动脚本会生成本地 `.dev.vars` 随机密钥、执行本地数据库迁移，并打印专属设置链接。用该链接打开 `http://127.0.0.1:5173`，设置并确认至少 12 个字符的密码即可使用。令牌位于 URL 的 `#setup=…` 片段中，进入页面后立即从地址栏移除，不放进请求查询参数。

前端默认端口为 `5173`，本地 Worker 默认端口为 `8787`；端口占用时自动顺延，实际入口以启动日志中的链接为准。可通过 `NOTE_UI_PORT` 和 `NOTE_WORKER_PORT` 指定起始端口。本地 D1 和 R2 保存在 `.wrangler/state`，与 Cloudflare 远端数据独立。`.dev.vars`、本地数据库、上传文件和测试产物均已加入 Git 忽略列表。不要删除 `.wrangler/state` 来重置密码。

本地开发不会自动触发 Cron，可在设置中执行一批清理，或访问 Wrangler 打印的本地定时任务测试地址。

## Cloudflare 部署

架构为 **Workers 静态资源 + Worker API + D1 + 私有 R2**。浏览器与 API 同源。正文保存在 R2 的不可变对象中，D1 保存节点、版本指针、文件引用、会话、阅读记录和容量登记。

本仓库没有创建远端资源，也没有启用付费套餐。`wrangler.jsonc` 中的数据库 ID 是本地开发占位值，部署前需要替换。

1. 在有部署权限的终端登录：

   ```bash
   npx wrangler login
   npx wrangler d1 create xvi-note
   npx wrangler r2 bucket create xvi-note-files
   ```

   把 D1 返回的 ID 写入 `wrangler.jsonc` 的 `d1_databases[0].database_id`；核对数据库名、R2 桶名及 Worker 名称。R2 保持私有，不启用公开访问或公开自定义域名。

2. 迁移数据库、构建并部署：

   ```bash
   npx wrangler d1 migrations apply DB --remote
   npm run deploy
   ```

3. 分别生成两个独立随机值，作为 `APP_SECRET` 和 `SETUP_TOKEN`，通过 Wrangler Secret 输入。每个值至少 32 个字符，建议使用下面的 32 随机字节生成方式；不要把值写入 `wrangler.jsonc` 或 Git。

   ```bash
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url') + '\n')"
   npx wrangler secret put APP_SECRET
   # 再生成一个不同的随机值，用于下面的 SETUP_TOKEN
   npx wrangler secret put SETUP_TOKEN
   ```

4. 打开 `https://你的站点/#setup=刚设置的SETUP_TOKEN`，由自己设置密码。初始化原子提交，完成后此链接无法再次设置密码。

5. 在免费套餐的测试站点先完成下述远端验收，再用于正式资料；在 Cloudflare 控制台检查 Cron、请求日志、CPU 和 R2/D1 用量。可以在 `vars.APP_NAME` 修改站点名称。

### 免费额度验证状态

此项目尽量减少写入和对象复制，但 **尚未在 Cloudflare 远端验证免费套餐的 CPU 预算**。本地 workerd 已通过原生 PBKDF2 SHA-256、600,000 次迭代的初始化、登录和修改密码测试；本地 wall time 不是远端 CPU 用量。

远端验收应在单独测试站点进行，记录普通读取、初始化、正确与错误密码登录、修改密码、保存接近 1 MiB 的正文、PDF Range 请求、文件上传及每批清理的 CPU 时间、响应延迟、状态码和资源超限情况。每项至少重复 10 次并记录最大值与 P95；用 Workers Observability 的事件 CPU 时间核对，不以浏览器请求耗时代替。出现 CPU 限制时，应重新评审登录计算方式或部署预算，不能降低密码参数或自动升级套餐来掩盖问题。

截至设计核对日（2026-10-01），Workers Free 为每天 100,000 次请求、单次请求 10 ms CPU；D1 免费版每天读取 500 万行、写入 10 万行，单库上限 500 MB；R2 标准存储包含 10 GB-month、每月 100 万次 A 类和 1,000 万次 B 类操作。额度由账号中的项目共享，应用的 8 GB 上限不是费用封顶。R2 需要先开通订阅；请在部署时核对官方最新额度。

官方来源：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2 计费](https://developers.cloudflare.com/r2/pricing/)、[R2 开通](https://developers.cloudflare.com/r2/get-started/)。

## 忘记密码

本地：

```bash
npm run reset-password -- --local
```

远端（需要 Cloudflare 部署权限）：

```bash
npm run reset-password -- --remote --url https://你的站点
```

命令先锁定登录和初始化入口、撤销所有会话，然后轮换初始化令牌，最后开放一次密码设置并打印新链接。中途失败保持锁定，可修复错误后重新运行。本地重置后需重启开发服务以读取新令牌。笔记、附件、回收站与历史版本均保留。

资料通过登录控制访问，没有使用登录密码进行端到端加密，因此密码重置不改变文件。请妥善保管 Cloudflare 部署权限。

## 验证

```bash
npm run check          # 前后端 TypeScript 检查
npm test               # 真实 workerd、D1 和 R2 集成测试
npm run build          # 生产构建；PDF 资源本地打包，不依赖第三方 CDN
npx playwright install chromium
npm run test:e2e       # 1440px 电脑和 390px 手机浏览器测试
npm audit
npx wrangler deploy --dry-run
```

浏览器测试优先使用本机 Chrome（若存在），也可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定路径；否则使用 Playwright 安装的 Chromium。测试自动启动 `8799` 端口并使用独立 `.wrangler/e2e/state`；仅这个测试目录会被清空，日常开发数据不受影响。截图与失败追踪位于 `test-results`。

测试覆盖私有 API、两级编辑、来源校验、初始化并发、密码变更、正文并发冲突、幂等保存、历史保留、共享文件引用、容量竞争、上传中断、清理重试、独立回收批次和跨设备阅读进度；浏览器验证手机抽屉、源码切换、标题目录、文件预览和未保存草稿。

## 项目结构

| 路径                 | 职责                                      |
| -------------------- | ----------------------------------------- |
| `src/`               | React 阅读界面、懒加载编辑器与 PDF 查看器 |
| `worker/auth.ts`     | 密码、会话、来源约束配合的编辑确认令牌    |
| `worker/library.ts`  | 笔记树、正文保存、版本与稳定链接          |
| `worker/storage.ts`  | 私有文件、Range 读取、原子容量预留        |
| `worker/recovery.ts` | 子树回收、恢复、分批清理                  |
| `worker/reading.ts`  | 收藏、最近访问、进度版本检查              |
| `migrations/`        | D1 schema、索引与事务保护触发器           |
| `scripts/`           | 开发环境、密码重置和测试服务              |

数据库提交使用 D1 batch 与触发器保证版本、引用及容量检查原子性。R2 与 D1 之间没有跨服务事务：上传先预留容量，提交失败保留旧版本并清理新对象；垃圾清理先在 D1 中标记对象并禁止新引用，R2 确认删除后才释放容量。定时任务每 30 分钟执行一批，未引用的草稿文件最多保留 24 小时。

[设计记录](docs/superpowers/specs/2026-10-01-personal-notebook-design.md) · [实施计划](docs/superpowers/plans/2026-10-01-personal-notebook-implementation.md)
