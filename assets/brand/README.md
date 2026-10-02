# 页间图标来源

- `day-original.png`：用户于 2026-10-02 提供的叶片与书页原稿，保留原始尺寸、图案和浅色背景。
- `night-original.png`：内置 `image_gen.imagegen` 根据原稿生成的夜间配色，青色背景、米白图案。
- `../../public/brand/` 与 `../../public/favicon.ico`：通过 `pnpm icons` 缩放打包的网页资源。
- Android 自适应、单色和启动图标：同一脚本从白天原稿提取三个轮廓，使用原生主题颜色。

夜间配色的生成参数：`transparent_background: false`；输入为 `day-original.png`。完整提示如下：

```text
Use case: precise-object-edit
Asset type: dark-theme app icon for 页间.
Input image is the exact light-theme icon to edit.
Create its dark-theme color variant ONLY. Keep the three leaf-and-open-book shapes EXACTLY in their current positions and sizes, with the same silhouettes, proportions, gaps and square canvas. Do not redraw, move, rotate, enlarge, crop or redesign the mark.
Recolor all three dark teal shapes to warm ivory #F9F7F3. Replace all light background areas, including the cream rounded tile and white outside margin, with one seamless deep teal #155B57 background filling the entire square, edge to edge. A barely perceptible paper texture is acceptable. No white outer margin, no additional border, no shadow, no text, no extra objects. Output opaque PNG.
```
