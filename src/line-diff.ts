export type DiffEntry =
  | { type: 'same' | 'add' | 'del'; text: string; oldNumber?: number; newNumber?: number }
  | { type: 'skip'; count: number };

const CONTEXT = 3;
const MAX_CELLS = 400_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

// Line-level diff between `before` (historical) and `after` (current), with
// unchanged runs collapsed to CONTEXT lines around each change.
export function diffLines(before: string, after: string): DiffEntry[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && a.length === b.length) return [];
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const raw: Extract<DiffEntry, { type: 'same' | 'add' | 'del' }>[] = [];
  for (let i = 0; i < start; i++)
    raw.push({ type: 'same', text: a[i], oldNumber: i + 1, newNumber: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length <= MAX_CELLS) {
    const cols = midB.length + 1;
    const dp = new Int32Array((midA.length + 1) * cols);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        dp[i * cols + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * cols + (j + 1)] + 1
            : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        raw.push({
          type: 'same',
          text: midA[i],
          oldNumber: start + i + 1,
          newNumber: start + j + 1,
        });
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
        raw.push({ type: 'del', text: midA[i], oldNumber: start + i + 1 });
        i++;
      } else {
        raw.push({ type: 'add', text: midB[j], newNumber: start + j + 1 });
        j++;
      }
    }
    while (i < midA.length) {
      raw.push({ type: 'del', text: midA[i], oldNumber: start + i + 1 });
      i++;
    }
    while (j < midB.length) {
      raw.push({ type: 'add', text: midB[j], newNumber: start + j + 1 });
      j++;
    }
  } else {
    for (let i = 0; i < midA.length; i++)
      raw.push({ type: 'del', text: midA[i], oldNumber: start + i + 1 });
    for (let j = 0; j < midB.length; j++)
      raw.push({ type: 'add', text: midB[j], newNumber: start + j + 1 });
  }

  for (let k = 0; k < a.length - endA; k++) {
    raw.push({
      type: 'same',
      text: a[endA + k],
      oldNumber: endA + k + 1,
      newNumber: endB + k + 1,
    });
  }

  const keep = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].type === 'same') continue;
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(raw.length - 1, i + CONTEXT);
    for (let k = from; k <= to; k++) keep[k] = 1;
  }

  const collapsed: DiffEntry[] = [];
  let skipped = 0;
  for (let i = 0; i < raw.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        collapsed.push({ type: 'skip', count: skipped });
        skipped = 0;
      }
      collapsed.push(raw[i]);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) collapsed.push({ type: 'skip', count: skipped });
  return collapsed;
}
