# 青藜图标来源

- `original.png`：ImageGen 基于长发带原稿修改的短发带图稿，提示与输入版本见[生成记录](short-ribbon-prompt.txt)。
- `mark.svg`：提取的 11 条深色轮廓，保留人物与书页，移除浅色底板。
- `mark.png`：轮廓缩放至 900 px，居中放在 1024 px 透明画布。
- `public/qingli/mark-128.png`：应用使用的 128 px alpha mask，由 `npm run icons` 生成。

首次提取使用 ImageMagick 灰度 50% 阈值和 Potrace `--opttolerance 0.2`。后续生成直接读取 `mark.svg`，不重新描摹。应用以主题强调色 `--blue` 着色，见[品牌资源](../../docs/branding.md)。
