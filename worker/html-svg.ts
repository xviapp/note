import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['childNode'];
const XLINK = 'http://www.w3.org/1999/xlink';
const XML_NAME = /^[A-Za-z_][\w.-]*$/;
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline SVG copied out of an HTML page, as an XML document.
 * HTML rules differ from XML: text in foreignObject may leave `<br>` open or
 * use named entities such as `&nbsp;`. Parsing it as HTML and writing it back
 * as namespaced XML lets the strict SVG sanitizer read what browsers render.
 */
export function htmlSvgToXml(markup: string): string {
  const output: string[] = [];
  const write = (node: Node, parentNamespace: string | null, root: boolean) => {
    if (node.nodeName === '#text') {
      output.push(escape((node as DefaultTreeAdapterMap['textNode']).value));
      return;
    }
    if (!('tagName' in node)) return; // Comments and doctypes.
    const element = node as DefaultTreeAdapterMap['element'];
    output.push(`<${element.tagName}`);
    if (element.namespaceURI !== parentNamespace)
      output.push(` xmlns="${escape(element.namespaceURI)}"`);
    if (root) output.push(` xmlns:xlink="${XLINK}"`);
    for (const attribute of element.attrs) {
      if (!XML_NAME.test(attribute.name) || attribute.name === 'xmlns') continue;
      const prefix =
        attribute.namespace === XLINK ? 'xlink:' : attribute.prefix === 'xml' ? 'xml:' : '';
      if (attribute.prefix && !prefix) continue;
      output.push(` ${prefix}${attribute.name}="${escape(attribute.value)}"`);
    }
    output.push('>');
    for (const child of element.childNodes) write(child, element.namespaceURI, false);
    output.push(`</${element.tagName}>`);
  };
  for (const node of parseFragment(markup).childNodes) write(node, null, true);
  return output.join('');
}
