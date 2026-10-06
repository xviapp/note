# 页间图标来源

当前图标恢复为水墨改动前的书页、木杖与叶片矢量轮廓，只保留暖米白底色。白天、夜间、星空和系统主题均使用同一图标。

- `mark.json`：当前统一矢量源，路径与水墨修改前一致。
- `day-original.png`：1254 × 1254 px，暖米白 `#F9F2E7` 底、柔和深绿 `#426B55` 图案，无水墨笔触或宣纸纹理。
- `../../public/brand/` 与 `../../public/favicon.ico`：通过 `npm run icons` 缩放打包的网页资源。
- Android 自适应、单色主题图标及启动画面：直接使用同一组矢量路径，不再使用水墨位图前景。

运行 `npm run icons` 更新全部资源，需要 ImageMagick。普通 Web / Android 构建直接使用已提交的资源。

水墨原图 `ink-original.png` 和 `previews/ink-soft-original.png`、`previews/ink-fuller-original.png` 仅作历史参考，不参与资源生成。加浓版使用内置 imagegen，提示保存在 `previews/ink-fuller-prompt.txt`。

## 矢量来源

`mark.json` 使用 0.4.4 的直接拼合版本，当前生成脚本直接复用这些路径。

- `mark.json`：统一的矢量源数据。`staff` 与 `leaf` 原样复制自提交 `5fa03c8` 的 `android/app/src/main/res/drawable/ic_launcher_foreground.xml` 第 1、2 条路径；`pages` 原样复制自提交 `6dbe7bf` 同一文件的第 3 条路径。
- 路径坐标单位为原稿像素的十分之一。`staffOffsetX: 940` 让木杖与叶片整体向右平移 94 px，与书页凹口对齐；保持其原始大小、比例和曲线。
