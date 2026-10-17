# 页间图标来源

书页、木杖和叶片三条矢量轮廓，所有主题共用。

- `mark.json`：`staff` 和 `leaf` 取自提交 `5fa03c8` 的 `android/app/src/main/res/drawable/ic_launcher_foreground.xml` 前两条路径，`pages` 取自提交 `6dbe7bf` 的第三条路径。坐标单位为原稿像素的十分之一；`staffOffsetX: 940` 将木杖与叶片右移 94 px，与书页凹口对齐。
- `clay.svg`：按源轮廓生成的纯色矢量图，从中心放大至 112%，文件名沿用旧版。
- `clay-foreground.png`：Chromium 渲染的 1254 × 1254 px 透明前景。
- `day-original.png`：前景叠加 `#F8F2E8` 底色，图案颜色 `#526B60`。
- `public/brand/clay-foreground.png` 与 Android 启动画面共用前景，内缩 16%；其他网页图标使用带底色的缩放版本。
- Android 自适应图标与启动画面使用透明前景，单色图标使用原矢量路径。

运行 `npm run icons` 更新资源，需要 ImageMagick、Chromium 和 Playwright。日常构建使用已提交的产物，详见[品牌资源](../../docs/branding.md)。
