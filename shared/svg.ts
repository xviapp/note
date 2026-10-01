import { SaxesParser } from 'saxes';
import parse from 'css-tree/parser';
import generate from 'css-tree/generator';
import walk from 'css-tree/walker';
import type { CssNode } from 'css-tree';

export const SVG_MIME = 'image/svg+xml';
export const SVG_LIMIT = 10 * 1_048_576;
const NS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';
const XML = 'http://www.w3.org/XML/1998/namespace';
const names = (value: string) => new Set(value.split(/\s+/));
const elements = names(`svg g defs symbol use path rect circle ellipse line polyline polygon
  text tspan textPath title desc style clipPath mask linearGradient radialGradient stop pattern
  marker image switch a filter feBlend feColorMatrix feComponentTransfer feComposite
  feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood
  feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology
  feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence`);
const attributes = names(`id class x y x1 x2 y1 y2 cx cy r rx ry d points dx dy rotate
  width height viewBox preserveAspectRatio transform pathLength textLength lengthAdjust
  startOffset method spacing gradientUnits gradientTransform spreadMethod offset fx fy fr
  patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits
  markerWidth markerHeight markerUnits refX refY orient filterUnits primitiveUnits in in2
  result mode type values operator k1 k2 k3 k4 order kernelMatrix divisor bias targetX targetY
  edgeMode kernelUnitLength preserveAlpha surfaceScale diffuseConstant specularConstant
  specularExponent limitingConeAngle azimuth elevation xChannelSelector yChannelSelector
  stdDeviation radius scale seed numOctaves baseFrequency stitchTiles tableValues slope
  intercept amplitude exponent z pointsAtX pointsAtY pointsAtZ`);
const properties = names(`fill fill-opacity fill-rule stroke stroke-width stroke-opacity
  stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity
  clip-path clip-rule mask filter color color-interpolation color-interpolation-filters
  stop-color stop-opacity flood-color flood-opacity lighting-color vector-effect paint-order
  font font-family font-size font-weight font-style font-stretch font-variant font-feature-settings
  text-anchor text-decoration text-rendering letter-spacing word-spacing direction unicode-bidi
  dominant-baseline alignment-baseline baseline-shift writing-mode white-space line-height
  display visibility overflow shape-rendering image-rendering transform transform-origin
  transform-box width height`);
const functions = names(`rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max
  clamp matrix matrix3d translate translatex translatey translate3d scale scalex scaley scale3d
  rotate rotatex rotatey rotatez rotate3d skew skewx skewy blur brightness contrast grayscale
  hue-rotate invert saturate sepia drop-shadow`);
const localReference = (value: string) =>
  value.length > 1 && value[0] === '#' && !/[\u0000-\u0020\u007f]/.test(value);
const embeddedImage = (value: string) =>
  /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/.test(value);
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeValue(node: CssNode): boolean {
  let safe = true;
  walk(node, (part) => {
    if (
      part.type === 'Raw' ||
      (part.type === 'Url' && !localReference(part.value)) ||
      (part.type === 'Function' && !functions.has(part.name.toLowerCase()))
    )
      safe = false;
  });
  return safe;
}
function declarations(nodes: Iterable<CssNode>): string {
  return Array.from(nodes)
    .filter(
      (node) =>
        node.type === 'Declaration' &&
        properties.has(node.property.toLowerCase()) &&
        safeValue(node.value),
    )
    .map((node) => generate(node))
    .join(';');
}
function cleanCss(value: string, stylesheet = false): string {
  try {
    const node = parse(value, { context: stylesheet ? 'stylesheet' : 'declarationList' });
    if (node.type === 'DeclarationList') return declarations(node.children);
    if (node.type !== 'StyleSheet') return '';
    return Array.from(node.children)
      .flatMap((rule) => {
        if (
          rule.type !== 'Rule' ||
          rule.prelude?.type !== 'SelectorList' ||
          !safeValue(rule.prelude)
        )
          return [];
        const content = declarations(rule.block.children);
        return content ? [`${generate(rule.prelude)}{${content}}`] : [];
      })
      .join('');
  } catch {
    return '';
  }
}
function presentation(value: string): string | null {
  try {
    const node = parse(value, { context: 'value' });
    return safeValue(node) ? generate(node) : null;
  } catch {
    return null;
  }
}

