import { type Page, type Locator } from './fixtures';
import { paperHtml, paperPng } from '../tests/fixtures/arxiv';

export async function paperImportFixture(page: Page, source = paperHtml, svg?: string) {
  const headers = { origin: 'http://127.0.0.1:8799' };
  const bytes = svg ? Buffer.from(svg) : Buffer.from(paperPng, 'base64');
  const image = await (
    await page.request.post(`/api/files?name=figure.${svg ? 'svg' : 'png'}&size=${bytes.length}`, {
      headers,
      data: bytes,
    })
  ).json();
  let paper: any;
  await page.route('**/api/import/arxiv', async (route) => {
    const input = route.request().postDataJSON();
    const response = await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'link',
        title: input.title || 'A paper & its equations',
        url: 'https://arxiv.org/html/2503.01800v1',
        parentId: input.parentId,
      },
    });
    const node = await response.json();
    const detail = await (await page.request.get(`/api/nodes/${node.id}`)).json();
    // The Worker suite tests extraction/download/retention. Here the transport
    // fixture exercises the importer UI and treats saved HTML as untrusted.
    const body = source.match(/<article[\s\S]*<\/article>/)![0];
    paper = {
      ...detail,
      arxiv_id: '2503.01800v1',
      variant: 'paper',
      content: body.replaceAll('2503.01800v1/figure.png', `/api/files/${image.id}`),
      attachments: [image],
    };
    await page.route(`**/api/nodes/${node.id}`, (request) =>
      request.request().method() === 'GET' ? request.fulfill({ json: paper }) : request.fallback(),
    );
    await route.fulfill({ status: 201, json: paper });
  });
  return {
    get paper() {
      return paper;
    },
  };
}

export async function bluePixels(image: Locator): Promise<number> {
  return image.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] < 90 && pixels[i + 2] > 220 && pixels[i + 3] > 200) blue++;
    return blue;
  });
}
