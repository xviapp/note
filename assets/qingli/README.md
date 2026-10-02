# 青藜图标来源

- `original.png`：用户于 2026-10-02 确认的短发带版本，与确认预览逐字节一致。内置 imagegen 以用户提供的长发带原稿为输入，只调整左侧发带；完整提示与输入版本见[生成记录](short-ribbon-prompt.txt)。
- `mark.svg`：从确认图稿提取的 11 条深色轮廓，保留发髻、短发带、头发、五官与书页构成，移除浅色底板。
- `mark.png`：将上述轮廓直接栅格化为透明 PNG；整体等比缩放至 900 px，再居中置于 1024 px 方形画布。
- `../../public/qingli/mark-128.png`：应用使用的 128 px alpha mask，由 `pnpm icons` 生成。

首次从原稿提取轮廓使用 ImageMagick 的灰度 50% 阈值与 Potrace 的 `--opttolerance 0.2`。后续 `pnpm icons` 直接读取已确认的 `mark.svg`，无需重复描摹。SVG 轮廓和 PNG 的颜色只是蒙版内容，应用通过 CSS `currentColor` 统一着色。

白天、夜间、星空分别沿用主题强调色 `--blue`，跟随系统时自动切换。悬浮按钮、窗口标题、设置、空会话、选文和翻译入口共用同一资源。
