# 应用图标

原稿保存在 `assets/brand/day-original.png` 和 `assets/brand/night-original.png`，分别为白天的浅底青色图案、夜间的青底白色图案。保留原图纹理与比例，站内图标只缩放并加圆角。

## 使用位置

- `src/components/Brand.tsx`：登录、首次设置、加载、侧栏统一使用；白天用 day，夜间和星空用 night。
- `index.html`、`public/theme-init.js`：在应用加载前按保存的主题或系统主题选取 favicon、Apple 桌面图标和安装清单，并随应用主题更新。
- `public/brand/`：64 px favicon、128 px 站内图标、180 px Apple 图标、192 / 512 px 安装图标，以及日夜两份 Web App Manifest。
- `public/favicon.ico`：未读取页面图标配置的客户端使用白天版本兜底，包含 16 / 32 / 48 / 64 px。
- `public/android-webview.html`：旧系统网页组件提示页使用相同标识和主题规则。
- `android/app/src/main/res/`：普通和圆形桌面图标共用自适应前景，单色主题图标复用其轮廓；启动画面也使用同一前景。

Android 原生图标从原稿提取三个轮廓，使用米白 `#F9F7F3` 与青色 `#155B57`，通过 `values/` 与 `values-night/` 对换前景和背景。前景采用 108 dp 画布，图案保留在中央 66 dp 圆形安全区内，避免不同桌面形状裁掉书页；参见 [Android 自适应图标规范](https://developer.android.google.cn/develop/ui/compose/system/icon_design_adaptive?hl=en)。Android 13+ 的系统主题图标由桌面按壁纸配色着色。

网页与应用内标识跟随页间所选主题。Android 桌面图标和启动画面跟随系统深浅色，桌面的图标缓存刷新时间由系统决定。浏览器添加到主屏幕时使用当前主题的安装图标；已经安装的网页快捷方式是否刷新图标由浏览器及系统决定。

## 更新资源

替换原稿后，在安装了 ImageMagick 和 Potrace 的环境运行：

```bash
npm run icons
```

`scripts/brand-assets.mjs` 生成网页 PNG、ICO、安装清单及 Android 矢量前景。配色资源随图标一起提交；普通 Web / Android 构建直接使用这些文件，无需图像工具。改图标后分别构建、部署网站和重新安装 Android 包。

图标与安装清单包含在离线界面缓存中，PNG / ICO 与字体等静态资源一起打包，减少首次准备离线资源的请求数。

## 验证

0.2.1：Web / Android 构建及 Android Lint 通过。3 项资源打包测试、4 项电脑／手机主题及离线阅读回归通过；另外核对了三种主题、系统切换、刷新、favicon、Apple 图标、安装清单、离线冷启动和旧 WebView 提示页的图标加载。

独立 Android 14 / WebView 128 模拟器核对了包内三种主题及跟随系统、日夜启动图和圆形桌面图标，轮廓无裁切，未出现 JavaScript 异常。Pixel Launcher 切换系统主题时保留了原图标缓存，刷新应用安装后使用对应夜间图标；不假设所有桌面会即时换色。测试包版本为 0.2.1 / versionCode 3，签名与前版一致，可覆盖安装。
