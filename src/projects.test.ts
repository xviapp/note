import { describe, expect, it } from 'vitest';
import { markdownMetadata, projectMarkdown, projectStatusContent, setMarkdownStatus } from '../shared/projects';
import { recordTime } from '../shared/records';

describe('project Markdown metadata', () => {
  it('records status transitions once while preserving the original body', () => {
    const time = recordTime(new Date('2026-10-07T03:00:00Z'), 480);
    expect(time).toBe('2026-10-07 11:00:00 +08:00');
    const original = projectMarkdown('todo', '任务') + '原文';
    const next = projectStatusContent(original, 'todo', 'doing', time);
    expect(next).toBe(original.replace('status: todo', 'status: doing') + '\n\n## 状态变更\n\n> 2026-10-07 11:00:00 +08:00\n\n待办 → 进行中\n');
    expect(projectStatusContent(next, 'todo', 'doing', time)).toBe(next);
    expect(recordTime(new Date('2026-10-07T03:00:00Z'), -330)).toBe('2026-10-06 21:30:00 -05:30');
  });
  it('handles large whitespace runs and unclosed code fences without treating code as a title', () => {
    expect(markdownMetadata('\n'.repeat(60_000) + '# C#\n\n正文')).toMatchObject({
      title: 'C#',
      summary: '正文',
    });
    expect(markdownMetadata('```md\n# 代码标题\n正文')).toMatchObject({ title: null, summary: '' });
    expect(markdownMetadata('   ~~~md\n# 代码\n~~~~\n\n# 正文标题 ##\n\n正文')).toMatchObject({
      title: '正文标题',
      summary: '正文',
    });
  });
  it('reads quoted scalars and falls back to a prose heading, ignoring code fences', () => {
    expect(
      markdownMetadata(
        '---\ntitle: "方案：第一版" # comment\nstatus: done\n---\n\n说明 [链接](/n/id)',
      ),
    ).toMatchObject({
      title: '方案：第一版',
      status: 'done',
      summary: '说明 链接',
    });
    expect(markdownMetadata("---\ntitle: 'It''s a note'\n---\n正文").title).toBe("It's a note");
    expect(markdownMetadata('```md\n# 假标题\n```\n\n# 真标题\n\n正文')).toMatchObject({
      title: '真标题',
      status: null,
      summary: '正文',
    });
    expect(
      markdownMetadata('---\ntitle: |\n  多行标题\nstatus: [done]\n---\n# 后备标题'),
    ).toMatchObject({ title: '后备标题', status: null });
    expect(
      markdownMetadata('---\ntitle: A\ntitle: B\nstatus: todo\nstatus: done\n---\n# 后备'),
    ).toMatchObject({ title: '后备', status: null });
    expect(markdownMetadata('正文\n---\nstatus: done\n---').status).toBeNull();
  });
  it('changes only the status, preserving extra fields, the BOM, CRLF and the entire body', () => {
    const content =
      '\uFEFF---\r\ntitle: "待办"\r\nowner: me\r\nstatus: todo # old\r\n---\r\n\r\n正文\r\n```yaml\r\nstatus: other\r\n```';
    expect(setMarkdownStatus(content, 'done')).toBe(
      content.replace('status: todo # old', 'status: done'),
    );
    expect(setMarkdownStatus('---\ntitle: X\n---\n正文', 'doing')).toBe(
      '---\ntitle: X\nstatus: doing\n---\n正文',
    );
    expect(setMarkdownStatus('---\n---\n正文', 'todo')).toBe('---\nstatus: todo\n---\n正文');
    expect(setMarkdownStatus('\uFEFF正文\r\n', 'open')).toBe(
      '\uFEFF---\r\nstatus: open\r\n---\r\n\r\n正文\r\n',
    );
  });
  it('refuses ambiguous headers rather than removing user content', () => {
    for (const content of [
      '---\nstatus: todo\n正文',
      '---\nstatus: todo\nstatus: done\n---\n正文',
      '---\nstatus: |\n  done\n---\n正文',
      '---\nstatus: todo\n  continuation\n---\n正文',
    ])
      expect(() => setMarkdownStatus(content, 'done')).toThrow();
    const content = projectMarkdown('todo', '引号 " 与换行\n保留');
    expect(markdownMetadata(content)).toMatchObject({
      title: '引号 " 与换行\n保留',
      status: 'todo',
    });
    expect(markdownMetadata(projectMarkdown('note', '笔记')).status).toBeNull();
  });
});
