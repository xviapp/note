# 页间图标来源

图标由书页、木杖与叶片三条矢量轮廓组成，奶油白底色与灰青绿扁平剪纸风格，所有主题共用。

- `mark.json`：统一的矢量源数据。`staff` 与 `leaf` 原样复制自提交 `5fa03c8` 的 `android/app/src/main/res/drawable/ic_launcher_foreground.xml` 第 1、2 条路径；`pages` 原样复制自提交 `6dbe7bf` 同一文件的第 3 条路径。路径坐标单位为原稿像素的十分之一，`staffOffsetX: 940` 让木杖与叶片整体向右平移 94 px，与书页凹口对齐，保持原始大小、比例和曲线。
- `clay.svg`：由 `mark.json` 生成的扁平矢量图，使用纯色填充，保持原有轮廓并以画布中心放大至 112%；文件名沿用旧版。
- `clay-foreground.png`：Chromium 渲染的 1254 × 1254 px 透明前景；无 AI 重绘。
- `day-original.png`：透明前景叠加奶油白 `#F8F2E8` 底，图案主色为灰青绿 `#526B60`。
- `../../public/brand/clay-foreground.png`：与 Android 启动画面相同的透明前景，WebView 加载页按相同的 16% 内缩显示；其余 `public/brand/` 与 `public/favicon.ico` 为带底色的缩放网页资源。
- Android 自适应及启动画面使用透明扁平前景；单色主题图标直接使用原有三条矢量路径。

运行 `npm run icons` 更新全部资源，需要 ImageMagick、Chromium 与项目已有的 Playwright（可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器）。普通 Web / Android 构建直接使用已提交的资源。
