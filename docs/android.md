# Android 客户端

Capacitor 客户端，应用名称「页间」，包名 `app.xvi.note`。React、编辑确认、PDF 连续阅读、翻译和青藜都共用现有实现。0.2.0 加入字体与排版设置、本机文件缓存和离线阅读，详见[阅读设置与本机缓存](offline-reading.md)。编辑和青藜仍需联网。iOS 工程暂未添加。

## 服务与会话

`capacitor.config.ts` 指定包内资源目录 `dist-android/`，并把本地 WebView origin 设为 `https://note.xvi.app`，没有配置远程 `server.url`。`MainActivity` 使用 Capacitor 的本地资源服务加载界面，只有同源 `/api/` 请求交还 Chromium 走真实 HTTPS 网络。

这是 Android 支持的[本地内容与网站资源同源混用方式](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content#mix-in-app-content-with-resources-from-your-website)。接口保留浏览器的请求体、HttpOnly Cookie、PDF Range 和流式响应；没有启用会缓冲响应的原生 HTTP 替代层，也没有放宽服务端 Origin 校验。客户端与系统浏览器分别保存会话，需要单独登录；服务端「退出所有设备」同时撤销两端的会话。

`OriginPolicy` 限制站内页面和文件下载地址，外部页面只在系统浏览器中打开。下载时通过系统文档选择器选位置，再由原生层流式写入；只有本站的文件接口会携带登录 Cookie，且拒绝跟随重定向。无需全盘存储权限。截图或草稿通过有限大小的 Base64 数据交给原生层。取消保存不会下载文件。

应用后台切换会触发已有阅读进度补写；系统返回键先处理当前浮层、弹窗、菜单、青藜和侧栏，再进入带草稿保护的页面导航，首页返回则最小化应用。系统栏图标跟随当前主题。Android 系统备份和设备迁移排除本地会话、缓存与草稿，正式内容保存在服务端。

更换自建服务需修改 `capacitor.config.ts` 的 `server.hostname` 并重新构建；使用有效 HTTPS 证书及与之对应的 Worker 站点域名。不要改成加载外部网站的 `server.url`，或添加通配的 `allowNavigation`。

## 构建

- JDK 21；Node.js 22.12+；Android SDK Platform 36 / Build Tools 36。
- `npm run android:apk`：构建前端、同步 Capacitor、编译调试 APK，并复制到 `artifacts/`。
- `npm run build:android`：仅构建与同步包内资源。
- `npm run android:open`：在 Android Studio 打开工程。
- `node scripts/android.mjs testDebugUnitTest`：原生地址路由及下载边界测试。
- `node scripts/android.mjs lintDebug`：Android 静态检查。

构建脚本优先使用 `ANDROID_SDK_ROOT`，其次为有效的 `ANDROID_HOME` 和常见 SDK 目录，将本机 SDK 路径写入被 Git 忽略的 `android/local.properties`。APK、构建缓存、私钥及复制进原生工程的 Web 资源都不进入 Git；从新检出运行 `npm ci` 与 `npm run android:apk` 即可重建。

Android 构建为 PDF.js 主库和 worker 同时选择 `legacy` 包，以兼容 WebView 125+；Web 构建保持原来的现代包。兼容范围参考 [PDF.js 浏览器支持](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)。最低 Android 版本为 8.0，旧 WebView 显示本地更新提示页。

`artifacts/yejian-0.2.0-android-debug.apk` 是测试包，使用开发机调试签名，`versionCode` 为 2，可覆盖安装前一测试版。正式分发前使用单独保管的发布密钥，并继续递增 `android/app/build.gradle` 的 `versionCode`。不要提交任何签名密钥或密码。

## 验证

`e2e/notebook.spec.ts` 的 Android 返回测试覆盖弹窗关闭、最大化还原、侧栏收起、页面返回和未保存草稿保护；同一套测试同时运行在电脑和手机视口。已有预览、附件 PDF、图片和青藜窗口测试用于验证共用界面的回归。

原生调试可在隔离模拟器中安装 APK，再使用 Playwright 的 `_android.devices()` 按模拟器序列号选取设备，通过 `device.webView({ pkg: 'app.xvi.note' }).page()` 连接 WebView。测试写入需将 `/api/` 请求全部转发到独立本地 Worker，使用测试密码与模拟 AI，避免触碰正式笔记或产生模型调用费用。原生文件下载不经过 Playwright 网络拦截，应另用本地生成的草稿或截图验证文档选择器和写入。

2026-10-02，0.1.0 验证记录：

- APK 在 Android 14 / WebView 128 模拟器安装、运行成功；旧 WebView 113 显示更新提示。
- 原生环境通过密码初始化与登录、HttpOnly 会话刷新保留、Markdown 编辑与公式预览、PDF 上传与连续阅读、PDF 目录与系统返回操作。
- 通过三种主题及系统栏颜色、软键盘下青藜最大化布局、返回键的草稿保护、系统文档保存与 Markdown 文件名／内容核对。
- 原生地址策略 4 项测试、Worker 69 项测试、电脑／手机共 8 项相关界面测试通过；Android Lint 无错误。测试没有调用真实 DeepSeek。
- 线上只读取公开登录状态及校验部署资源；测试笔记全部写入隔离的本地 Worker。大型文件原生下载及实体手机尚未验收。

0.2.0 在独立 Android 14 / WebView 128 模拟器验证：包内宋体、字号和间距、本机离线保存、断网重开 Markdown 与完整 PDF 第 10 页、离线列表、恢复联网、退出清理，以及系统返回关闭阅读设置和 PDF。未出现 JavaScript 异常；原生 4 项单元测试及 Android Lint 通过。电脑／手机端本次 34 项针对性检查通过，详见[离线阅读验证](offline-reading.md#验证)。

本机模拟器 37.1.11 的 SwiftShader 后端启动时发生 SIGSEGV；在独立测试 AVD 中使用 `-gpu host -feature -Vulkan -no-snapshot` 可正常运行，无需修改应用渲染代码。
