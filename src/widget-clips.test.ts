import { beforeEach, expect, it, vi } from 'vitest';
import { flushWidgetClips } from './widget-clips';
const { api, device } = vi.hoisted(() => ({
  api: vi.fn(),
  device: { pendingWidgetClips: vi.fn(), markWidgetClipSent: vi.fn() },
}));
vi.mock('./api', () => ({ api }));
vi.mock('./mobile', () => ({ device }));
vi.mock('./encryption', () => ({ sealString: vi.fn(async () => 'sealed') }));
vi.mock('./clips', () => ({ onClipsSent: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  device.pendingWidgetClips.mockResolvedValue({ items: [{ id: 'one', text: '记录', createdAt: 1 }] });
  device.markWidgetClipSent.mockResolvedValue(undefined);
});
it('marks a confirmed native clip as sent and redacts encrypted summaries', async () => {
  api.mockResolvedValueOnce({ keyId: 'key' }).mockResolvedValueOnce({});
  await flushWidgetClips();
  expect(device.markWidgetClipSent).toHaveBeenCalledWith({ id: 'one', encrypted: true });
  expect(api).toHaveBeenLastCalledWith('/api/clips', 'POST', { id: 'one', text: 'sealed', createdAt: 1 }, 'one');
});
it('keeps a failed native clip pending without a receipt', async () => {
  api.mockResolvedValueOnce({ keyId: null }).mockRejectedValueOnce(new Error('offline'));
  await flushWidgetClips();
  expect(device.markWidgetClipSent).not.toHaveBeenCalled();
});
