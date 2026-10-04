import { PAPER_BLOCK_CHARS, PLACEHOLDER, placeholder } from '../shared/paper-translation';

// The paragraphs of an imported paper that get translated: headings, body
// paragraphs and captions. Table cells and the reference list stay as they are.
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,figcaption';
const SKIPPED = '.ltx_bibliography, td, th';
// Kept verbatim and shown to the model only as ⟦n⟧.
const KEPT =
  'math, img, svg, code, a, cite, sup, sub, .ltx_ref, .ltx_cite, .ltx_tag, .ltx_note, .ltx_Math';

export interface PaperBlock {
  element: Element;
  // Text with ⟦n⟧ in place of `parts[n]`.
  text: string;
  parts: Node[];
}

// Blocks in document order. Two clones of the same article yield blocks in the
// same order, which the comparison view uses to pair paragraphs.
export function paperBlocks(root: Element | DocumentFragment): PaperBlock[] {
  const blocks: PaperBlock[] = [];
  for (const element of root.querySelectorAll(BLOCKS)) {
    if (element.closest(SKIPPED) || element.parentElement?.closest(BLOCKS)) continue;
    const parts: Node[] = [];
    let text = '';
    const walk = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        else if (child instanceof Element) {
          if (child.matches(KEPT)) {
            text += placeholder(parts.length);
            parts.push(child);
          } else walk(child);
        }
      }
    };
    walk(element);
    text = text.replace(/\s+/g, ' ').trim();
    // Nothing to translate (only formulas or numbers), or too long for one request.
    if (!/\p{L}{2}/u.test(text.replace(PLACEHOLDER, '')) || text.length > PAPER_BLOCK_CHARS)
      continue;
    blocks.push({ element, text, parts });
  }
  return blocks;
}

// Replaces a block's content with its translation, putting the kept formulas,
// citations and links back where the ⟦n⟧ markers are.
export function applyTranslation(block: PaperBlock, translated: string) {
  const nodes: Node[] = [];
  const used = new Set<number>();
  let last = 0;
  for (const match of translated.matchAll(PLACEHOLDER)) {
    nodes.push(document.createTextNode(translated.slice(last, match.index)));
    const index = Number(match[1]),
      part = block.parts[index];
    if (part) {
      nodes.push(used.has(index) ? part.cloneNode(true) : part);
      used.add(index);
    }
    last = match.index + match[0].length;
  }
  nodes.push(document.createTextNode(translated.slice(last)));
  block.element.replaceChildren(...nodes);
}

export async function blockHash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
