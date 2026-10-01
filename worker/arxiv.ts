import type { Env } from './types';
import { AppError, asError, idValue, textValue } from './http';
import { createNode, getNode, priorOperation } from './library';
import { discardFile, storeSvg, uploadFile } from './storage';

const HTML_LIMIT = 8 * 1_048_576;
const IMAGE_LIMIT = 10 * 1_048_576;
const TOTAL_IMAGE_LIMIT = 50_000_000;
const IMAGE_COUNT_LIMIT = 24;
const ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?$/;

export function arxivUrl(input: unknown): URL {
  const value = textValue(input, 'arXiv 地址', 4000).trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, '请输入 arXiv 论文的完整网址。');
  }
  const id = url.pathname
    .replace(/^\/(?:html|abs|pdf)\//, '')
    .replace(/\.pdf$/, '')
    .replace(/\/$/, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['arxiv.org', 'www.arxiv.org'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/(html|abs|pdf)\//.test(url.pathname) ||
    !ID.test(id)
  )
    throw new AppError(400, '仅支持 arxiv.org 的 HTML、摘要或 PDF 论文链接。');
  return new URL(`https://arxiv.org/html/${id}`);
}
function imageUrl(input: string, paper: URL): URL {
  let url: URL;
  try {
    url = new URL(input, paper);
  } catch {
    throw new AppError(400, '论文图片地址无法识别。');
  }
  if (
    url.origin !== 'https://arxiv.org' ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(`${paper.pathname}/`) ||
    /%2f|%5c/i.test(url.pathname)
  )
    throw new AppError(400, '论文含有站外或不属于本论文的图片，无法完整导入。');
  url.hash = '';
  return url;
}
async function fetchSource(
  url: URL,
  signal: AbortSignal,
  accept: (url: URL) => URL,
): Promise<{ response: Response; url: URL }> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { accept: 'text/html,image/*;q=0.9' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get('location');
      await response.body?.cancel();
      if (!target) throw new AppError(502, 'arXiv 返回了无效的跳转地址。');
      url = accept(new URL(target, url));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        502,
        response.status === 404
          ? '未找到论文 HTML 或图片；该版本可能还没有 HTML，可使用 PDF 阅读。'
          : response.status === 429
            ? 'arXiv 暂时限制了访问，请稍后重试。'
            : '暂时无法读取 arXiv，请稍后重试。',
      );
    }
    return { response, url };
  }
  throw new AppError(502, 'arXiv 跳转次数过多，请使用带版本号的 HTML 链接。');
}
async function bounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new AppError(502, 'arXiv 返回了空文件。');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new AppError(413, '论文 HTML 或图片超过导入大小限制。');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new AppError(413, '论文 HTML 或图片超过导入大小限制。');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function titleText(value: string): string {
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]!,
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
export async function importArxiv(
  env: Env,
  data: Record<string, unknown>,
  key: string,
  requestSignal: AbortSignal,
) {
  const requested = arxivUrl(data.url);
  const parent = data.parentId == null ? null : idValue(data.parentId);
  if (parent) await getNode(env, parent);
  const previous = await priorOperation(env, key, 'import-arxiv');
  if (previous) return previous;
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(90_000)]);
  const stored: string[] = [];
  try {
    const fetched = await fetchSource(requested, signal, (url) => {
      const next = arxivUrl(url.href);
      if (
        next.pathname.replace(/v\d+$/, '') !== requested.pathname.replace(/v\d+$/, '') ||
        (/v\d+$/.test(requested.pathname) && next.pathname !== requested.pathname)
      )
        throw new AppError(400, 'arXiv 跳转到了另一篇论文。');
      return next;
    });
    if (!fetched.response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
      await fetched.response.body?.cancel();
      throw new AppError(400, '这个版本没有可导入的论文 HTML。');
    }
    let paper = fetched.url;
    const source = await bounded(fetched.response, HTML_LIMIT);
    const marker = `paper-${crypto.randomUUID()}`,
      start = `<!--${marker}:start-->`,
      end = `<!--${marker}:end-->`;
    const licenseStart = `<!--${marker}:license-->`,
      licenseEnd = `<!--${marker}:license-end-->`;
    let found = 0,
      title = '';
    let extractionError: AppError | undefined;
    const images = new Map<string, string>();
    const inlineSvg: { start: string; end: string; label: string }[] = [];
    const rewriter = new HTMLRewriter()
      .on('#license-tr', {
        element(element) {
          element.before(licenseStart, { html: true });
          element.after(licenseEnd, { html: true });
        },
      })
      .on('a.header-button', {
        element(element) {
          const href = element.getAttribute('href');
          if (!href) return;
          try {
            const candidate = arxivUrl(new URL(href, paper).href);
            if (
              /v\d+$/.test(candidate.pathname) &&
              candidate.pathname.replace(/v\d+$/, '') === paper.pathname.replace(/v\d+$/, '') &&
              (!/v\d+$/.test(requested.pathname) || candidate.pathname === requested.pathname)
            )
              paper = candidate;
          } catch {
            /* Not a paper link. */
          }
        },
      })
      .on('article.ltx_document', {
        element(element) {
          found++;
          element.before(start, { html: true });
          element.after(end, { html: true });
        },
      })
      .on('article.ltx_document h1', {
        text(chunk) {
          if (title.length < 4000) title += chunk.text;
        },
      })
      .on('article.ltx_document svg', {
        element(element) {
          const item = {
            start: `<!--${marker}:svg-${inlineSvg.length}-->`,
            end: `<!--${marker}:svg-end-${inlineSvg.length}-->`,
            label: element.getAttribute('aria-label') || '论文插图',
          };
          inlineSvg.push(item);
          element.before(item.start, { html: true });
          element.after(item.end, { html: true });
        },
      })
      .on('article.ltx_document img', {
        element(element) {
          if (extractionError) return;
          const src = element.getAttribute('src');
          if (!src) {
            element.remove();
            return;
          }
          try {
            const url = imageUrl(src, paper).href;
            if (!images.has(url)) images.set(url, `${marker}-image-${images.size}-end`);
            if (images.size > IMAGE_COUNT_LIMIT)
              throw new AppError(413, '每篇论文最多导入 24 张不同图片。');
            element.setAttribute('src', images.get(url)!);
            element.removeAttribute('srcset');
          } catch (error) {
            extractionError = asError(error);
          }
        },
      });
    for (const tag of [
      'script',
      'link',
      'meta',
      'base',
      'iframe',
      'object',
      'embed',
      'form',
      'nav',
    ])
      rewriter.on(`article.ltx_document ${tag}`, {
        element(element) {
          element.remove();
        },
      });
    const transformed = await rewriter
      .transform(new Response(source, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
      .text();
    if (extractionError) throw extractionError;
    const first = transformed.indexOf(start),
      last = transformed.indexOf(end, first + start.length);
    if (found !== 1 || first < 0 || last < 0 || !titleText(title))
      throw new AppError(400, '没有找到完整的论文正文；该版本可能尚未提供 HTML。');
    if (!/v\d+$/.test(paper.pathname))
      throw new AppError(400, '无法确定论文版本，请使用带版本号的链接，例如 2503.01800v1。');
    let html = transformed.slice(first + start.length, last),
      total = 0;
    const license = transformed.split(licenseStart)[1]?.split(licenseEnd)[0];
    if (license) html += `<p class="ltx_paper_license">${license}</p>`;
    let inlineCount = 0;
    for (const svg of inlineSvg) {
      const start = html.indexOf(svg.start);
      // Nested SVGs stay inside their outer image, which has already been saved.
      if (start < 0) continue;
      const end = html.indexOf(svg.end, start + svg.start.length);
      if (end < 0) throw new AppError(400, '论文内嵌 SVG 不完整，无法导入。');
      if (++inlineCount + images.size > IMAGE_COUNT_LIMIT)
        throw new AppError(413, '每篇论文最多导入 24 张不同图片。');
      const bytes = new TextEncoder().encode(html.slice(start + svg.start.length, end));
      total += bytes.byteLength;
      const file = await storeSvg(env, bytes, `figure-${inlineCount}.svg`);
      stored.push(file.id);
      const alt = svg.label
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      html =
        html.slice(0, start) +
        `<img src="/api/files/${file.id}" alt="${alt}">` +
        html.slice(end + svg.end.length);
    }
    // SVG styles are cleaned inside the saved image. Page styles stay out of the
    // article; parse again only when there is a style element left to remove.
    if (/<style[\s>]/i.test(html))
      html = await new HTMLRewriter()
        .on('style', {
          element(element) {
            element.remove();
          },
        })
        .transform(new Response(html, { headers: { 'content-type': 'text/html' } }))
        .text();
    for (const [url, token] of images) {
      const image = await fetchSource(new URL(url), signal, (target) =>
        imageUrl(target.href, paper),
      );
      const bytes = await bounded(image.response, IMAGE_LIMIT);
      total += bytes.byteLength;
      if (total > TOTAL_IMAGE_LIMIT) throw new AppError(413, '论文图片合计超过 50 MB，无法导入。');
      const name = image.url.pathname.split('/').at(-1)!.slice(0, 180);
      const blob = await uploadFile(
        env,
        new Request(
          `https://local/upload?name=${encodeURIComponent(name)}&size=${bytes.byteLength}`,
          {
            method: 'POST',
            body: bytes,
            headers: {
              'content-type':
                image.response.headers.get('content-type') || 'application/octet-stream',
            },
          },
        ),
      );
      stored.push(blob.id);
      if (!/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(blob.mime))
        throw new AppError(400, '论文含有无法识别的图片，本次未创建笔记。');
      html = html.replaceAll(token, `/api/files/${blob.id}`);
    }
    signal.throwIfAborted();
    const arxivId = paper.pathname.slice('/html/'.length);
    return await createNode(
      env,
      {
        kind: 'link',
        title: data.title ? textValue(data.title, '标题').trim() : titleText(title),
        parentId: parent,
        url: paper.href,
      },
      key,
      { arxivId, html, assets: stored },
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    const known = asError(error);
    if (known.code !== 'INTERNAL_ERROR') throw known;
    throw new AppError(
      502,
      signal.aborted ? '导入已取消或超时，请稍后重试。' : '论文导入未完成，请稍后重试。',
    );
  } finally {
    // Referenced assets are protected by the existing storage predicates;
    // failed imports and losing idempotent requests leave no orphan uploads.
    for (const id of stored) await discardFile(env, id).catch(() => {});
  }
}
