# 页间

落笔于页，留心于间

供个人自部署的笔记和阅读应用，提供 Web 和 Android 客户端。每个实例只供一人使用，用密码登录。

## 开始使用

需要自己的 Cloudflare 账号，使用 Workers、D1 和私有 R2。青藜、翻译和书页识别另需 DeepSeek API Key，费用由自己承担。

- [首次部署](docs/cloudflare-deployment.md#首次部署)
- [升级与故障恢复](docs/cloudflare-deployment.md#升级与故障恢复)
- [备份与恢复](docs/backups.md)

加密密码遗失后无法恢复内容。使用 AI 功能时，Worker 会解密相关内容，并将输入发送给 DeepSeek，详见[本地加密](docs/encryption.md)。本机缓存和草稿不能代替备份。

## 最新更新

0.4.31：普通 Markdown 默认开启快捷编辑，支持追加文字和照片、章节修改、草稿恢复与冲突保护。选文工具栏保持单行，「更多」纵向展开，Android 阅读选文菜单去重。手机隐藏列表排序栏，Android 默认连接 `note.iyi.li`，安装包缩小约 43%。详见[发布说明](docs/releases/0.4.31.txt)。

## 功能

- 笔记：Markdown、纯文本、PDF、图片、网页链接；树形目录、收藏、[搜索](docs/search.md)、高亮和批注。电脑上可按住 Ctrl/Cmd 或 Shift 点击多选，批量移动或移到回收站；可[导入 Markdown 笔记文件夹](docs/import.md)。普通 Markdown 默认开启[快捷编辑](docs/markdown-editing.md)，直接追加内容、修改或删除章节，可按篇关闭。
- 阅读：章节目录、进度记忆、分屏、三种主题、字体与排版设置。[离线阅读](docs/offline-reading.md)支持正文、PDF、图片和附件。
- 编辑：点击「编辑正文」后编辑；本机暂存草稿，保存冲突时可覆盖或另存为新笔记。
- [arXiv 论文](docs/arxiv.md)：导入正文和插图，逐段翻译、对照阅读。
- [日记本](docs/journals.md)：按月历书写，追加文字和照片。
- [书籍](docs/books.md)：拍照识别书页、逐页讨论、整理读书笔记。
- [项目](docs/projects.md)：汇总待办、问题和笔记，引用已有文件。
- [随手记](docs/quick-clips.md)：保存文字和图片，插入正文或转为笔记。
- [青藜与翻译](docs/assistant.md)：引用选文、文件和截图提问，保存回复与翻译记录。
- 资料保护：7 天回收站、当前版本及最近 5 个历史版本、整库备份、[本地加密](docs/encryption.md)。

正文上限 1 MiB，单文件 50 MB，每篇最多 100 个附件。全库默认 8 GB，历史版本、回收站和上传预留均占用空间。离线时可阅读，正文编辑需联网。

电脑快捷键：Ctrl/Cmd+K 或 / 搜索，N 新建，E 编辑，Q 随手记，? 查看全部快捷键。

## 本地运行

需要 Node.js 22.12+。

```bash
npm ci
npm run dev
```

脚本生成 `.dev.vars`、执行迁移并打印首次设置链接。打开链接后设置至少 8 个字符的密码。

Vite 默认端口 5173，Worker 默认端口 8787；占用时顺延，以终端输出为准。可用 `NOTE_UI_PORT`、`NOTE_WORKER_PORT` 指定端口。本地资料保存在 `.wrangler/state`，不要删除它来重置密码。

## 部署

按[部署文档](docs/cloudflare-deployment.md)配置 `wrangler.selfhost.jsonc` 和 Secrets 后运行：

```bash
npm run deploy
```

命令依次构建、迁移 D1、发布 Worker。使用 pnpm 时运行 `pnpm run deploy`，保留 `run`。

## Android

[下载 APK](https://github.com/xviapp/note/releases/latest/download/app.xvi.note.apk)。需要 Android 8.0+、Android System WebView 125+，默认连接 `iyi.li`，也可填写自己的服务器地址。

构建需要 JDK 21、Android SDK Platform 37 和 Build Tools 37：

```bash
npm run android:apk       # 调试包，输出到 artifacts/
npm run install:android   # 构建并覆盖安装到已连接设备
```

网页部署不会更新已安装的 APK。签名、发布和代理设置见 [Android 客户端](docs/android.md)。

## 开发检查

```bash
npm run check
npm run lint
npm test
npm run test:build
npm run build
npx playwright install chromium
npm run test:e2e
```

E2E 使用独立的 `.wrangler/e2e/state`，不清理本地资料。截图和追踪保存在 `test-results/`。

主题源为 `scripts/theme/brand-theme.ts`；修改后运行 `npm run theme:sync`，用 `npm run theme:check` 检查。图标修改见[品牌资源](docs/branding.md)。

## 许可证

项目代码采用 [MIT](LICENSE)。第三方依赖和字体遵循各自许可证，打包字体的许可证位于 `/licenses/`。
