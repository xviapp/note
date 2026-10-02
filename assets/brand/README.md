# 页间图标来源

0.4.4 使用用户确认的直接拼合版本，保留新版书页，木杖和叶片原样取自旧版。没有重新生成、描摹或改变三条轮廓。

- `mark.json`：统一的矢量源数据。`staff` 与 `leaf` 原样复制自提交 `5fa03c8` 的 `android/app/src/main/res/drawable/ic_launcher_foreground.xml` 第 1、2 条路径；`pages` 原样复制自提交 `6dbe7bf` 同一文件的第 3 条路径。
- 路径坐标单位为原稿像素的十分之一。`staffOffsetX: 940` 让木杖与叶片整体向右平移 94 px，与书页凹口对齐；保持其原始大小、比例和曲线。
- `day-original.png` 与 `night-original.png`：同一组轮廓导出的 1254 px PNG，采用用户确认的暖米白 `#F9F2E7` 与柔和深绿 `#426B55`，日夜对换。沿用原矢量轮廓，不使用生成预览中的重绘轮廓和纹理。
- `../../public/brand/` 与 `../../public/favicon.ico`：通过 `pnpm icons` 缩放打包的网页资源。
- Android 自适应、单色和启动图标：同一脚本直接使用 `mark.json` 中的路径和位移，并从统一配色生成 Android 日夜颜色资源。

运行 `pnpm icons` 更新全部资源，需要 ImageMagick。脚本不再对页间图标进行位图描摹，避免重复转换改变已确认的形状；普通 Web / Android 构建直接使用已生成并提交的文件。
