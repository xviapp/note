# Android 客户端

Capacitor 客户端，应用名称「页间」，包名 `app.xvi.note`，共用网页的 React 界面。阅读排版、本机缓存和离线阅读见[阅读设置与本机缓存](offline-reading.md)；编辑、青藜和翻译需联网。应用内网络代理见[网络代理](network-proxy.md)，图标与启动画面见[应用图标](branding.md)。iOS 工程暂未添加。

## 服务与会话

界面随安装包提供（`dist-android/`），WebView 以所选服务器的 HTTPS 地址作为页面来源，只有同源的 `/api/` 请求交给 Chromium 走真实网络。这是 Android 支持的[本地内容与网站资源同源混用方式](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content#mix-in-app-content-with-resources-from-your-website)：保留浏览器的请求体、HttpOnly Cookie、PDF Range 和流式响应，不经过缓冲响应的原生 HTTP 层，也不放宽服务端 Origin 校验。

服务器默认是 `capacitor.config.ts` 的 `server.hostname`（`note.xvi.app`）。首次启动未登录时先显示「连接服务器」，之后可在登录页、连接失败页或「设置 → 服务器」更换；只接受默认端口的 https 站点根地址。`ServerConfig` 把选择存在本机，启动时改写 Capacitor 的 hostname；换到其他服务器会重启应用。各服务器的登录、离线缓存和本机设置按来源自然分开。不要改成加载外部网站的 `server.url`，也不要添加通配的 `allowNavigation`。

`OriginPolicy` 限制站内页面和文件下载地址，外部页面在系统浏览器中打开。下载先让用户在系统文档选择器中选位置，再由原生层流式写入；只有本站文件接口携带登录 Cookie，且不跟随重定向。无需全盘存储权限。客户端与系统浏览器分别保存会话，服务端「退出所有设备」同时撤销两者。

应用切到后台时补写阅读进度。青藜回复途中切到后台，回到前台后只要回复流停顿，就定时向服务端查询，直到服务端结束这次回复，然后直接显示服务端保存的内容（中断的回复可「继续生成」），不会一直停在生成中；再次切到后台、停止生成或关闭对话时停止查询。系统返回键先关闭浮层、弹窗、菜单和青藜，再按带草稿保护的页面导航后退；首页返回则最小化应用；清单启用 `enableOnBackInvokedCallback`，Android 13+ 的预测性返回由 Capacitor 的 `OnBackPressedCallback` 统一接管。系统备份和设备迁移排除本地会话、缓存与草稿。

## 启动与主题

`MainActivity` 在首帧前按保存的主题设置窗口、DecorView 和 WebView 的背景，夜间、星空主题冷启动不露浅色底；`NoteDevice.setBackground` 在同一次原生更新里保存主题并设置系统栏图标明暗。不要从 JS 调用 `SystemBars.setStyle`，它会把背景改回系统主题色；背景用同一个 `ColorDrawable` 改色，反复替换窗口背景会清除系统栏边距、引起高度抖动。

启动画面保留到界面完成首屏（已登录页、登录页或连接错误）后退出，由 `NoteDevice.finishBoot` 通知，5 秒未收到时也结束首屏等待；应用锁正在等待指纹时，启动画面继续保留到验证结束或切回 PIN。登录过的设备首屏直接用本机缓存的笔记库，不等代理和登录验证（见[本机缓存](offline-reading.md)）。代理由网页在加载完成后启动：在原生 `onCreate` 中提前设置 WebView 代理会让包内资源加载停顿数秒。Android 13+ 的启动画面背景跟随 App 主题，见[应用图标](branding.md)。

## 分享与打开方式

独立的透明 `ShareActivity` 接收文字、Markdown、PDF、图片的 `ACTION_SEND`，PDF 与图片的 `ACTION_SEND_MULTIPLE`，以及 PDF、图片、Markdown 的 `ACTION_VIEW`，浮在发送方应用上，加载单独打包的 `share.html`。后台线程把临时授权的 `content://` 内容复制到应用私有暂存区，网页只通过 `/__share/` 地址读取，不使用外部传入的路径。

窗口按内容显示 arXiv 论文（服务端只向 arXiv 官方 API 读取标题、作者、摘要，可导入全文或只存链接）、网页链接、Markdown、纯文本、PDF（本地读取首页缩略图与页数）、图片和混合文件；`.md`、`.txt` 读入正文而不上传。保存到设置中的默认目录（账号设置，跨设备共用，被删除后回到根目录），每次可临时更改。未登录时可转到页间登录，内容留在暂存区。文字、链接和单张图片也可以「存入随手记」；文字离线同样可用，打开页间时发送，图片需要联网。一次最多 10 个文件、合计 100 MiB，单文件沿用服务端 50 MB 上限，文本最多 1 MiB；未处理内容保留 7 天。

## 快捷入口

长按桌面图标有三个快捷方式，都在当前应用上方打开独立的浮动窗口，不进入页间主界面（今日记与问青藜居中显示，宽度一致；问青藜最大 560×720，今日记最大 560×460）。网页组件冷启动需要片刻，`PageWindowActivity` 先用原生代码画出同样位置、大小和主题配色的卡片（标题与日期），网页画好自己的卡片后调用 `NoteDevice.finishBoot` 换下，5 秒未收到时也换下，所以窗口和随手记一样立即出现：「随手记」是原生输入窗口；「今日记」和「问青藜」由 `JournalWindowActivity`、`AssistantWindowActivity` 加载单独打包的 `window.html`（与分享窗口一样透明、带遮罩，网页通过 `NoteDevice.takeLaunch` 得知显示哪一个）。各窗口使用独立任务，系统启动静态快捷方式时清空的只是窗口自己的任务，已打开的页间不受影响。

- 今日记：标题、正文和输入框右下角的添加照片按钮，与日记本里的「写今天」共用本机草稿，记入「设置 → 保存位置 → 今日记保存到」所选日记本中今天的日记（尚未写时创建）；默认是最近写过的日记本。所选日记本放入回收站后恢复为默认。照片选好即在后台上传，上传期间可继续写字；未传完也可以点「保存」：窗口立即隐藏，照片传完后连同文字一起记入，成功后提示「已记入今日日记」并关闭；失败时提示原因并关闭，内容保留，再次打开可继续。照片在上传前先存入本机（加密日记本按其密钥加密），窗口隐藏后若系统冻结或结束了页间，下次打开今日记会接着上传并自动补记，提示「上次的今日记已记入日记」，窗口保留以便写新的一条。若已跨日，前一天点过保存的记录（`src/quick-journal.ts`）在打开今日记窗口或页间时自动记入写下那天的日记，并在「设置 → 待发送」中可见，可重试或删除；被服务器拒绝时保留原因；加密日记本在本机锁定时只显示日期和「等待解锁」，解锁后再发送。窗口先用本机缓存的登录状态和日记本列表立即显示，同时向服务器确认（之后打开不再等网络；输入期间不会换到另一个日记本）。未登录、没有日记本时可转到页间；离线时可先写下，联网后再保存。加密日记本未在本机解锁时不必输入密码：照常写标题、正文和照片，保存后记录先暂存在本设备（`src/journal-outbox.ts`，用不离开本机的不可导出 WebCrypto 密钥加密，与随手记窗口的 Keystore 待发送区同理；未保存的输入同样暂存），提示「已记下，解锁后自动记入」。之后在页间或今日记窗口解锁该日记本时，自动用日记本密钥加密上传照片，记入写下那天的日记；被服务器拒绝的记录保留原因。窗口里也可点「现在解锁」，解锁后已写内容转入普通输入框继续。退出登录时清除暂存。暂存的记录在「设置 → 待发送」中可见（显示日期、日记本、开头文字、照片数和状态），可去解锁、重试或删除。待发送页由 `src/outbox.ts` 汇总各暂存区；新的暂存区只需实现其中的 `OutboxSource`（列出、监听、重试、删除）并加入 `SOURCES`。
- 问青藜：全局对话显示在屏幕中央，可最大化，点遮罩、关闭按钮或返回键关闭窗口。全局对话的最新一页和青藜设置保存在本机缓存中，打开时先显示上次的对话，服务器的版本随后替换；应用内的全局青藜和离线时也同样可看。打开回复中的笔记、去设置时转到页间主界面对应页面（`MainActivity` 记下页面，网页取走后跳转，运行中由 `note:launch` 事件通知）。文字选择菜单的「存入随手记」（`PROCESS_TEXT`，别名 `ClipProcessText`）也打开随手记窗口，见[随手记](quick-clips.md)。

## 应用锁

「设置 → 密码与设备 → 应用锁」可设置 4 到 6 位数字 PIN（只在本机保存加盐的 PBKDF2 摘要，`AppLock`）。开启后，打开页间主界面（`MainActivity`）时先显示原生锁屏 `AppLockView`，盖住整个网页；随手记、今日记、问青藜和分享窗口不受影响，从浮窗转到页间主界面时同样要解锁。

- 重新上锁：离开页间（切到其他应用或锁屏）超过所选时长（立即、1 分钟、5 分钟、30 分钟，默认 1 分钟）后回来需要解锁；进程被结束后重新打开总要解锁。从页间打开的文件选择、拍照、保存位置等系统窗口回来不算离开，除非超过 5 分钟。
- 指纹：Android 11 及以上、已录入强生物识别时可开启，开启前先验证一次指纹；锁屏出现时自动弹出指纹验证。冷启动时继续用启动画面作为背景，回到应用重新上锁时也使用同一启动主题的背景与居中透明前景。取消验证、选择「使用 PIN」或指纹不可用时，显示 PIN 输入区和数字键盘。
- 输错：连续 5 次错误后需等待 30 秒，此后每次再错等待时间加倍，最长 15 分钟；在设置中修改或关闭时验证当前 PIN 也计入。
- 忘记 PIN：锁屏上确认后，网页尽量通知服务器退出（5 秒内无响应则只在本机退出），清除本机缓存和待发送内容，Android 再删除登录 Cookie、随手记待发送区和应用锁设置，显示登录页。网页 8 秒内没有完成时由 Android 自行清除并重新载入。
- 开启后，Android 13 及以上的最近任务中不显示页间的画面。返回键在锁屏时只把页间退到后台。

## 阅读窗口

打开笔记时，网页通过 `NoteDevice.setWindowState` 设置窗口：屏幕常亮（`FLAG_KEEP_SCREEN_ON`，10 分钟无操作后取消）、加密笔记禁止截屏且最近任务中不显示内容（`FLAG_SECURE`，离开笔记即取消），以及阅读时由 `MainActivity` 拦截音量键并发出 `note:volume-key` 事件。离开笔记时三项全部恢复。选项见[阅读设置](offline-reading.md)。

下载完成、链接无法打开等提示显示在页间自己的提示条中（`note:notice` / `note:toast` 事件），不用系统 Toast；页间界面之外（分享窗口关闭后）仍用 Toast。网页文件选择的相机照片由 Capacitor 写入应用外部私有目录 `Pictures/`，启动时清理一天前的照片。

## 目录与手势

手机使用首页目录树和底部「笔记／收藏／设置」导航，横屏同样适用。目录列表在本次登录内保留在内存中：切换页面直接复用，库内容变化、下拉刷新、回到前台和重新联网时才更新；短时间内的焦点与可见性事件合并，不定时轮询。

目录拖动不用浏览器原生拖放（WebView 无法从触摸启动），由 `src/use-tree-drag.ts` 统一处理指针事件：电脑移动 5px 拿起；手机长按 0.35 秒拿起并轻振（`NoteDevice.haptic`，无需振动权限），长按前移动超过 8px 视为滚动。拖动时显示跟随卡片和放置提示，悬停在收起的目录上 0.6 秒自动展开，靠近边缘自动滚动，`Esc` 取消；放下后可在 6 秒内撤销。「移动到…」弹窗保留作为键盘和无障碍入口。

PDF 双指缩放先变换现有画布，手指离开后再渲染清晰页面；缩放比例按文件保存在本机。

## 构建

- 从 note 根目录运行 `git clone https://github.com/xviapp/proxy-core.git ../proxy-core` 获取同级共享核心；已有目录则跳过。接口和原生依赖说明见[共享代理核心](proxy-core-api.md)。
- JDK 21、Node.js 22.12+、Android SDK Platform 37 / Build Tools 37。构建脚本依次查找 `ANDROID_SDK_ROOT`、`ANDROID_HOME` 和常见 SDK 目录，并写入 Git 忽略的 `android/local.properties`。
- `npm run android:apk`：构建前端、同步 Capacitor、编译调试 APK 并复制到 `artifacts/`。默认只构建 `arm64-v8a`；`node scripts/android.mjs assembleDebug --abi <架构>` 构建 `armeabi-v7a`、`x86_64` 或 `x86`，`--abi all` 生成四种架构包和通用包。
- `pnpm install:android`：选定唯一可用设备（多个时用 `--device <序列号>` 或 `ANDROID_SERIAL`），构建后覆盖安装并保留数据；构建失败不会安装旧包，`--abi` 安装前检查设备兼容性。
- `pnpm build:android:release`：构建、同步包内资源并生成签名正式版 APK 和 R8 mapping，输出到 `artifacts/`，等同于 `pnpm android:release`；支持 `--abi`。
- `pnpm install:android:release`：构建签名正式版并覆盖安装到选定设备，支持相同的 `--device`、`ANDROID_SERIAL` 和 `--abi`。签名配置可放在仓库根目录 `.env`（已被 Git 忽略，环境变量优先），也可直接设置环境变量。
- `npm run build:android` 只构建与同步包内资源；`npm run android:open` 用 Android Studio 打开工程。
- `node scripts/android.mjs testDebugUnitTest`、`lintDebug`：原生单元测试与 Android Lint；`pnpm test:android-cli` 用临时 SDK 验证设备选择与安装顺序。

Android 构建为 PDF.js 主库和 worker 选择 `legacy` 包以兼容 WebView 125+，最低 Android 8.0，旧 WebView 显示本地更新提示页。APK、构建缓存、私钥和复制进原生工程的 Web 资源都不进入 Git。

## 更新、签名与发布

设置显示原生读取的版本、构建号，并用安装证书检查更新兼容性；仅 Android 客户端显示检查更新与下载入口。较新的兼容版本由用户选择保存位置，原生层边下载边写入并核对 SHA-256，再通过系统文件管理器安装。

发布顺序：完成检查和 APK 构建，部署 Worker，最后发布安装包。`android:publish` 用 SDK 工具验证包名、版本和签名并生成版本清单，指定 `--remote` 才上传：先上传不可变 APK，再更新最新版本清单。安装包按构建号与摘要寻址，保存在 R2 的 `releases/android/`，通过登录接口访问，不计入笔记库容量。发布说明放在 `docs/releases/<版本>.txt`。

```bash
pnpm android:apk
node scripts/android.mjs assembleDebug --abi all
pnpm run deploy
pnpm android:publish --apk artifacts/yejian-<版本>-android-debug.apk --notes docs/releases/<版本>.txt --remote
```

每次发布递增 `android/app/build.gradle` 的 `versionCode`。调试包沿用开发机调试签名以便覆盖升级；正式签名用 `pnpm android:release`，需设置 `NOTE_ANDROID_KEYSTORE`（绝对路径）、`NOTE_ANDROID_STORE_PASSWORD`、`NOTE_ANDROID_KEY_ALIAS` 和 `NOTE_ANDROID_KEY_PASSWORD`，缺少即停止。换用其他证书后不能直接覆盖升级，应先整库备份；应用也会阻止证书不同的版本作为普通更新安装。密钥和密码不进入仓库。

## 验证

`e2e/notebook.spec.ts` 的 Android 返回测试覆盖弹窗、最大化、侧栏、页面返回和草稿保护，电脑和手机视口都运行。

原生调试可在隔离模拟器中安装 APK，用 Playwright 的 `_android.devices()` 按序列号选设备，`device.webView({ pkg: 'app.xvi.note' }).page()` 连接 WebView。写入类测试应把 `/api/` 转发到独立本地 Worker，使用测试密码与模拟 AI，不触碰正式笔记或产生模型费用；原生文件下载不经过 Playwright 拦截，需另行验证。

启动闪烁回归需要已安装测试包、WebView 125+ 的 Android 14 模拟器和本机 FFmpeg：

```bash
pnpm test:android-startup --device emulator-5560 --theme dark
pnpm test:android-startup --device emulator-5560 --theme starry
pnpm test:android-startup --device emulator-5560 --theme system
```

脚本拒绝真机，录下 6 秒冷启动，检测夜间 Splash 之后的浅色亮帧和全白/全黑空帧，并确认启动画面退出；录屏和像素数据保存在 `.wrangler/startup-*`。

## 页间快捷栏与随手记窗口

桌面小组件列表中的「页间快捷栏」占 4×1，像桌面图标一样排着「页间」「随手记」「今日记」「问青藜」四个入口，由 `QuickBarWidget` 分别打开主界面（已在运行时回到原处）、随手记窗口、今日记和问青藜浮窗。

快捷栏和长按页间图标的「随手记」快捷方式直接打开原生 `ClipCaptureActivity`，不启动 `MainActivity` 或 WebView；仅提供文字输入、关闭和保存。输入窗口跟随应用的白天、夜间或星空主题。

随手记窗口、今日记和问青藜的原生占位卡片由 `WindowTheme` 绘制，颜色取自 `src/family-tokens.css` 和 `src/themes.css`，卡片和标题栏与网页的 `.share-window-sheet`、`.share-window-header` 一致（问青藜窗口的标题栏见 `src/assistant.css` 的 `.assistant-centered`）。修改这些样式时同步修改 `WindowTheme`，否则网页接替原生卡片时会跳动。

保存先由 `ClipInbox` 使用 Android Keystore 加密并原子写入私有存储，再关闭窗口。`ClipUploadJob` 使用系统网络约束和退避重试，任务可跨重启恢复；使用当前站点登录会话及固定条目标识，成功后删除本机副本。没有登录、需要内容密钥或启用了应用代理时不直接上传，待应用下次打开、恢复连接或解锁时由 `src/widget-clips.ts` 同步。切换站点不会把旧站点的记录发给新站点。
