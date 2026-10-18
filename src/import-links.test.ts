import { expect, it } from 'vitest';
import { rewriteLinks, type ResolveLink } from './import-links';

const targets: Record<string, { link: string; image?: string }> = {
  'img/a b.png': { link: '/n/img', image: '/api/files/blob-a' },
  'a.png': { link: '/n/img', image: '/api/files/blob-a' },
  其他: { link: '/n/note' },
  '其他.md': { link: '/n/note' },
  'doc.pdf': { link: '/n/pdf' },
};
const seen: [string, boolean][] = [];
const resolve: ResolveLink = (target, wiki) => {
  seen.push([target, wiki]);
  return targets[target] ?? null;
};

it('rewrites relative Markdown links and images', () => {
  const { content, missing } = rewriteLinks(
    [
      '![图](img/a%20b.png "标题") ![](<img/a b.png>)',
      '[见其他](其他.md#小节) [](doc.pdf) ![PDF](doc.pdf)',
      '[网页](https://example.com) [锚点](#上面) [站内](/n/x) [丢失](没有.md)',
    ].join('\n'),
    resolve,
  );
  expect(content).toBe(
    [
      '![图](/api/files/blob-a) ![](/api/files/blob-a)',
      '[见其他](/n/note) [doc.pdf](/n/pdf) [PDF](/n/pdf)',
      '[网页](https://example.com) [锚点](#上面) [站内](/n/x) [丢失](没有.md)',
    ].join('\n'),
  );
  expect(missing).toEqual(['没有.md']);
});

it('rewrites wikilinks, embeds and their captions', () => {
  seen.length = 0;
  const { content, missing } = rewriteLinks(
    '[[其他]] [[其他#小节|别名]] ![[a.png]] ![[a.png|300]] ![[a.png|示意图]] ![[其他]] [[缺失]]',
    resolve,
  );
  expect(content).toBe(
    '[其他](/n/note) [别名](/n/note) ![](/api/files/blob-a) ![](/api/files/blob-a) ![示意图](/api/files/blob-a) [其他](/n/note) [[缺失]]',
  );
  expect(missing).toEqual(['缺失']);
  expect(seen.every(([, wiki]) => wiki)).toBe(true);
});

it('leaves code as written', () => {
  const text = [
    '`![](a.png)` 但 ![](a.png)',
    '```md',
    '![[a.png]] [[其他]]',
    '````',
    '~~~',
    '```',
    '[[其他]]',
    '~~~',
    '[[其他]]',
  ].join('\n');
  expect(rewriteLinks(text, resolve).content).toBe(
    [
      '`![](a.png)` 但 ![](/api/files/blob-a)',
      '```md',
      '![[a.png]] [[其他]]',
      '````',
      '~~~',
      '```',
      '[[其他]]',
      '~~~',
      '[其他](/n/note)',
    ].join('\n'),
  );
});
