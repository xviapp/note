export const diagramSvg = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 320 180">
<title>SVG vector chart</title>
<defs>
  <linearGradient id="blue" x1="0" x2="1"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#38bdf8"/></linearGradient>
  <clipPath id="plot-clip"><rect x="20" y="40" width="280" height="120"/></clipPath>
  <path id="point" d="M-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0"/>
</defs>
<style>* {stroke-linejoin:round;stroke-linecap:butt} .plot {fill:url(#blue)} .label {font:16px sans-serif;fill:#183153}</style>
<rect width="320" height="180" fill="white"/>
<text x="20" y="26" class="label">SVG vector chart</text>
<g clip-path="url(#plot-clip)"><path class="plot" d="M20 150L20 110L90 90L160 105L230 50L300 40L300 150Z"/></g>
<path d="M20 40V150H300" fill="none" stroke="#183153" stroke-width="2"/>
<use xlink:href="#point" x="230" y="50" fill="#183153"/>
<text x="20" y="174" class="label">0</text><text x="282" y="174" class="label">10</text>
</svg>`;

export const hostileSvg = diagramSvg
  .replace(
    '</svg>',
    `
<script>window.svgInjected = true</script>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://svg-tracker.invalid/html" onerror="window.svgInjected=true"/></div></foreignObject>
<image href="https://svg-tracker.invalid/pixel" width="1" height="1"/>
<use href="https://svg-tracker.invalid/shapes#point"/>
<a href="javascript:alert(1)"><circle cx="10" cy="10" r="2" onload="alert(1)"/></a>
<animate href="#point" attributeName="href" to="https://svg-tracker.invalid/animation"/>
<style>@import url(https://svg-tracker.invalid/style); .bad {fill:u\\72l(https://svg-tracker.invalid/fill);--bad:url(https://svg-tracker.invalid/var)}</style>
<rect x="0" y="0" width="0" height="0" fill="url(&#104;ttps://svg-tracker.invalid/paint)" style="stroke:url('https://svg-tracker.invalid/stroke');opacity:.5"/>
</svg>`,
  )
  .replace('<svg xmlns=', '<svg onload="window.svgInjected=true" xmlns=');
