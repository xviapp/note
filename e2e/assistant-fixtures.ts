import { expect, type Page } from './fixtures';
import { GLOBAL_ASSISTANT_ID, type ChatHistory, type ChatMessage, type ChatInput } from '../shared/assistant';

// UI fixtures simulate conversation transport; Worker tests exercise the actual
// encrypted settings, provider stream, persistence and export endpoints in D1/R2.
export async function assistantFixture(page: Page, options: { interruptFirst?: boolean } = {}) {
  const threads = new Map<string, ChatHistory>();
  const sent: ChatInput[] = [];
  let sequence = 0;
  await page.route('**/api/nodes/*/assistant**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const match = path.match(/\/nodes\/([^/]+)\/assistant(?:\/([^/]+)\/export)?$/);
    if (!match) {
      await route.fallback();
      return;
    }
    const id = match[1];
    const thread = threads.get(id) || { messages: [], nextBefore: null, busy: false };
    threads.set(id, thread);
    if (request.method() === 'GET') {
      await route.fulfill({ json: thread });
      return;
    }
    if (request.method() === 'DELETE') {
      thread.messages = [];
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (match[2]) {
      const message = thread.messages.find((m) => m.id === match[2])!;
      const response = await page.request.post('/api/nodes', {
        headers: {
          origin: 'http://127.0.0.1:8799',
          'x-idempotency-key': `ai-${message.id}`,
        },
        data: {
          parentId: id === GLOBAL_ASSISTANT_ID ? null : id,
          kind: 'markdown',
          title: '结构要点',
          content: message.content,
        },
      });
      const node = await response.json();
      message.exportedNodeId = node.id;
      await route.fulfill({ status: response.status(), json: node });
      return;
    }
    const data = request.postDataJSON() as ChatInput;
    sent.push(data);
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      sequence: ++sequence,
      role: 'user',
      status: 'completed',
      content: data.content,
      quote: data.quote,
      createdAt: Date.now(),
    };
    if (data.files)
      user.files = data.files.map((file) => ({
        name: file.name,
        kind: file.kind,
        text: file.text,
        pages: file.pages,
        pageCount: file.pageCount,
        mode: file.mode,
        ...(file.sourceId
          ? {
              source: {
                id: file.sourceId,
                name: file.name,
                mime: file.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream',
                size: 1,
              },
            }
          : {}),
        images: file.images.map((image) => ({
          file: { id: image.blobId, name: 'page.jpg', mime: 'image/jpeg', size: 1 },
          page: image.page,
        })),
      }));
    if (data.image) {
      const bytes = Buffer.from(data.image.split(',')[1], 'base64');
      const response = await page.request.post(
        `/api/files?name=screenshot.jpg&size=${bytes.length}`,
        {
          headers: { origin: 'http://127.0.0.1:8799' },
          data: bytes,
        },
      );
      user.image = await response.json();
    }
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      sequence: ++sequence,
      role: 'assistant',
      status: options.interruptFirst && sent.length === 1 ? 'interrupted' : 'completed',
      ...(options.interruptFirst && sent.length === 1
        ? { error: '已达到本次回复长度上限，可点击「继续生成」。' }
        : {}),
      content:
        '# 结构要点\n\n这段资料介绍了桥梁的受力路径。\n\n- 桥面承受荷载，再传给主梁。\n- 支座将力传递到桥墩与基础。\n\n可以结合截图，逐项标注结构的位置。\n\n![示意图](https://assistant-tracker.invalid/pixel.png)',
      createdAt: Date.now(),
    };
    thread.messages.push(user, assistant);
    const events = [
      { type: 'start', user, assistant: { ...assistant, content: '', status: 'pending' } },
      { type: 'delta', content: assistant.content },
      assistant.error
        ? { type: 'error', error: assistant.error, message: assistant }
        : { type: 'done', message: assistant },
    ];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });
  return { threads, sent };
}

export async function cropInBrowser(page: Page, mobile: boolean) {
  await page.getByRole('button', { name: '框选截图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '框选截图', exact: true });
  await expect(dialog).toBeVisible();
  const box = (await dialog.locator('.capture-stage').boundingBox())!;
  const start = { x: box.x + box.width * 0.07, y: box.y + box.height * 0.06 };
  const end = { x: box.x + box.width * 0.93, y: box.y + box.height * 0.7 };
  if (mobile) {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect(dialog.getByRole('button', { name: '采用截图' })).toBeEnabled();
  await page.screenshot({
    path: `test-results/assistant-crop-${mobile ? 'mobile' : 'desktop'}.png`,
  });
  await dialog.getByRole('button', { name: '采用截图' }).click();
  await expect(page.getByAltText('待发送截图')).toBeVisible();
}
