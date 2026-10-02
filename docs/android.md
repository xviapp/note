# Android 客户端

Capacitor 客户端，应用名称「页间」，包名 `app.xvi.note`。React、编辑确认、PDF 连续阅读、翻译和青藜都共用现有实现。0.2.0 加入字体与排版设置、本机文件缓存和离线阅读，详见[阅读设置与本机缓存](offline-reading.md)。编辑和青藜仍需联网。iOS 工程暂未添加。

## 服务与会话

`capacitor.config.ts` 指定包内资源目录 `dist-android/`，并把本地 WebView origin 设为 `https://note.xvi.app`，没有配置远程 `server.url`。`MainActivity` 使用 Capacitor 的本地资源服务加载界面，只有同源 `/api/` 请求交还 Chromium 走真实 HTTPS 网络。

这是 Android 支持的[本地内容与网站资源同源混用方式](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content#mix-in-app-content-with-resources-from-your-website)。接口保留浏览器的请求体、HttpOnly Cookie、PDF Range 和流式响应；没有启用会缓冲响应的原生 HTTP 替代层，也没有放宽服务端 Origin 校验。客户端与系统浏览器分别保存会话，需要单独登录；服务端「退出所有设备」同时撤销两端的会话。

`OriginPolicy` 限制站内页面和文件下载地址，外部页面只在系统浏览器中打开。下载时通过系统文档选择器选位置，再由原生层流式写入；只有本站的文件接口会携带登录 Cookie，且拒绝跟随重定向。无需全盘存储权限。截图或草稿通过有限大小的 Base64 数据交给原生层。取消保存不会下载文件。

应用后台切换会触发已有阅读进度补写；系统返回键先处理当前浮层、弹窗、菜单、青藜和侧栏，再进入带草稿保护的页面导航，首页返回则最小化应用。系统栏图标跟随当前主题。Android 系统备份和设备迁移排除本地会话、缓存与草稿，正式内容保存在服务端。

0.2.2 起，`MainActivity` 在首帧前设置窗口、DecorView 和 WebView 的主题背景，避免 Splash 退出时露出浅色底。`NoteDevice.setBackground` 同步保存主题选项；手动选择白天、夜间或星空时下次启动直接采用对应颜色，跟随系统时重新读取系统资源，避免应用关闭期间的系统主题变化留下旧颜色。原生背景色与 `src/themes.css` 保持一致，不依赖网络请求完成。

0.2.3 复用启动时创建的 `ColorDrawable`，后续只更新颜色。反复调用 `Window.setBackgroundDrawable` 会短暂清除 DecorView 的系统栏边距，引发 WebView 高度变化；原先的 `resize` 主题同步又重复替换背景，形成上下抖动。主题同步现在只响应实际主题选项变化和应用回到前台，保持正常键盘缩放与屏幕旋转。

0.2.4 将系统栏背景与图标明暗合并到 `NoteDevice.setBackground` 的同一次原生更新。`SystemBars.setStyle` 会把 DecorView 背景改回 Android 系统主题色，因此不再从 JS 单独调用它；SystemBars 继续负责系统栏和键盘边距。配置变化后，`MainActivity` 在插件回调结束时按保存的主题重新设置颜色与对比度，避免白天主题配系统深色时出现深色底上的深色时间、电量图标。

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

`artifacts/yejian-0.2.4-android-debug.apk` 是测试包，使用开发机调试签名，`versionCode` 为 6，可覆盖安装前一测试版。正式分发前使用单独保管的发布密钥，并继续递增 `android/app/build.gradle` 的 `versionCode`。不要提交任何签名密钥或密码。

0.2.1 更新应用图标，包含普通、圆形、自适应和单色主题图标，以及启动画面和旧 WebView 提示页。应用内标识按所选主题切换，桌面图标及启动画面使用系统深浅色资源，详见[应用图标](branding.md)。

## 验证

`e2e/notebook.spec.ts` 的 Android 返回测试覆盖弹窗关闭、最大化还原、侧栏收起、页面返回和未保存草稿保护；同一套测试同时运行在电脑和手机视口。已有预览、附件 PDF、图片和青藜窗口测试用于验证共用界面的回归。

原生调试可在隔离模拟器中安装 APK，再使用 Playwright 的 `_android.devices()` 按模拟器序列号选取设备，通过 `device.webView({ pkg: 'app.xvi.note' }).page()` 连接 WebView。测试写入需将 `/api/` 请求全部转发到独立本地 Worker，使用测试密码与模拟 AI，避免触碰正式笔记或产生模型调用费用。原生文件下载不经过 Playwright 网络拦截，应另用本地生成的草稿或截图验证文档选择器和写入。

启动闪烁回归使用已安装测试包、WebView 125+ 的临时 Android 14 模拟器，并需要本机 FFmpeg：

```bash
pnpm test:android-startup --device emulator-5560 --theme dark
pnpm test:android-startup --device emulator-5560 --theme starry
pnpm test:android-startup --device emulator-5560 --theme system
```

脚本拒绝真机，使用模拟登录状态设置本机主题，然后关闭进程并录下 6 秒冷启动。检测夜间 Splash 之后的浅色亮帧、全白或全黑空帧，同时确认启动画面确实退出；录屏和像素数据保存在 `.wrangler/startup-*`。检测范围排除居中的标识，保留 Android Splash 圆形退出动画中被染浅的背景区域。0.2.1 在同一环境出现了 3–5 个亮帧（约 50–80 ms）；只把固定的浅色 WebView 背景改成深色，对照试验即消除亮帧，正式实现按保存的主题选择背景。

0.2.2 在 Android 14 / WebView 128 模拟器通过夜间、星空及跟随系统的冷启动录屏检查，亮帧和空白帧均为 0；应用关闭期间由系统深色切换到浅色、升级后尚无原生主题记录的场景也通过。4 项原生单元测试、Android Lint 及 APK 构建通过，签名与旧包一致。回归脚本未在实体手机上执行。

初始化位置回归：

```bash
pnpm test:android-layout --device emulator-5560 --theme dark
pnpm test:android-layout --device emulator-5560 --theme dark --interaction
```

同样只允许临时模拟器，支持 `light`、`dark`、`starry`、`system`。脚本延迟模拟的认证响应，逐帧记录加载标志的位置和视口高度，重复三次并包含后台返回；JSON 保存在 `.wrangler/layout-*`。0.2.2 的三次均失败（标志上下位移约 38 CSS px，视口高度相差 76 px）；只修改原生窗口背景复用后，同一测试三次位移均为 0。测试不会提交密码或写入正式笔记。

`--interaction` 使用模拟登录状态和空笔记库，重复打开真实的新建节点弹窗、唤起/关闭软键盘，并检查目录按钮仍可使用。除网页内部位置外，还从 Android 的原生视图树和 InsetsState 读取 WebView、状态栏、导航栏和键盘的实际边界，避免网页内部坐标正常却压住系统栏的漏测；保存完整原生截图和 JSON。该模式需要 FFmpeg，另核对状态栏背景像素与当前应用主题色一致。不使用等待界面静止的 UIAutomator dump，因为旧版持续抖动会让它超时。

边界检查在 0.2.2 复现菜单与时间、电量重叠，以及键盘遮住标题输入框、弹窗上下位移约 194 CSS px；同一台 Android 14 / WebView 128 模拟器安装原有的 0.2.3 APK 后，四种主题共 12 次边界检查均通过。WebView 顶边保持在系统状态栏下方，键盘出现时底边停在键盘上方，弹窗稳定后的位移为 0。随后新增的背景像素检查在 0.2.3 的白天主题/系统深色组合下失败：状态栏为 `#202824`，预期为 `#fcfdfb`；单独调用 `NoteDevice.setBackground` 恢复浅色，随后调用 `SystemBars.setStyle` 又变回深色，确认了第二处覆盖。

0.2.4 通过四种主题共 12 次新建节点/键盘/系统栏边界与背景像素检查，弹窗稳定后位移均为 0；四种应用主题与系统深浅色的八种组合，以及白天主题的横竖屏切换均保持正确状态栏背景和图标对比度。夜间、星空、跟随系统的冷启动无亮帧或空白帧；4 项原生单元测试、Android Lint 及构建通过。冷启动脚本在切换主题后等待 WebView 将 localStorage 写入磁盘，再强制关闭进程，避免把上一主题误当作本次冷启动结果。签名与前版一致；验证仍在独立模拟器进行。

0.2.3 在 Android 14 / WebView 128 模拟器完成四种主题共 12 次位置检查，位移均为 0。夜间、星空、跟随系统的冷启动录屏没有亮帧或空白帧；夜间冷启动的 179 个加载标志采样帧位置一致。键盘弹出/收起、切换主题、横竖屏切换正常，未出现 JavaScript 异常；4 项原生单元测试、Android Lint 和构建通过。APK 签名与前版一致；未操作实体手机。

2026-10-02，0.1.0 验证记录：

- APK 在 Android 14 / WebView 128 模拟器安装、运行成功；旧 WebView 113 显示更新提示。
- 原生环境通过密码初始化与登录、HttpOnly 会话刷新保留、Markdown 编辑与公式预览、PDF 上传与连续阅读、PDF 目录与系统返回操作。
- 通过三种主题及系统栏颜色、软键盘下青藜最大化布局、返回键的草稿保护、系统文档保存与 Markdown 文件名／内容核对。
- 原生地址策略 4 项测试、Worker 69 项测试、电脑／手机共 8 项相关界面测试通过；Android Lint 无错误。测试没有调用真实 DeepSeek。
- 线上只读取公开登录状态及校验部署资源；测试笔记全部写入隔离的本地 Worker。大型文件原生下载及实体手机尚未验收。

  0.2.0 在独立 Android 14 / WebView 128 模拟器验证：包内宋体、字号和间距、本机离线保存、断网重开 Markdown 与完整 PDF 第 10 页、离线列表、恢复联网、退出清理，以及系统返回关闭阅读设置和 PDF。未出现 JavaScript 异常；原生 4 项单元测试及 Android Lint 通过。电脑／手机端本次 34 项针对性检查通过，详见[离线阅读验证](offline-reading.md#验证)。

  0.2.1 在同版本独立模拟器核对了新图标、三种应用主题、系统主题变化、日夜启动图和圆形桌面图标，无轮廓裁切或 JavaScript 异常。Android Lint 通过；桌面图标缓存的实际行为见[图标验证](branding.md#验证)。

本机模拟器 37.1.11 的 SwiftShader 后端启动时发生 SIGSEGV；在独立测试 AVD 中使用 `-gpu host -feature -Vulkan -no-snapshot` 可正常运行，无需修改应用渲染代码。
