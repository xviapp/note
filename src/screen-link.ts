// A paper's translation on a second screen: the reading window opens a
// window showing only the translation, and the two keep the same paragraph
// in view over a same-origin BroadcastChannel (no server round trips).

export type Anchor = { index: number; ratio: number; offset: number };
export type LinkMessage =
  // The translation window has opened, or is closing.
  | { type: 'hello' }
  | { type: 'bye'; from: 'reader' | 'translation' }
  // Saved paragraphs and the language, from the reading window.
  | { type: 'blocks'; language: string; blocks: Record<string, string> }
  | { type: 'scroll'; anchor: Anchor }
  // A paragraph clicked on one side, flashed on the other.
  | { type: 'flash'; index: number }
  // The reading window takes the translation back.
  | { type: 'close' };

export const linkChannel = (nodeId: string) => new BroadcastChannel(`paper-link:${nodeId}`);
export const translationWindowUrl = (nodeId: string) => `/n/${nodeId}?pane=translation`;
export const translationWindowId = () => {
  const id =
    new URLSearchParams(location.search).get('pane') === 'translation'
      ? location.pathname.match(/^\/n\/([a-zA-Z0-9_-]+)$/)?.[1]
      : undefined;
  return id ?? null;
};

// How to move a window to the other screen and fill it, by platform.
export function moveHint() {
  const agent = navigator.userAgent;
  if (/Mac/.test(agent)) return '把窗口拖到另一块屏幕，再按 Ctrl+Cmd+F 全屏。';
  if (/Windows/.test(agent)) return '按 Win+Shift+→ 移到另一块屏幕，再按 F11 全屏。';
  return '按 Super+Shift+→ 移到另一块屏幕，再按 F11 全屏。';
}

type ScreenInfo = { availLeft: number; availTop: number; availWidth: number; availHeight: number };
type ScreenDetails = { screens: ScreenInfo[]; currentScreen: ScreenInfo };

// Opens the translation window. It opens at once, inside the click, so no
// popup blocker stops it; where the browser can list screens (Chrome, Edge
// with permission) it then moves to another screen and fills it. Returns the
// window, or null if blocked, and whether it was placed on another screen.
export async function openTranslationWindow(nodeId: string) {
  const width = Math.min(screen.availWidth, 1100),
    height = screen.availHeight;
  const opened = window.open(
    translationWindowUrl(nodeId),
    `paper-translation-${nodeId}`,
    `popup,width=${width},height=${height}`,
  );
  if (!opened) return { opened: null, placed: false };
  const query = (window as Window & { getScreenDetails?: () => Promise<ScreenDetails> })
    .getScreenDetails;
  if (!query) return { opened, placed: false };
  try {
    const details = await query.call(window);
    const other = details.screens.find((item) => item !== details.currentScreen);
    if (!other) return { opened, placed: false };
    opened.moveTo(other.availLeft, other.availTop);
    opened.resizeTo(other.availWidth, other.availHeight);
    // A window manager may refuse to move it (e.g. Wayland).
    await new Promise((resolve) => setTimeout(resolve, 300));
    const placed =
      Math.abs(opened.screenX - other.availLeft) < 50 &&
      Math.abs(opened.screenY - other.availTop) < 50;
    return { opened, placed };
  } catch {
    // Permission declined or not available here.
    return { opened, placed: false };
  }
}

// Offered only where a second window can be opened: not on phones or in the app.
export const canOpenTranslationWindow = () =>
  import.meta.env.MODE !== 'android' &&
  !matchMedia('(max-width: 760px), (pointer: coarse)').matches;
