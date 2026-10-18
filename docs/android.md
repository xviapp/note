# Android 客户端

包名 `app.xvi.note`，使用 Capacitor 和仓库中的 React 界面。需要 Android 8.0+、Android System WebView 125+。

## 服务与会话

首次启动时填写自己的 HTTPS 站点根地址，也可在登录页、连接失败页或「设置 → 服务器」更换。换服务器会重启应用，登录、缓存和本机设置按站点分开。默认值来自 `capacitor.config.ts` 的 `server.hostname`。

界面随 APK 提供，WebView 使用所选站点的来源，只有同源 `/api/` 请求联网。外链在系统浏览器打开；浏览器与客户端分别登录。网页部署不更新包内界面。

下载时选择保存位置，原生层流式写入，无需全盘存储权限。只有本站文件接口携带 Cookie，不跟随重定向。系统备份和设备迁移不包含会话、缓存与草稿；整库备份在网页版操作。

## 分享与打开方式

可接收文字、链接、Markdown、PDF 和图片，分享窗口浮在原应用上方。内容可预览，Markdown 和文本可编辑；保存目录可临时更改。未登录时内容暂存在本机，7 天后清理。

一次最多 10 个文件、合计 100 MiB，单文件 50 MB，文本 1 MiB。文字、链接和单张图片可存入随手记，图片需联网。

## 快捷入口

长按图标可打开「随手记」「今日记」「问青藜」。桌面「页间快捷栏」提供这三个入口和主界面。

- 随手记：只输入文字，先写入本机加密队列再关闭，联网后后台发送。未登录或需要内容密钥时，打开页间处理。文字选择菜单的「存入随手记」使用同一窗口，见[随手记](quick-clips.md)。
- 今日记：写标题、正文和照片，日记本在「设置 → 保存位置」选择，默认最近写过的日记本。点保存后窗口隐藏，照片上传后追加。失败保留内容，下次打开继续；跨日记录仍记入写下的日期。
- 问青藜：打开全局对话，可最大化，按返回或点遮罩关闭。先显示本机最近对话，再取服务器内容。打开笔记或设置时转到主界面。

今日记离线或日记本未解锁时可先写，内容用本设备密钥加密暂存，解锁后上传。在「设置 → 待发送」可查看、重试或删除，退出登录会清除。

## 应用锁

在「设置 → 密码与设备 → 应用锁」用和锁屏相同的数字键盘设置 4～6 位 PIN（输入两次确认；修改和关闭时先输入当前 PIN），Android 11+ 且支持强生物识别时可启用指纹。应用锁只锁主界面，随手记、今日记、问青藜和分享窗口不受影响。

离开应用后可选立即、1、5、30 分钟重新上锁，默认 1 分钟；进程重启总要解锁。文件选择、拍照等系统窗口返回通常不算离开，超过 5 分钟除外。

连续输错 5 次需等 30 秒，之后每次翻倍，最长 15 分钟。修改或关闭 PIN 时也计入。指纹取消后可用 PIN；验证中切到其他应用会取消，返回后重新验证。加密条目也可单独启用指纹解锁，见[本地加密](encryption.md#android-指纹解锁)。

忘记 PIN 可确认退出登录并重置应用锁，这会清除本机缓存和未发送内容。开启应用锁后，Android 13+ 最近任务不显示应用画面。

## 阅读窗口

阅读设置见[阅读与本机缓存](offline-reading.md)。加密笔记禁止截屏并隐藏最近任务预览，离开笔记后恢复。

选中阅读正文时使用应用内的单行工具栏，提供「问青藜」「翻译」「高亮」，「更多」中可添加批注、记一下、复制、全选或分享。系统选区手柄保留，不重复显示系统选文菜单；输入框和正文编辑器仍使用系统菜单。返回键先收起「更多」，再关闭选文工具栏；关闭或滚动后仍保留的选区改用系统菜单。旧版安装包不支持分享时，改为复制选文。

手机使用首页目录树和底部导航，横屏相同。长按 0.35 秒可拖动目录项，悬停文件夹可展开，靠近边缘自动滚动，移动后 6 秒内可撤销；也可用「移动到…」。

PDF 支持双指缩放，松手后重绘清晰页面，缩放比例按文件保存在本机。切到后台时保存阅读进度；青藜回复中途切走再回来，会读取服务器已保存的结果。

## 构建

需要 Node.js 22.12+、JDK 21、Android SDK Platform 37 和 Build Tools 37。

```bash
npm run android:apk                 # 调试 APK
npm run install:android             # 构建并覆盖安装
npm run android:release             # 签名正式版 APK
npm run install:android:release     # 构建并安装正式版
```

产物在 `artifacts/`。多个设备时加 `-- --device <序列号>`，或设置 `ANDROID_SERIAL`。`npm run build:android` 只构建并同步资源，`npm run android:open` 打开 Android Studio。

正式签名需要 `NOTE_ANDROID_KEYSTORE`、`NOTE_ANDROID_STORE_PASSWORD`、`NOTE_ANDROID_KEY_ALIAS`、`NOTE_ANDROID_KEY_PASSWORD`。可放在 Git 忽略的 `.env`，环境变量优先。保管好签名文件和密码；更换签名不能覆盖安装。

## 更新、签名与发布

每次发布递增 `android/app/build.gradle` 的 `versionCode`。先构建 APK、部署 Worker，再上传安装包：

```bash
npm run android:release
npm run deploy
npm run android:publish -- --apk artifacts/yejian-<版本>-android-release.apk --notes docs/releases/<版本>.txt --remote --bucket 你的R2桶名
```

发布脚本检查包名、版本和签名，先上传 APK 再更新清单。去掉 `--remote` 只校验、生成清单，不上传。

客户端可在设置中检查更新，校验签名兼容性和下载 SHA-256，保存后通过系统文件管理器安装。安装包保存在 R2 的 `releases/android/`，需要登录访问，不计入笔记库容量。

## 实现约定

- 保留 `server.hostname` 的同源方案，不改为远端 `server.url` 或通配 `allowNavigation`。
- 主题背景在首帧前设置。使用同一个 `ColorDrawable`，不要用 `SystemBars.setStyle` 覆盖颜色。
- WebView 代理在页面准备后设置，不能提前到 `onCreate`，见[网络代理](network-proxy.md)。
- 原生占位卡片由 `WindowTheme` 绘制，修改网页浮窗样式时同步检查，避免切换时跳动。
- PDF.js 使用 `legacy` 主库和 worker；包内网页资源、APK、构建缓存和签名不进 Git。
- 中文与公式字体保留完整字形，以 WOFF2 格式随包提供；Android 构建移除 CSS 中的 WOFF、TTF 备用引用，避免重复打包。

## 验证

```bash
node scripts/android.mjs testDebugUnitTest
node scripts/android.mjs lintDebug
npm run test:android-cli
```

WebView 调试用 Playwright 的 `_android.devices()`。写入测试把 `/api/` 转到本地测试 Worker，模拟 DeepSeek；原生下载需另行验证。

启动画面检查需要 Android 14 模拟器、已安装测试包及 FFmpeg：

```bash
npm run test:android-startup -- --device emulator-5560 --theme dark
npm run test:android-startup -- --device emulator-5560 --theme starry
npm run test:android-startup -- --device emulator-5560 --theme system
```

脚本只接受模拟器，录屏和检测结果保存在 `.wrangler/startup-*`。
