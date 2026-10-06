# Android 客户端

Capacitor 客户端，应用名称「页间」，包名 `app.xvi.note`。React、编辑确认、PDF 连续阅读、翻译和青藜都共用现有实现。0.2.0 加入字体与排版设置、本机文件缓存和离线阅读，详见[阅读设置与本机缓存](offline-reading.md)。编辑和青藜仍需联网。iOS 工程暂未添加。

## 服务与会话

`capacitor.config.ts` 指定包内资源目录 `dist-android/`，并把本地 WebView origin 设为 `https://note.xvi.app`，没有配置远程 `server.url`。`MainActivity` 使用 Capacitor 的本地资源服务加载界面，只有同源 `/api/` 请求交还 Chromium 走真实 HTTPS 网络。

这是 Android 支持的[本地内容与网站资源同源混用方式](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content#mix-in-app-content-with-resources-from-your-website)。接口保留浏览器的请求体、HttpOnly Cookie、PDF Range 和流式响应；没有启用会缓冲响应的原生 HTTP 替代层，也没有放宽服务端 Origin 校验。客户端与系统浏览器分别保存会话，需要单独登录；服务端「退出所有设备」同时撤销两端的会话。

`OriginPolicy` 限制站内页面和文件下载地址，外部页面只在系统浏览器中打开。下载时通过系统文档选择器选位置，再由原生层流式写入；只有本站的文件接口会携带登录 Cookie，且拒绝跟随重定向。无需全盘存储权限。截图或草稿通过有限大小的 Base64 数据交给原生层。取消保存不会下载文件。

应用后台切换会触发已有阅读进度补写；系统返回键先处理当前浮层、弹窗、菜单、青藜，再进入带草稿保护的页面导航，首页返回则最小化应用。系统栏图标跟随当前主题。Android 系统备份和设备迁移排除本地会话、缓存与草稿，正式内容保存在服务端。

0.2.2 起，`MainActivity` 在首帧前设置窗口、DecorView 和 WebView 的主题背景，避免 Splash 退出时露出浅色底。`NoteDevice.setBackground` 同步保存主题选项；手动选择白天、夜间或星空时下次启动直接采用对应颜色，跟随系统时重新读取系统资源，避免应用关闭期间的系统主题变化留下旧颜色。原生背景色与 `src/themes.css` 保持一致，不依赖网络请求完成。

0.2.3 复用启动时创建的 `ColorDrawable`，后续只更新颜色。反复调用 `Window.setBackgroundDrawable` 会短暂清除 DecorView 的系统栏边距，引发 WebView 高度变化；原先的 `resize` 主题同步又重复替换背景，形成上下抖动。主题同步现在只响应实际主题选项变化和应用回到前台，保持正常键盘缩放与屏幕旋转。

0.2.4 将系统栏背景与图标明暗合并到 `NoteDevice.setBackground` 的同一次原生更新。`SystemBars.setStyle` 会把 DecorView 背景改回 Android 系统主题色，因此不再从 JS 单独调用它；SystemBars 继续负责系统栏和键盘边距。配置变化后，`MainActivity` 在插件回调结束时按保存的主题重新设置颜色与对比度，避免白天主题配系统深色时出现深色底上的深色时间、电量图标。

启动画面保留到界面完成首屏（已登录页、登录页或连接错误）后才退出，标识不再先换成网页加载页的小图标；界面由 `NoteDevice.finishBoot` 通知原生层，5 秒内未收到通知时也会退出，此时显示网页自身的加载页。

更换自建服务需修改 `capacitor.config.ts` 的 `server.hostname` 并重新构建；使用有效 HTTPS 证书及与之对应的 Worker 站点域名。不要改成加载外部网站的 `server.url`，或添加通配的 `allowNavigation`。

## 构建

- JDK 21；Node.js 22.12+；Android SDK Platform 36 / Build Tools 36。
- `npm run android:apk`：构建前端、同步 Capacitor、编译调试 APK，并复制到 `artifacts/`。
- `pnpm install:android`：先选定唯一可用设备，再完成上述构建并覆盖安装，保留应用数据；支持 `--device <序列号>` 或 `ANDROID_SERIAL` 指定目标。连接多个可用设备时必须指定，离线或未授权设备会报错，构建失败不会安装旧包。
- `npm run build:android`：仅构建与同步包内资源。
- `npm run android:open`：在 Android Studio 打开工程。
- `node scripts/android.mjs testDebugUnitTest`：原生地址路由及下载边界测试。
- `node scripts/android.mjs lintDebug`：Android 静态检查。
- `pnpm test:android-cli`：用临时 SDK 和构建工具验证设备选择、安装顺序及失败时停止，不连接真实设备。

构建脚本优先使用 `ANDROID_SDK_ROOT`，其次为有效的 `ANDROID_HOME` 和常见 SDK 目录，将本机 SDK 路径写入被 Git 忽略的 `android/local.properties`。APK、构建缓存、私钥及复制进原生工程的 Web 资源都不进入 Git；从新检出运行 `npm ci` 与 `npm run android:apk` 即可重建。

Android 构建为 PDF.js 主库和 worker 同时选择 `legacy` 包，以兼容 WebView 125+；Web 构建保持原来的现代包。兼容范围参考 [PDF.js 浏览器支持](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)。最低 Android 版本为 8.0，旧 WebView 显示本地更新提示页。

`artifacts/yejian-0.4.21-android-debug.apk` 是测试包，使用开发机调试签名，`versionCode` 为 30，可覆盖安装前一测试版。正式分发前使用单独保管的发布密钥，并继续递增 `android/app/build.gradle` 的 `versionCode`。不要提交任何签名密钥或密码。

桌面图标、单色主题图标和启动画面的来源与规则见[应用图标](branding.md)。

## 更新、发布与分享

设置显示原生读取的版本和构建号，并使用安装证书检查更新兼容性。检查更新读取登录保护的 `/api/app/android-release`；较新的兼容版本可以选择保存位置，原生层边下载边写入，并核对 SHA-256。保存后通过系统文件管理器打开 APK 安装。检查 Android 更新与下载入口仅在 Android 客户端显示；网页版只显示网页版本。旧客户端需要先手动安装 0.3.0，之后即可使用此入口。

发布流程：先完成检查和 APK 构建，再部署 Worker，最后发布安装包。`android:publish` 使用 SDK 工具验证包名、版本和签名，生成版本清单；指定 `--remote` 才会上传。先上传不可变 APK，再更新最新版本清单，避免出现有版本信息但下载不到安装包的状态。

```bash
pnpm android:apk
pnpm run deploy
pnpm android:publish --apk artifacts/yejian-0.4.21-android-debug.apk --notes docs/releases/0.4.21.txt --remote
```

安装包保存在 R2 的 `releases/android/` 中，通过登录接口访问，GitHub 仓库保持私有。发行文件不计入应用的笔记库容量统计，但使用同一 Cloudflare 账号的 R2 存储额度。历史安装包采用构建号与摘要寻址，不被新发布覆盖。

当前调试包继续沿用已有签名，支持覆盖升级。正式签名构建使用 `pnpm android:release`，需要在部署环境中设置 `NOTE_ANDROID_KEYSTORE`（绝对路径）、`NOTE_ANDROID_STORE_PASSWORD`、`NOTE_ANDROID_KEY_ALIAS` 和 `NOTE_ANDROID_KEY_PASSWORD`；缺少配置即停止，不生成未签名的分发包。密钥及密码不进入仓库。改用另一证书时，当前测试版不能直接覆盖升级，应先完成整库备份并迁移；应用也会阻止把证书不同的版本当作普通覆盖更新。

分享与「打开方式」由独立的 `ShareActivity` 接收：文字、Markdown、PDF、图片的 `ACTION_SEND`，PDF 与图片的 `ACTION_SEND_MULTIPLE`，以及 PDF、图片、Markdown 的 `ACTION_VIEW`。透明窗口浮在发送方应用上，加载单独打包的 `share.html`，不加载完整笔记界面。收到文件后，在后台线程读取获得临时授权的 `content://` URI，复制到应用私有暂存区，网页只通过 `/__share/` 地址读取，不使用外部传入的路径。

窗口按内容分为 arXiv 论文（服务端仅向 arXiv 官方 API 读取标题、作者、摘要，可选导入全文或只存链接）、网页链接、Markdown、纯文本、PDF（本地读取首页缩略图与页数）、图片和混合文件；`.md`、`.txt` 文件读入正文而不上传。登录后使用设置中的默认目录，仍可临时更改；默认目录属于账号设置，跨设备共用，删除该目录或其上级后自动回到根目录。保存后弹出提示并回到原应用；取消或返回键丢弃暂存内容。未登录时可转到页间登录，内容留在暂存区，由笔记界面的导入窗口继续。`MainActivity` 不再注册分享入口，只在旧任务仍投递分享时沿用该导入窗口。

一次最多 10 个文件、总计 100 MiB，单文件沿用服务端的 50 MB 上限，文本文件与分享文字最多 1 MiB；未处理内容保留最多 7 天，不会请求全盘存储权限。

PDF 缩放时先变换现有画布，手指离开后再渲染清晰页面，并保留手指所在位置。单指滚动与长按选字继续可用；双击恢复适应宽度。缩放比例按文件保存在本机，退出登录时随私人阅读状态清理。

## 目录刷新

Android 使用首页树形目录和底部「笔记／收藏／设置」导航，不再显示侧边栏或菜单按钮，横屏同样适用。首页保留最近访问、离线阅读、回收站和新建；笔记、收藏页在顶部下拉刷新，取消目录刷新按钮；目录支持多层展开、分页和文件管理。返回首页恢复展开状态、已加载页数和滚动位置。0.4.7 起切换页面直接复用本次登录已加载的目录，不再重新请求；库内容变化、下拉刷新、前台恢复和联网刷新时才更新，「最近访问」进入时后台更新。浏览器版保留侧边栏。

0.4.1 修复两个刷新缺口：手机侧栏一直挂载，重新打开时原先不会重新请求；原生 `appStateChange` 转发的 `focus` 原先只检查会话，没有通知目录更新。现在重开侧栏会刷新目录，回到前台或网络恢复则在会话检查成功后刷新；短时间内的焦点与可见性事件合并，不做定时轮询。本机创建、重命名、移动、删除、分享导入与备份恢复继续立即通知目录。

浏览器侧栏“我的笔记”右侧的刷新按钮固定在目录滚动区顶部，点击会重新检查连接并更新已展开的目录与当前列表；按钮在加载中旋转并暂时禁用。离线或请求失败时保留已有内容，显示状态并允许重试。`useNodeListing` 按已加载页数重新取数，保留展开结构，忽略过期请求的界面更新；目录刷新不重新加载当前正文，也不离开编辑模式。

## 移动笔记

目录树的移动不使用浏览器原生拖放：Android WebView 无法从触摸启动原生拖动，浏览器生成的拖动残影也无法定制样式。`src/use-tree-drag.ts` 用指针事件统一处理鼠标与触摸。电脑按住移动超过 5px 即拿起；手机长按 0.35 秒拿起并轻振一次（原生 `NoteDevice.haptic`，无需振动权限），长按前移动超过 8px 视为普通滚动，不影响下拉刷新。

拖动时显示跟随指针的标题卡片，原位置留虚线占位。可放入的位置显示左侧色条与描边，自身、自身的下级、当前所在位置不可放入，鼠标显示禁止图标。目录顶部「我的笔记」在可移到根目录时变为「移到根目录」放置区。悬停在收起的目录上 0.6 秒自动展开，靠近滚动区上下边缘自动滚动，`Esc` 取消。

放下后目标目录自动展开，移入的笔记短暂高亮并滚动到可见处，底部提示「已移到…」并可在 6 秒内撤销。「移动到…」弹窗保留作为键盘和无障碍入口，完成后同样显示落点和撤销。

## 全局青藜

首页、收藏、设置等页面提供全局青藜悬浮入口，文件对话内可切换到全局对话。全局记录独立保存，使用同一套 DeepSeek 配置，支持附件和保存回复为根目录笔记；阅读文件时可主动附上当前文件。文件会话及草稿保留。备份包含全局记录，恢复时放入恢复目录中的「青藜全局对话（恢复）」笔记，不覆盖当前全局会话。

## 整库备份与恢复

设置提供 ZIP 导出、清单预览和恢复。备份包含当前笔记、文件夹的 Emoji／图片图标、回收站内容、附件、保留的历史版本、收藏、阅读位置、青藜对话及其附件、翻译与原文锚点；不包含登录密码、会话、AI 密钥和本机缓存。恢复会创建「备份恢复 日期」目录，原回收站内容进入其下的「原回收站」目录，当前资料与账号设置保留。恢复文件占用正常的笔记库容量。

服务端在一个 D1 事务中读取清单并保留相关文件引用，防止导出过程中其他操作或定时清理移除附件。ZIP 在客户端按文件生成，支持 Zip64。Android 通过 `NoteArchive` 向用户选择的文档逐块写入；桌面支持 File System Access API 的浏览器使用流式写入。其他浏览器采用内存下载，超过 256 MiB 时提示改用 Android 或桌面 Chrome；这项限制不作用于 Android 的流式导出。

恢复检查 ZIP 文件路径、重复项、CRC、文件大小、目录循环和引用完整性，逐个上传文件，最后在 D1 事务中一次性写入目录和记录。文件、版本、节点等使用新的 ID，正文链接和翻译锚点同步映射。重复提交相同恢复任务返回已有结果。上传中断时不会产生半棵目录；重试可复用已完成的上传，放弃的暂存文件随后清理。备份任务最长保留 24 小时；清单上限 16 MiB，二进制文件不计入清单大小。

清单分块和批量插入按 UTF-8 字节数打包，每个绑定值不超过 1.5 MB；恢复事务最多 40 条语句，为认证和任务检查留出空间，适配 [D1 免费方案的单次 50 查询及单值 2 MB 限制](https://developers.cloudflare.com/d1/platform/limits/)。超过单次恢复边界时返回错误，当前资料保持完整。

## 验证

`e2e/notebook.spec.ts` 的 Android 返回测试覆盖弹窗关闭、最大化还原、侧栏收起、页面返回和未保存草稿保护；同一套测试同时运行在电脑和手机视口。已有预览、附件 PDF、图片和青藜窗口测试用于验证共用界面的回归。

原生调试可在隔离模拟器中安装 APK，再使用 Playwright 的 `_android.devices()` 按模拟器序列号选取设备，通过 `device.webView({ pkg: 'app.xvi.note' }).page()` 连接 WebView。测试写入需将 `/api/` 请求全部转发到独立本地 Worker，使用测试密码与模拟 AI，避免触碰正式笔记或产生模型调用费用。原生文件下载不经过 Playwright 网络拦截，应另用本地生成的草稿或截图验证文档选择器和写入。

启动闪烁回归使用已安装测试包、WebView 125+ 的临时 Android 14 模拟器，并需要本机 FFmpeg：

```bash
pnpm test:android-startup --device emulator-5560 --theme dark
pnpm test:android-startup --device emulator-5560 --theme starry
pnpm test:android-startup --device emulator-5560 --theme system
```

脚本拒绝真机，使用模拟登录状态设置本机主题，然后关闭进程并录下 6 秒冷启动。检测夜间 Splash 之后的浅色亮帧、全白或全黑空帧，同时确认启动画面确实退出；录屏和像素数据保存在 `.wrangler/startup-*`。检测范围排除居中的标识，保留 Android Splash 圆形退出动画中被染浅的背景区域。

初始化位置回归：

```bash
pnpm test:android-layout --device emulator-5560 --theme dark
pnpm test:android-layout --device emulator-5560 --theme dark --interaction
```

同样只允许临时模拟器，支持 `light`、`dark`、`starry`、`system`。脚本延迟模拟的认证响应，逐帧记录加载标志的位置和视口高度，重复三次并包含后台返回；JSON 保存在 `.wrangler/layout-*`。测试不会提交密码或写入正式笔记。

`--interaction` 使用模拟登录状态和空笔记库，重复打开真实的新建节点弹窗、唤起/关闭软键盘，并检查目录按钮仍可使用。除网页内部位置外，还从 Android 的原生视图树和 InsetsState 读取 WebView、状态栏、导航栏和键盘的实际边界，避免网页内部坐标正常却压住系统栏的漏测；保存完整原生截图和 JSON。该模式需要 FFmpeg，另核对状态栏背景像素与当前应用主题色一致。不使用等待界面静止的 UIAutomator dump，因为旧版持续抖动会让它超时。

本机模拟器 37.1.11 无界面启动（`-no-window`）或使用 SwiftShader 后端时会发生 SIGSEGV；在独立测试 AVD 中使用 `-gpu host -feature -Vulkan -no-snapshot` 可正常运行，无需修改应用渲染代码。分享窗口也可在已登录的真机上用 `adb shell am start -n app.xvi.note/.ShareActivity -a android.intent.action.SEND …` 打开检查，取消即丢弃暂存内容，不写入笔记。
