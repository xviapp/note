# 应用图标

页间图标由书页、木杖与叶片组成：暖米白 `#F9F2E7` 底色、柔和深绿 `#426B55` 图案。统一矢量源为 `assets/brand/mark.json`，网页 PNG 与 Android 矢量由它生成；来源见[资源记录](../assets/brand/README.md)。白天、夜间、星空和跟随系统主题都使用同一个白底图标，站内图标只缩放并加圆角。

## 使用位置

- `src/components/Brand.tsx`、`BootScreen.tsx`：登录、首次设置、加载页和侧栏。
- `index.html`、`share.html`：favicon、Apple 桌面图标和安装清单。
- `public/brand/`：64 px favicon、128 px 站内图标、180 px Apple 图标、192 / 512 px 安装图标，以及 Web App Manifest（文件名沿用 `day-` 前缀）。
- `public/favicon.ico`：未读取页面图标配置的客户端兜底，包含 16 / 32 / 48 / 64 px。
- `public/android-webview.html`：旧系统网页组件提示页。
- `android/app/src/main/res/`：普通和圆形桌面图标共用自适应前景，单色主题图标与启动画面复用同一轮廓。

Android 前景直接使用 `mark.json` 的三条矢量路径，采用 108 dp 画布，图案保留在中央 66 dp 圆形安全区内，避免不同桌面形状裁掉书页；参见 [Android 自适应图标规范](https://developer.android.google.cn/develop/ui/compose/system/icon_design_adaptive?hl=en)。系统深色模式下桌面图标不变；启动画面背景跟随系统深浅色（`note_surface`），图标放在米白圆底上，深色模式冷启动不出现整屏亮帧。Android 13+ 的系统主题图标由桌面按壁纸配色着色。

桌面图标缓存的刷新时间由系统决定；已安装的网页快捷方式是否刷新图标由浏览器及系统决定。

## 青藜图标

`assets/qingli/original.png` 保存用户确认的短发带读书人物图稿，`assets/qingli/mark.svg` 是从图稿直接提取的深色轮廓，`assets/qingli/mark.png` 为透明栅格图形，处理方式见[资源记录](../assets/qingli/README.md)。发布用的 `public/qingli/mark-128.png` 仅缩小尺寸并移除元数据，不重绘图案。

`QingliIcon` 使用透明图形作为 CSS alpha mask，并沿用主题强调色 `--blue`：白天为青绿色，夜间为浅绿色，星空为浅紫色；跟随系统时自动切换。统一用于悬浮按钮、窗口标题、设置标题、空会话，以及选文和翻译里的“问青藜”。图标属于装饰，读屏继续使用按钮和标题上的文字。网页离线缓存与 Android 包内资源均包含图标。

## 更新资源

更新 `assets/brand/mark.json` 或 `assets/qingli/mark.svg` 后，在安装了 ImageMagick 的环境运行：

```bash
npm run icons
```

`scripts/brand-assets.mjs` 生成网页 PNG、ICO、安装清单、Android 矢量前景、配色资源和青藜的透明图标。生成结果随源文件一起提交；普通 Web / Android 构建直接使用这些文件，无需图像工具。改图标后分别部署网站、重新构建并安装 Android 包；部署网站不会更新手机上已安装的图标。

图标与安装清单包含在离线界面缓存中，PNG / ICO 与字体等静态资源一起打包，减少首次准备离线资源的请求数。

## 验证

改图标后检查：

- 电脑和手机视口的白天、夜间、星空及跟随系统主题下，登录页、侧栏、加载页和旧 WebView 提示页的标识；`e2e/family-style.spec.ts` 覆盖主题回归。
- 网页产物和 APK 内的图标与 `public/brand/` 源文件逐字节一致，`npm run test:build` 检查离线资源打包。
- Android 前景最远点位于 33 dp 安全半径内，圆形、圆角方形和单色图标无裁切；`node scripts/android.mjs lintDebug` 通过。
- 深色模式冷启动无亮帧，可用 [Android 文档](android.md#验证)中的启动回归脚本在模拟器上检查。
