# 页间

落笔于页，留心于间

适配电脑和手机的个人自部署笔记应用，提供 Web 和 Android 客户端。每个实例只供一人使用，不提供公开注册。首次通过专属链接设置一个密码，以后只用密码登录。打开笔记直接阅读，编辑器在点击「编辑正文」（手机显示「编辑」）后才加载。

## 自部署前须知

- 需要自己的 Cloudflare 账号（Workers、D1、R2）；存储和请求费用由部署者承担，免费额度不保证覆盖全部使用。
- 普通笔记无需 AI；使用青藜、翻译、书页识别等功能需配置自己的 DeepSeek API Key，调用费用由该 Key 所属账号承担。
- 默认内容受登录保护；单独设置加密密码后，内容在设备上加密上传。加密密码遗失无法恢复，登录密码重置不能解密内容。
- AI 功能会让 Worker 处理解密后的相关内容，并将本次输入及所需上下文发送给 DeepSeek，详见[加密边界](docs/encryption.md#由服务器处理的功能)。
- 本机缓存、草稿和待发送内容不能代替备份。请定期在网页版导出整库 ZIP，并保留在部署环境之外。

从[首次部署](docs/cloudflare-deployment.md#首次部署)开始；已有实例请看[升级与故障恢复](docs/cloudflare-deployment.md#升级与故障恢复)。

## 最新更新

0.4.30：优化笔记列表、搜索筛选和手机阅读操作，手机隐藏排序与紧凑显示栏；青藜新增思考深度设置与引用原文定位；统一草稿和同步提示，修复浏览器兼容问题；补齐自部署配置、页面异常恢复入口及 MIT 授权。详见[发布说明](docs/releases/0.4.30.txt)。

## 功能

- 笔记与资料：树形目录，支持 Markdown、纯文本、PDF、图片、链接及 [arXiv 论文](docs/arxiv.md)；列表显示摘要、下级数量和书籍阅读进度，电脑网页版提供排序与紧凑显示选项；可收藏、按目录和类型[搜索](docs/search.md)标题、正文和批注、拖动整理、自定义文件夹图标。
- 阅读与编辑：首页「继续阅读」回到最近读的笔记及进度（书页显示书名和页码，不含图片、日记和项目条目），章节目录、分屏对照、阅读进度同步，三种主题及字体排版设置。笔记默认只读，点「编辑正文」后编辑；本机保留未保存草稿，保存冲突时可覆盖或另存为新笔记；草稿暂存与同步状态分别提示，待同步内容在当前页面顶部可查看，支持图片和笔记链接插入。
- [日记本](docs/journals.md)：每天一篇，按月历补写，直接追加文字和照片。
- [书籍与书页](docs/books.md)：拍照识别书页、生成摘要、逐页讨论并整理读书笔记。
- [项目与文件引用](docs/projects.md)：汇总待办、问题和笔记，跟踪状态与进展，支持引用已有资料。
- [随手记](docs/quick-clips.md)：保存文字与图片，可插入正文或转为笔记；支持离线文字记录、Android 桌面组件及系统分享。
- [青藜与翻译](docs/assistant.md)：按文件保存对话，可引用选文、附件和截图，回复可存为笔记；设置中可调整会话思考深度（关闭、低、高、最高，默认关闭），思考与回答共用单次回复上限；划词翻译保存记录并支持回到原文。首次使用需配置自己的 DeepSeek API Key。
- [离线阅读](docs/offline-reading.md)：自动缓存与手动保存，支持正文、论文、PDF、图片和附件；默认本机容量 200 MB。
- [本地加密](docs/encryption.md)：为条目及其下级单独设置密码，内容在设备上加密后上传。
- 资料保护：7 天回收站、当前版本及最近 5 个历史版本、[整库 ZIP 备份与恢复](docs/backups.md)；全库容量默认 8 GB，可调整，历史、回收站和上传预留均计入。
- [Android 客户端](docs/android.md)：系统分享、应用内更新、自建服务器与[网络代理](docs/network-proxy.md)。

普通笔记正文最多 1 MiB，单文件最多 50 MB，附件最多 100 个。超额时仍可阅读、收藏、删除和清理。加密笔记的正文只在本机搜索；离线正文编辑暂未提供。

电脑快捷键：Ctrl/Cmd+K 或 / 搜索，N 新建，E 编辑，Q 随手记，? 查看全部快捷键；输入时不触发单键快捷键。

## Android 客户端

Android 客户端使用 Capacitor，工程位于 `android/`，共用 React 界面与云端数据。默认连接 `https://note.xvi.app`；首次启动、登录页或「设置 → 服务器」可改为其他自建服务器，不同服务器的登录和离线缓存分开保存。已缓存的文件可以断网重开，编辑、翻译与青藜需联网。需要 Android 8.0+ 与 Android System WebView 125+，旧网页组件会显示更新提示。

从其他应用分享到页间时，会在原应用上方弹出小窗口，按内容显示 arXiv 论文、网页链接、Markdown、纯文本、PDF、图片，保存后回到原应用。应用内可检查并下载新版本。

本机构建需要 Node.js 22.12+、JDK 21、Android SDK Platform 37 和 Build Tools 37：

```bash
npm ci
npm run android:apk        # 调试包，输出到 artifacts/
pnpm install:android       # 连接手机后构建并覆盖安装，保留应用数据
```

修改客户端后需要重新构建并安装 APK，部署网站不会替换已安装包内的界面。签名、发布和原生测试见 [Android 客户端](docs/android.md)，图标见[应用图标](docs/branding.md)。

## 本地运行

需要 Node.js 22.12 或更新版本。

```bash
npm ci
npm run dev
```

启动脚本会生成本地 `.dev.vars` 随机密钥、执行本地数据库迁移，并打印专属设置链接。用该链接打开 `http://127.0.0.1:5173`，设置并确认至少 8 个字符的密码即可使用。令牌位于 URL 的 `#setup=…` 片段中，进入页面后立即从地址栏移除，不放进请求查询参数。

前端默认端口为 `5173`，本地 Worker 默认端口为 `8787`；端口占用时自动顺延，实际入口以启动日志中的链接为准。可通过 `NOTE_UI_PORT` 和 `NOTE_WORKER_PORT` 指定起始端口。本地 D1 和 R2 保存在 `.wrangler/state`，与 Cloudflare 远端数据独立。`.dev.vars`、本地数据库、上传文件和测试产物均已加入 Git 忽略列表。不要删除 `.wrangler/state` 来重置密码。

本地开发不会自动触发 Cron，可在设置中执行一批清理，或访问 Wrangler 打印的本地定时任务测试地址。

## Cloudflare 部署

架构为 **Workers 静态资源 + Worker API + D1 + 私有 R2**。浏览器与 API 同源。正文保存在 R2 的不可变对象中，D1 保存节点、版本指针、文件引用、会话、阅读记录和容量登记。

`wrangler.jsonc` 用于本地开发；生产环境使用 Git 忽略的 `wrangler.selfhost.jsonc`，从 `wrangler.selfhost.example.jsonc` 复制后填写自己的账号和资源。按[首次部署](docs/cloudflare-deployment.md#首次部署)完成配置与 Secrets 设置后，运行：

```bash
npm run deploy
```

命令依次构建、迁移 D1、部署 Worker；使用 pnpm 时运行 `pnpm run deploy`。更新前先备份，详见[升级与故障恢复](docs/cloudflare-deployment.md#升级与故障恢复)。忘记登录密码时可在部署端[重置密码](docs/cloudflare-deployment.md#密码与密钥)，资料保留；内容加密密码无法重置找回。

## 验证

界面基础颜色、字号、圆角与点击尺寸在本项目的 `scripts/theme/brand-theme.ts` 中维护，导出到 `src/family-tokens.css`。在本目录用 `npm run theme:check` 检查、`npm run theme:sync` 更新；安装、构建和主题生成均不依赖工作区其他项目或归档源码。

```bash
npm run check          # 前后端 TypeScript 检查
npm run lint           # 代码检查
npm test               # Worker 集成测试与前端测试
npm run test:build     # 离线资源二进制完整性与构建版本更新
npm run build          # 生产构建；PDF 资源本地打包，不依赖第三方 CDN
npx playwright install chromium
npm run test:e2e       # 1440px 电脑和 390px 手机浏览器测试
npm audit
npm run cf -- deploy --dry-run
```

浏览器测试优先使用本机 Chrome（若存在），也可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定路径；否则使用 Playwright 安装的 Chromium。测试自动启动 `8799` 端口并使用独立 `.wrangler/e2e/state`；仅这个测试目录会被清空，日常开发数据不受影响。截图与失败追踪位于 `test-results`。

## 项目结构

| 路径                    | 职责                                      |
| ----------------------- | ----------------------------------------- |
| `src/`                  | React 阅读界面、懒加载编辑器与 PDF 查看器 |
| `worker/auth.ts`        | 密码、会话、来源约束配合的编辑确认令牌    |
| `worker/library.ts`     | 笔记树、正文保存、版本与稳定链接          |
| `worker/arxiv.ts`       | arXiv 正文提取、版本确认与私有图片导入    |
| `worker/storage.ts`     | 私有文件、Range 读取、原子容量预留        |
| `worker/recovery.ts`    | 子树回收、恢复、分批清理                  |
| `worker/reading.ts`     | 收藏、最近访问、进度版本检查              |
| `worker/assistant.ts`   | 文件会话、流式生成、历史与 Markdown 导出  |
| `worker/translation.ts` | 划词翻译、持久缓存、原文位置与记录管理    |
| `worker/deepseek.ts`    | AI 凭据加密、连接测试与 DeepSeek 适配     |
| `worker/books.ts`       | 书籍资料、书页拍照识别、书中对话的角色    |
| `worker/backups.ts`     | 整库备份导出与恢复                        |
| `shared/`               | 前后端共用的类型、限制与备份格式          |
| `android/`              | Capacitor 原生工程与服务器、下载、分享    |
| `migrations/`           | D1 schema、索引与事务保护触发器           |
| `scripts/`              | 开发环境、密码重置和测试服务              |

存储与清理机制见 [Cloudflare 部署](docs/cloudflare-deployment.md#清理频率)。

## 许可证

项目代码采用 [MIT 许可证](LICENSE)。随包提供的第三方依赖、字体等仍遵循各自许可证；打包字体的许可证位于 `/licenses/`。
