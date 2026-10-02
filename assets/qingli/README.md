# 青藜图标来源

- `original.png`：用户于 2026-10-02 提供的图标原稿。
- `mark.png`：内置 `image_gen.imagegen` 根据原稿提取的透明 PNG，保留叶片与书页构成。
- `../../public/qingli/mark-128.png`：应用使用的 128 px PNG，通过 `pnpm icons` 中的 ImageMagick 缩放步骤生成。
- 显示时以 alpha mask 配合当前主题颜色，深色主题无需单独生成位图。

生成参数：`transparent_background: true`；输入为原稿。完整提示如下：

```text
Use case: background-extraction
Asset type: Qingli assistant brand icon for an existing app.
Input image: exact supplied logo, edit target.
Remove the entire white outer background and cream rounded-square tile. Keep ONLY the three dark teal curved shapes: the detached upper leaf/flame, the tall curved central blade, and the wide sweeping open-book base. Preserve their exact silhouettes, relative placement, spacing, proportions, and the original dark teal color. This is a faithful extraction, not a redesign.
Output a clean square RGBA PNG with genuinely transparent background, no rounded tile, no shadows, no extra text or elements, and no visible white or cream fringes. Center the complete mark as one unit, scaled proportionally to occupy approximately 88% of the image width, with comfortable transparent padding around all edges. Preserve the gap between the upper leaf and central blade and the gap between the central blade and the sweeping base. Smooth antialiased edges and solid opaque interiors, suitable as an alpha mask at small UI sizes.
```
