export type OnProgress = (message: string) => void;
const TERMINAL_INTERVAL_MS = 80;
// Piped output keeps a record, so it gets occasional lines rather than a stream of them.
const LOG_INTERVAL_MS = 2000;
const wide = (char: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{20000}-\u{3ffff}]/u.test(char);
// The message cut to one terminal row: a wrapped line could not be overwritten.
export function fitLine(message: string, columns: number): string {
  let width = 0,
    line = '';
  for (const char of message) {
    width += wide(char) ? 2 : 1;
    if (width > columns - 1) return `${line}…`;
    line += char;
  }
  return line;
}
// Progress goes to stderr, leaving stdout to the results.
export class Progress {
  stream: Pick<NodeJS.WriteStream, 'write' | 'isTTY' | 'columns'>;
  private showing = false;
  private paused = false;
  private last = 0;
  private waiting: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(stream: Progress['stream'] = process.stderr) {
    this.stream = stream;
  }
  private get interval() {
    return this.stream.isTTY ? TERMINAL_INTERVAL_MS : LOG_INTERVAL_MS;
  }
  private show(message: string) {
    this.last = Date.now();
    if (this.stream.isTTY) {
      this.stream.write(`\r\x1b[K${fitLine(message, this.stream.columns || 80)}`);
      this.showing = true;
    } else this.stream.write(`${message}\n`);
  }
  // Shows the message, or the latest one once enough time has passed.
  update: OnProgress = (raw) => {
    if (this.paused) return;
    // Names come from notes and local files; they must not steer the terminal.
    // oxlint-disable-next-line no-control-regex -- control characters are what this removes.
    const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
    const due = this.last + this.interval - Date.now();
    if (due <= 0) {
      this.waiting = null;
      this.show(message);
      return;
    }
    this.waiting = message;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.waiting !== null && !this.paused) this.show(this.waiting);
      this.waiting = null;
    }, due);
    this.timer.unref?.();
  };
  // Removes the line, so that other output starts clean.
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting = null;
    if (this.showing) this.stream.write('\r\x1b[K');
    this.showing = false;
  }
  // Keeps the line away from a question being answered.
  async during<T>(work: () => Promise<T>): Promise<T> {
    this.clear();
    this.paused = true;
    try {
      return await work();
    } finally {
      this.paused = false;
    }
  }
}
