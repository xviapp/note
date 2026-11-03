import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';

let piped: AsyncIterableIterator<string> | null = null;
const silent = () => new Writable({ write: (_chunk, _encoding, done) => done() });
// One reader for the whole run: piped lines must not be lost between questions.
async function pipedLine(): Promise<string | null> {
  piped ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const line = await piped.next();
  return line.done ? null : line.value;
}
async function ask(reader: Interface, label: string): Promise<string> {
  try {
    return await reader.question(label);
  } finally {
    reader.close();
  }
}
// A line typed without showing it, or the next line of piped input.
export async function readSecret(label: string): Promise<string | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return pipedLine();
  stdout.write(label);
  const value = await ask(createInterface({ input: stdin, output: silent(), terminal: true }), '');
  stdout.write('\n');
  return value;
}
export const canConfirm = () => !!process.stdin.isTTY;
export async function confirm(label: string): Promise<boolean> {
  const { stdin, stdout } = process;
  const answer = await ask(createInterface({ input: stdin, output: stdout }), label);
  return /^y(es)?$/i.test(answer.trim());
}
