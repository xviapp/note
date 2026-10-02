# 应用图标

页间使用用户确认的组合：保留新版书页，木杖与叶片直接取自旧版轮廓，只整体平移对齐。统一源数据位于 `assets/brand/mark.json`，日夜 PNG 与 Android 矢量由它直接生成；来源见[资源记录](../assets/brand/README.md)。站内图标只缩放并加圆角。

## 使用位置

- `src/components/Brand.tsx`：登录、首次设置、加载、侧栏统一使用；白天用 day，夜间和星空用 night。
- `index.html`、`public/theme-init.js`：在应用加载前按保存的主题或系统主题选取 favicon、Apple 桌面图标和安装清单，并随应用主题更新。
- `public/brand/`：64 px favicon、128 px 站内图标、180 px Apple 图标、192 / 512 px 安装图标，以及日夜两份 Web App Manifest。
- `public/favicon.ico`：未读取页面图标配置的客户端使用白天版本兜底，包含 16 / 32 / 48 / 64 px。
- `public/android-webview.html`：旧系统网页组件提示页使用相同标识和主题规则。
- `android/app/src/main/res/`：普通和圆形桌面图标共用自适应前景，单色主题图标复用其轮廓；启动画面也使用同一前景。

Android 原生图标直接复用同一组三条路径及木杖、叶片的位移，使用米白 `#F9F7F3` 与青色 `#155B57`，通过 `values/` 与 `values-night/` 对换前景和背景。前景采用 108 dp 画布，图案保留在中央 66 dp 圆形安全区内，避免不同桌面形状裁掉书页；参见 [Android 自适应图标规范](https://developer.android.google.cn/develop/ui/compose/system/icon_design_adaptive?hl=en)。Android 13+ 的系统主题图标由桌面按壁纸配色着色。

网页与应用内标识跟随页间所选主题。Android 桌面图标和启动画面跟随系统深浅色，桌面的图标缓存刷新时间由系统决定。浏览器添加到主屏幕时使用当前主题的安装图标；已经安装的网页快捷方式是否刷新图标由浏览器及系统决定。

## 青藜图标

`assets/qingli/original.png` 保留用户提供的读书人物原稿，`assets/qingli/mark.svg` 是从原稿直接提取的深色轮廓，`assets/qingli/mark.png` 为透明栅格图形，处理方式见[资源记录](../assets/qingli/README.md)。发布用的 `public/qingli/mark-128.png` 仅缩小尺寸并移除元数据，不重绘图案。

`QingliIcon` 使用透明图形作为 CSS alpha mask，并沿用主题强调色 `--blue`：白天为青绿色，夜间为浅绿色，星空为浅紫色；跟随系统时自动切换。统一用于悬浮按钮、窗口标题、设置标题、空会话，以及选文和翻译里的“问青藜”。图标属于装饰，读屏继续使用按钮和标题上的文字。网页离线缓存与 Android 包内资源均包含图标。

## 更新资源

更新 `assets/brand/mark.json` 或 `assets/qingli/mark.svg` 后，在安装了 ImageMagick 的环境运行：

```bash
npm run icons
```

`scripts/brand-assets.mjs` 生成日夜 PNG、网页 PNG、ICO、安装清单、Android 矢量前景和青藜的透明图标。它直接复用已确认的路径，无需重复描摹。配色资源随图标一起提交；普通 Web / Android 构建直接使用这些文件，无需图像工具。改图标后分别构建、部署网站和重新安装 Android 包。

图标与安装清单包含在离线界面缓存中，PNG / ICO 与字体等静态资源一起打包，减少首次准备离线资源的请求数。

## 验证

0.4.4：日夜 PNG 与用户确认的拼合预览逐字节一致，Android 三条路径与对应原始路径一致，只保留确认过的木杖、叶片整体位移。前景最远点距中心约 28.39 dp，位于 33 dp 安全半径内，圆形、圆角方形和单色矢量预览正常。电脑与手机视口核对 28 处应用标识及六处青藜入口，覆盖白天、夜间、星空和系统切换，无页面异常；青藜 17–64 px 尺寸的透明蒙版正常显示。10 项已有交互回归、3 项离线资源打包检查、Web / Android 构建和 Android Lint 通过。14 个图标及清单文件在源码、网页产物、Android 资源与 APK 中一致；安装包为 0.4.4 / versionCode 13，沿用已有签名。

0.4.3：电脑与手机视口共核对 28 处品牌显示，覆盖首次设置／登录、侧栏、加载页、旧 WebView 提示页及白天、夜间、星空、跟随系统主题；favicon、Apple 图标和安装清单随主题正确切换，无页面异常。新 Android 轮廓最远点距中心约 28.53 dp，位于 33 dp 安全半径内；检查了圆形、圆角方形及单色矢量预览。2 项已有主题回归、3 项离线打包检查、Web / Android 构建和 Android Lint 通过；14 个图标及清单文件在源码、网页产物、Android 资源与 APK 中一致。安装包为 0.4.3 / versionCode 12，沿用已有签名；青藜资源未改动。

0.4.2：在电脑与手机视口逐一检查六处青藜图标，核对白天、夜间、星空及跟随系统切换，未出现页面异常。10 项已有主题、助手窗口、选文和翻译交互回归通过，3 项离线资源打包检查及 Web / Android 构建通过。网页资源、Android 资源和 APK 内的图标内容一致；安装包为 0.4.2 / versionCode 11，沿用已有签名。

0.2.1：Web / Android 构建及 Android Lint 通过。3 项资源打包测试、4 项电脑／手机主题及离线阅读回归通过；另外核对了三种主题、系统切换、刷新、favicon、Apple 图标、安装清单、离线冷启动和旧 WebView 提示页的图标加载。

独立 Android 14 / WebView 128 模拟器核对了包内三种主题及跟随系统、日夜启动图和圆形桌面图标，轮廓无裁切，未出现 JavaScript 异常。Pixel Launcher 切换系统主题时保留了原图标缓存，刷新应用安装后使用对应夜间图标；不假设所有桌面会即时换色。测试包版本为 0.2.1 / versionCode 3，签名与前版一致，可覆盖安装。
