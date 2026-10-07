export function recordTime(date = new Date(), offset = -date.getTimezoneOffset()) {
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const value = Math.abs(offset);
  return `${local} ${offset < 0 ? '-' : '+'}${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function appendContent(content: string, title: string, text: string, markdown = true, time?: string) {
  const heading = title.trim().replace(/[\r\n]+/g, ' ');
  const block = `${heading ? `${markdown ? '## ' : ''}${heading}\n\n` : ''}${time ? `> ${time}\n\n` : ''}${text.trim()}`;
  return `${content}${content ? `${content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'}` : ''}${block}\n`;
}
