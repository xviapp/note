import { chromium } from '@playwright/test';
const b = await chromium.launch(); const p = await b.newPage();
await p.goto('http://example.com/').catch(() => {});
console.log(await p.evaluate(async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>';
  const test = async (src) => { const i = new Image(); i.src = src; await i.decode(); const c = document.createElement('canvas'); c.width = c.height = 10; const x = c.getContext('2d'); x.drawImage(i, 0, 0); try { x.getImageData(0, 0, 1, 1); return 'clean'; } catch { return 'tainted'; } };
  return { blob: await test(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))), data: await test('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)) };
}));
await b.close();
