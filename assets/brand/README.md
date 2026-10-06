# 页间图标来源

当前图标采用用户确认的水墨版本：书页、木杖与叶片延续原有构图，使用青绿墨色、飞白与淡宣纸底。所有主题只用这一白底版本，不再生成黑底夜间版。

- `ink-original.png`：用户于 2026-10-06 确认替换的 ImageGen 原图，1254 × 1254 px；保留原文件，不重新生成或描摹。
- `day-original.png`：原图移除元数据后的发布源图，像素不变。
- `../../public/brand/` 与 `../../public/favicon.ico`：通过 `npm run icons` 缩放打包的网页资源。
- Android 的 `drawable-nodpi/brand_ink.png`：透明墨迹层，432 px 对应 108 dp，原图缩至中央 66 dp；自适应、单色主题图标及启动画面共用其透明轮廓。

运行 `npm run icons` 更新全部资源，需要 ImageMagick。普通 Web / Android 构建直接使用已提交的资源。

生成方式：内置 imagegen，以上一版白天图标为编辑参考。提示要求保留书页、木杖与单片叶子的构图，采用青绿水墨、粗细变化的笔锋、少量飞白和淡宣纸底，留白充分，不添加文字、印章或其他物件。

## 历史矢量源

`mark.json` 保留 0.4.4 的直接拼合版本作为历史来源，当前生成脚本使用水墨原图。

- `mark.json`：统一的矢量源数据。`staff` 与 `leaf` 原样复制自提交 `5fa03c8` 的 `android/app/src/main/res/drawable/ic_launcher_foreground.xml` 第 1、2 条路径；`pages` 原样复制自提交 `6dbe7bf` 同一文件的第 3 条路径。
- 路径坐标单位为原稿像素的十分之一。`staffOffsetX: 940` 让木杖与叶片整体向右平移 94 px，与书页凹口对齐；保持其原始大小、比例和曲线。
