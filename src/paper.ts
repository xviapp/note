import createDOMPurify from 'dompurify';
import type { NoteDetail } from '../shared/types';

const purifier = createDOMPurify(window);
purifier.addHook('uponSanitizeAttribute', (element, data) => {
  if (data.attrName === 'src' && !/^\/api\/files\/[a-zA-Z0-9_-]+$/.test(data.attrValue))
    data.keepAttr = false;
  if (data.attrName === 'href' && element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
    data.keepAttr = false;
  if (data.attrName === 'class')
    data.attrValue = data.attrValue
      .split(/\s+/)
      .filter((value) => /^ltx_[a-zA-Z0-9_-]+$/.test(value))
      .join(' ');
});

export function paperFragment(content: string): DocumentFragment {
  return purifier.sanitize(content, {
    USE_PROFILES: { html: true, mathMl: true },
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: [
      'style',
      'script',
      'link',
      'meta',
      'base',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'nav',
      'audio',
      'video',
      'source',
      'annotation',
      'annotation-xml',
    ],
    FORBID_ATTR: [
      'style',
      'srcset',
      'name',
      'autofocus',
      'contenteditable',
      'hidden',
      'mathcolor',
      'mathbackground',
    ],
    ADD_ATTR: ['alttext'],
    // Removing annotation tags alone unwraps their TeX into the MathML formula.
    // Keep the presentation tree and its alttext, but discard alternate encodings.
    ADD_FORBID_CONTENTS: ['nav', 'annotation', 'annotation-xml'],
    ALLOW_DATA_ATTR: false,
  });
}

export function paperText(root: Element | DocumentFragment): string {
  const clone = root.cloneNode(true) as Element | DocumentFragment;
  for (const math of clone.querySelectorAll('math')) {
    const tex = math.getAttribute('alttext') || math.textContent || '';
    const delimiter = math.getAttribute('display') === 'block' ? '$$' : '$';
    math.replaceWith(document.createTextNode(`${delimiter}${tex}${delimiter}`));
  }
  for (const image of clone.querySelectorAll('img'))
    image.replaceWith(
      document.createTextNode(`[图片：${image.getAttribute('alt') || '参见原文图注'}]`),
    );
  for (const element of clone.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    element.prepend(`${'#'.repeat(Number(element.tagName[1]))} `);
  for (const element of clone.querySelectorAll(
    'p,div,section,h1,h2,h3,h4,h5,h6,li,figure,figcaption,table,tr,br',
  ))
    element.append('\n');
  return (clone.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PaperPart {
  id: string;
  title: string;
  text: string;
}
export function paperParts(note: NoteDetail): PaperPart[] {
  const fragment = paperFragment(note.content);
  const prefix = `${note.title}\narXiv:${note.arxiv_id}\n${note.url}\n\n`;
  return [
    { id: 'all', title: '全文', text: prefix + paperText(fragment) },
    ...Array.from(fragment.querySelectorAll('section')).flatMap((section, index) => {
      const heading = section.querySelector(
        ':scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6',
      );
      return heading
        ? [
            {
              id: `section-${index}`,
              title: paperText(heading).replace(/^#+\s*/, ''),
              text: prefix + paperText(section),
            },
          ]
        : [];
    }),
  ];
}
