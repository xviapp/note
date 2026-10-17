# 应用品牌与图标

名称「页间」，标语「落笔于页，留心于间」。

## 页间图标

书页、木杖和叶片组成灰青绿剪纸图案（`#526B60`），底色奶油白（`#F8F2E8`）。轮廓源为 `assets/brand/mark.json`，来源见[资源记录](../assets/brand/README.md)。所有主题共用轮廓，不加浮雕、高光或投影。

网页 PNG 和 Android 彩色前景使用同一透明图稿，轮廓从中心放大至 112%。Android 前景和网页加载图案内缩 16%；单色图标由三条矢量路径生成。108 dp 画布中的图案须留在中央 66 dp 圆形安全区内。

启动背景随主题：白天米白、夜间深灰、星空深蓝；深色背景加米白圆底。Android 13+ 记住所选启动主题，更早版本跟随系统深浅色。启动图案在系统画布上移约 23 dp，网页加载区上移 24 px，桌面图标居中。

## 青藜图标

`assets/qingli/original.png` 为确认图稿，`mark.svg` 保存提取的深色轮廓，`mark.png` 为透明栅格图。发布资源 `public/qingli/mark-128.png` 只缩小并移除元数据，不重绘，见[资源记录](../assets/qingli/README.md)。

`QingliIcon` 用图形作 alpha mask，颜色取 `--blue`：白天青绿、夜间浅绿、星空浅紫。按钮和标题提供读屏名称，图标本身为装饰。

## 使用位置

| 资源 | 位置 |
| --- | --- |
| 网页图标与安装清单 | `public/brand/`、`public/favicon.ico` |
| 青藜图标 | `public/qingli/` |
| 登录、加载、侧栏 | `Brand.tsx`、`BootScreen.tsx` |
| Android 图标与启动画面 | `android/app/src/main/res/` |
| 旧 WebView 提示 | `public/android-webview.html` |

网页文件名保留 `day-` 前缀。ICO 包含 16、32、48、64 px；其他尺寸由脚本生成。桌面和浏览器何时刷新已安装图标由系统决定。

## 更新资源

修改矢量源后运行，需要 ImageMagick、Chromium 和项目的 Playwright：

```bash
npm run icons
```

可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器。生成结果与源文件一起提交，日常构建使用已生成的文件。网站和 APK 分别更新，部署网站不会替换已安装图标。

## 验证

- 检查三种主题及跟随系统下的登录、侧栏、加载和旧 WebView 提示页。
- 运行 `npm run test:build`，确认打包资源与源文件一致。
- 检查 Android 圆形、圆角方形、单色图标无裁切，运行 `node scripts/android.mjs lintDebug`。
- 深色冷启动无亮帧，见 [Android 验证](android.md#验证)。
