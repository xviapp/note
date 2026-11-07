import { useEffect, useState, type FormEvent } from 'react';
import { BLOG_SLUG_LIMIT, BLOG_SUMMARY_LIMIT } from '../../shared/blog';
import type { BlogNoteStatus, BlogSummarySource, NoteDetail } from '../../shared/types';
import { api } from '../api';
import { Modal } from './Primitives';

// Set once the server says no folder is chosen, so that notes stop asking.
// Settings clears it when a folder is chosen (see BlogSettings).
let knownDisabled = false;
export const blogFolderChanged = () => {
  knownDisabled = false;
};

// The ⋯ menu item and dialog for publishing a note in the blog folder. Other
// notes show neither.
export function useBlogPublish(note: NoteDetail | null, disabled: boolean) {
  const [status, setStatus] = useState<{ id: string; value: BlogNoteStatus } | null>(null);
  const [open, setOpen] = useState(false);
  const id = note?.id,
    revision = note?.revision,
    checkable = note?.kind === 'markdown' && !note.key_id;
  useEffect(() => {
    if (!id || !checkable || disabled || knownDisabled) return;
    let live = true;
    api<BlogNoteStatus>(`/api/blog/posts/${id}`)
      .then((value) => {
        if (!value.enabled) knownDisabled = true;
        if (live) setStatus({ id, value });
      })
      // The note stays usable; publishing is simply not offered.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, revision, checkable, disabled]);
  useEffect(() => setOpen(false), [id]);
  const current = status && status.id === id ? status.value : null;
  if (!note || !current || !(current.eligible || current.post)) return { menu: null, dialog: null };
  return {
    menu: (
      <button disabled={disabled} onClick={() => setOpen(true)}>
        {!current.post ? '发布到博客…' : current.post.outdated ? '更新博客文章…' : '博客文章…'}
      </button>
    ),
    dialog: open ? (
      <PublishDialog
        note={note}
        status={current}
        onChanged={(value) => setStatus({ id: note.id, value })}
        onClose={() => setOpen(false)}
      />
    ) : null,
  };
}

const SUMMARY_SOURCES: Record<BlogSummarySource, string> = {
  ai: '由青藜根据已发布的版本生成，可以修改。',
  manual: '手动填写，更新文章时会保留。清空后保存可改回正文开头。',
  excerpt: '摘自正文开头。',
};

function PublishDialog({
  note,
  status,
  onChanged,
  onClose,
}: {
  note: NoteDetail;
  status: BlogNoteStatus;
  onChanged: (status: BlogNoteStatus) => void;
  onClose: () => void;
}) {
  const post = status.post;
  const [slug, setSlug] = useState(post?.slug ?? status.suggestedSlug);
  const saved = post?.summary ?? '';
  const [summary, setSummary] = useState(saved);
  // The server stores it with whitespace collapsed.
  const edited = !!post && summary.replace(/\s+/g, ' ').trim() !== saved;
  const [busy, setBusy] = useState<'' | 'publish' | 'summary' | 'generate' | 'unpublish'>(''),
    [error, setError] = useState('');
  const run = async (task: typeof busy, action: () => Promise<BlogNoteStatus>, finished: boolean) => {
    setBusy(task);
    setError('');
    try {
      const next = await action();
      onChanged(next);
      // Show what was stored, even when it equals the last saved text.
      setSummary(next.post?.summary ?? '');
      if (finished) onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };
  const publish = (event: FormEvent) => {
    event.preventDefault();
    void run(
      'publish',
      () =>
        api<BlogNoteStatus>(`/api/blog/posts/${note.id}`, 'PUT', {
          revision: note.revision,
          slug: slug.trim(),
          // An edited summary goes with the update instead of being replaced.
          ...(edited ? { summary } : {}),
        }),
      false,
    );
  };
  const unpublish = () =>
    run('unpublish', async () => {
      await api(`/api/blog/posts/${note.id}`, 'DELETE');
      return api<BlogNoteStatus>(`/api/blog/posts/${note.id}`);
    }, true);
  return (
    <Modal title={post ? '博客文章' : '发布到博客'} onClose={() => !busy && onClose()}>
      <form className="form-stack blog-publish" onSubmit={publish}>
        <fieldset disabled={!!busy}>
          {!post && (
            <p className="field-hint">
              发布后，任何人都能在博客上看到这篇笔记当前保存的版本，以及正文引用的图片和附件。之后的修改不会自动上线。配置了 DeepSeek 时，青藜会根据这个版本生成摘要。
            </p>
          )}
          {post && !post.online && (
            <p className="inline-error" role="status">
              这篇文章目前没有显示在博客上：笔记不在文章或项目文件夹里。移进去或在设置里选作页面后会恢复显示。
            </p>
          )}
          {post?.online && (
            <p className="field-hint" role="status">
              {post.outdated
                ? '博客上是发布时的版本，笔记之后的修改还没有上线。'
                : '博客上已是笔记的当前版本。'}
            </p>
          )}
          <label>
            链接
            <input
              value={slug}
              maxLength={BLOG_SLUG_LIMIT}
              autoCapitalize="none"
              spellCheck={false}
              required={!!post}
              onChange={(event) => setSlug(event.target.value)}
            />
          </label>
          <p className="field-hint">
            文章地址的最后一段，可用文字、数字和连字符。修改后旧链接会失效。
            {post?.url && post.online && (
              <>
                {' '}
                <a href={post.url} target="_blank" rel="noopener noreferrer">
                  查看文章
                </a>
              </>
            )}
          </p>
          {post && (
            <>
              <label>
                摘要
                <textarea
                  rows={3}
                  value={summary}
                  maxLength={BLOG_SUMMARY_LIMIT}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </label>
              <p className="field-hint">
                显示在文章列表、搜索结果和 RSS 里。
                {edited ? '修改还没有保存，更新文章时会一起保存。' : SUMMARY_SOURCES[post.summarySource]}
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    void run('generate', () => api<BlogNoteStatus>(`/api/blog/posts/${note.id}/summary`, 'POST'), false)
                  }
                >
                  {busy === 'generate' ? '正在生成…' : '重新生成'}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={!edited}
                  onClick={() =>
                    void run('summary', () => api<BlogNoteStatus>(`/api/blog/posts/${note.id}/summary`, 'PUT', { summary }), false)
                  }
                >
                  {busy === 'summary' ? '正在保存…' : '保存摘要'}
                </button>
              </div>
            </>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            {post && (
              <button type="button" className="button danger" onClick={() => void unpublish()}>
                取消发布
              </button>
            )}
            <button type="button" className="button" onClick={onClose}>
              关闭
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={!!post && !post.outdated && slug.trim() === post.slug}
            >
              {busy === 'publish' ? '正在发布…' : post ? '更新到当前版本' : '发布'}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