/** A static SVG document, serialized from parsed XML rather than patched strings.
 * No scripts, animation, foreign HTML, external resources, DTDs or processing
 * instructions survive. CSS keeps only presentation properties and local URLs.
 */
export function sanitizeSvg(bytes: Uint8Array): string {
  if (bytes.byteLength > SVG_LIMIT) throw new Error('SVG 图片最多 10 MiB。');
  const output: string[] = [];
  const stack: { tag: string; drop: boolean; text: string[] }[] = [];
  let count = 0;
  try {
    const encoding =
      bytes[0] === 255 && bytes[1] === 254
        ? 'utf-16le'
        : bytes[0] === 254 && bytes[1] === 255
          ? 'utf-16be'
          : 'utf-8';
    const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', (node) => {
      const root = stack.length === 0;
      if (root && (node.local !== 'svg' || (node.uri && node.uri !== NS))) throw new Error();
      if (++count > 100_000 || stack.length >= 64) throw new Error();
      const parent = stack.at(-1);
      const drop =
        !!parent?.drop ||
        parent?.tag === 'style' ||
        !elements.has(node.local) ||
        !!(node.uri && node.uri !== NS);
      const tag = node.local === 'a' ? 'g' : node.local;
      stack.push({ tag, drop, text: [] });
      if (drop || tag === 'style') return;
      const kept = new Map<string, string>();
      for (const attribute of Object.values(node.attributes)) {
        const { local: name, uri, value } = attribute;
        if (name === 'href' && (!uri || uri === XLINK)) {
          if (
            [
              'use',
              'textPath',
              'linearGradient',
              'radialGradient',
              'pattern',
              'image',
              'feImage',
            ].includes(tag) &&
            (localReference(value) || (['image', 'feImage'].includes(tag) && embeddedImage(value)))
          )
            kept.set('href', value);
        } else if (uri === XML && ['space', 'lang'].includes(name)) kept.set(`xml:${name}`, value);
        else if (!uri) {
          if (name === 'style') kept.set(name, cleanCss(value));
          else if (properties.has(name)) {
            const safe = presentation(value);
            if (safe !== null) kept.set(name, safe);
          } else if (attributes.has(name)) kept.set(name, value);
        }
      }
      if (root) {
        // Give viewBox-only diagrams an intrinsic size for image decoding/canvas.
        if (!kept.has('width') && !kept.has('height')) {
          const box = kept
            .get('viewBox')
            ?.trim()
            .split(/[\s,]+/)
            .map(Number);
          if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
            const scale = Math.min(1, 4096 / Math.max(box[2], box[3]));
            kept.set('width', String(box[2] * scale));
            kept.set('height', String(box[3] * scale));
          }
        }
        kept.set('xmlns', NS);
      }
      output.push(
        `<${tag}${Array.from(kept, ([name, value]) => ` ${name}="${escape(value)}"`).join('')}>`,
      );
    });
    const text = (value: string) => {
      const parent = stack.at(-1);
      if (!parent || parent.drop) return;
      if (parent.tag === 'style') parent.text.push(value);
      else output.push(escape(value));
    };
    parser.on('text', text);
    parser.on('cdata', text);
    parser.on('closetag', () => {
      const node = stack.pop()!;
      if (node.drop) return;
      if (node.tag === 'style') {
        const css = cleanCss(node.text.join(''), true);
        if (css) output.push(`<style>${escape(css)}</style>`);
      } else output.push(`</${node.tag}>`);
    });
    // Saxes does not resolve DTDs or expand custom entities. Undefined entities
    // fail XML parsing, including external entities and entity-expansion bombs.
    parser.write(source).close();
    if (!count) throw new Error();
  } catch {
    throw new Error('SVG 图片格式无效或结构过于复杂，无法导入。');
  }
  const clean = output.join('');
  if (new TextEncoder().encode(clean).byteLength > SVG_LIMIT)
    throw new Error('清理后的 SVG 图片超过 10 MiB。');
  return clean;
}
