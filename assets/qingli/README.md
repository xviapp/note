# 青藜图标来源

- `original.png`：用户于 2026-10-02 提供的读书人物图标原稿，完整保留。
- `mark.svg`：从原稿提取的 11 条深色轮廓，保留发髻、飘带、头发、五官与书页构成，移除浅色底板。没有使用图像生成或重画人物。
- `mark.png`：将上述轮廓直接栅格化为透明 PNG；整体等比缩放至 900 px，再居中置于 1024 px 方形画布。
- `../../public/qingli/mark-128.png`：应用使用的 128 px alpha mask，由 `pnpm icons` 生成。

首次从原稿提取轮廓使用 ImageMagick 的灰度 50% 阈值与 Potrace 的 `--opttolerance 0.2`。后续 `pnpm icons` 直接读取已确认的 `mark.svg`，无需重复描摹。SVG 轮廓和 PNG 的颜色只是蒙版内容，应用通过 CSS `currentColor` 统一着色。

白天、夜间、星空分别沿用主题强调色 `--blue`，跟随系统时自动切换。悬浮按钮、窗口标题、设置、空会话、选文和翻译入口共用同一资源。
