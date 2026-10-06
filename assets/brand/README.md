# 页间图标来源

图标由书页、木杖与叶片三条矢量轮廓组成，暖米白底色，所有主题共用。

- `mark.json`：统一的矢量源数据。`staff` 与 `leaf` 原样复制自提交 `5fa03c8` 的 `android/app/src/main/res/drawable/ic_launcher_foreground.xml` 第 1、2 条路径；`pages` 原样复制自提交 `6dbe7bf` 同一文件的第 3 条路径。路径坐标单位为原稿像素的十分之一，`staffOffsetX: 940` 让木杖与叶片整体向右平移 94 px，与书页凹口对齐，保持原始大小、比例和曲线。
- `day-original.png`：由 `mark.json` 导出的 1254 × 1254 px 源图，暖米白 `#F9F2E7` 底、柔和深绿 `#426B55` 图案。
- `../../public/brand/` 与 `../../public/favicon.ico`：缩放打包的网页资源。
- Android 自适应、单色主题图标及启动画面：直接使用同一组矢量路径。

运行 `npm run icons` 更新全部资源，需要 ImageMagick。普通 Web / Android 构建直接使用已提交的资源。
