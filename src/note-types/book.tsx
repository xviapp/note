import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { variantOf, type NoteNode } from '../../shared/types';
import { BookCard, BookForm } from '../components/BookPanel';
import {
  BookPageList,
  BookPageNav,
  DiscussionMenu,
  PageAskBar,
  PageInsights,
} from '../components/BookPageView';
import type { TypeContext, TypeView } from './view';

// A book: its details card and pages in page order instead of a plain list.
export function useBookView(ctx: TypeContext): TypeView | null {
  const [editing, setEditing] = useState(false);
  const { note } = ctx;
  if (!note || variantOf(note) !== 'book' || !note.book) return null;
  return {
    menu: (
      <button disabled={ctx.offline} onClick={() => setEditing(true)}>
        书籍资料
      </button>
    ),
    children: !ctx.editing && (
      <section className="children-section is-folder" aria-label="下级笔记">
        <BookCard
          book={note.book}
          offline={ctx.offline}
          onEdit={() => setEditing(true)}
          onChanged={() => {
            ctx.onChanged();
            ctx.refresh();
          }}
          onOpen={ctx.onOpen}
          onError={ctx.onError}
        />
        <BookPageList
          bookId={note.id}
          refresh={ctx.refreshKey}
          onOpen={ctx.onOpen}
          onNavigate={ctx.onNavigate}
        />
      </section>
    ),
    dialogs: editing && (
      <BookForm
        note={note}
        onClose={() => setEditing(false)}
        onSaved={() => {
          ctx.onChanged();
          ctx.refresh();
        }}
      />
    ),
  };
}

type Discussion = {
  // null: a draft, created by its first question.
  id: string | null;
  initial?: { content: string; quote?: string };
  quote?: string;
};

// A page of a book: 青藜's summary and questions, page turning, an ask bar,
// and 青藜 holding the page's discussions (one conversation each).
export function useBookPageView(ctx: TypeContext): TypeView | null {
  const { note } = ctx;
  const info = note?.book_page;
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  useEffect(() => setDiscussion(null), [note?.id]);
  if (!note || variantOf(note) !== 'book-page' || !info || !note.book) return null;
  const open = (next: Discussion) => {
    setDiscussion(next);
    ctx.openAssistant();
  };
  const ask = async (question: string, quote?: string) => {
    try {
      const created = await api<NoteNode>(`/api/nodes/${note.id}/discussions`, 'POST', {
        title: question,
      });
      open({ id: created.id, initial: { content: question, quote } });
      ctx.refresh();
    } catch (error) {
      ctx.onError(error);
    }
  };
  const organize = async (id: string, force = false): Promise<void> => {
    try {
      const result = await api<{ note: NoteNode; updated: boolean }>(
        `/api/nodes/${id}/organize`,
        'POST',
        { force },
      );
      ctx.onNotice?.(
        result.updated
          ? `已更新「${result.note.title}」中的这一节`
          : `已追加到「${result.note.title}」`,
      );
      ctx.onChanged();
      ctx.refresh();
    } catch (error) {
      const edited = error instanceof ApiError && error.code === 'BOOK_SECTION_EDITED';
      if (!edited) return ctx.onError(error);
      if (
        await ctx.confirm(
          '这一节你修改过',
          '再次整理会用新的结论替换你在读书笔记里对这一节的修改，旧内容可在版本历史中找回。',
          '覆盖',
        )
      )
        return organize(id, true);
    }
  };
  const current = discussion?.id
    ? info.discussions.find((item) => item.id === discussion.id)
    : undefined;
  return {
    toolbar: !ctx.editing && <BookPageNav info={info} onNavigate={ctx.onNavigate} toolbar />,
    below: !ctx.editing && (
      <>
        <PageInsights
          id={note.id}
          info={info}
          offline={ctx.offline}
          onAsk={(question) => void ask(question)}
          onOpenDiscussion={(id) => open({ id })}
          onNavigate={ctx.onNavigate}
          onUpdated={ctx.refresh}
          onError={ctx.onError}
        />
        <BookPageNav info={info} onNavigate={ctx.onNavigate} />
      </>
    ),
    footer: !ctx.editing && !ctx.assistantOpen && (
      <PageAskBar offline={ctx.offline} onAsk={(question) => void ask(question)} />
    ),
    // The page's only attachment is its photo, shown above the text.
    hideAttachments: !ctx.editing,
    addQuote: (text) => {
      open({ id: null, quote: text });
      return undefined;
    },
    assistant: {
      key: discussion?.id ?? `draft:${discussion?.quote ?? ''}`,
      node: discussion?.id
        ? { ...note, id: discussion.id, title: current?.title ?? '讨论' }
        : undefined,
      title: current?.title ?? '新讨论',
      fileNode: note,
      context: (
        <>
          <span>
            已带上：《{note.book.title}》{note.book.role_prompt ? ' · 书籍角色' : ''} · {note.title}
            原文{info.summary ? '与摘要' : ''}
          </span>
          {discussion?.id && (
            <button
              className="text-button"
              disabled={ctx.offline}
              onClick={() => void organize(discussion.id!)}
            >
              整理到笔记
            </button>
          )}
        </>
      ),
      headerActions: (
        <DiscussionMenu
          info={info}
          current={discussion?.id ?? null}
          onPick={(id) => open({ id })}
        />
      ),
      initialPrompt: discussion?.initial,
      initialQuote: discussion?.quote,
      onDraftSend: discussion?.id
        ? undefined
        : (content, quote) => void ask(content, quote || undefined),
      onReplied: ctx.refresh,
      // The page asks from its questions, discussions and ask bar instead.
      showLauncher: false,
      noGlobal: true,
    },
  };
}
