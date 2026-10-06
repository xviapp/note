import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteDetail } from '../shared/types';
import { saveChildNote } from './child-note';
import {
  isTranslationLanguage,
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from '../shared/translation';
import { GLOSSARY_SOURCE_CHARS, type PaperBlockSource } from '../shared/paper-translation';
import { applyTranslation, blockHash, paperBlocks } from './paper-blocks';
import { paperMarkdown } from './paper-markdown';
import { usePaperTranslation } from './use-paper-translation';
import { preparePaper } from './components/PaperView';

const LANGUAGE_KEY = 'paper-translation-language',
  AUTO_EXPORT_KEY = 'paper-auto-export';
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage can be unavailable; the choice still applies now. */
  }
};

export type ExportState = { state: 'saving' | 'done' | 'error'; text: string } | null;

// A paper's whole-text translation, owned by the note page rather than the
// comparison view, so a run keeps going after the view is closed. The
// paragraphs come from an off-screen copy of the article, in the same order
// the comparison view pairs them.
export function usePaperSession(
  note: NoteDetail | null,
  { onFinished, onExported }: { onFinished: (message: string) => void; onExported: () => void },
) {
  const paper = note?.arxiv_id ? note : null;
  const [language, setLanguageState] = useState<TranslationLanguage>(() => {
    const saved = stored(LANGUAGE_KEY);
    return isTranslationLanguage(saved) ? saved : 'zh-CN';
  });
  const setLanguage = (value: TranslationLanguage) => {
    setLanguageState(value);
    store(LANGUAGE_KEY, value);
  };
  const [autoExport, setAutoExportState] = useState(() => stored(AUTO_EXPORT_KEY) !== 'off');
  const setAutoExport = (value: boolean) => {
    setAutoExportState(value);
    store(AUTO_EXPORT_KEY, value ? 'on' : 'off');
  };
  const [sources, setSources] = useState<PaperBlockSource[] | null>(null),
    [glossaryText, setGlossaryText] = useState('');
  const paperId = paper?.id,
    paperContent = paper?.content;
  useEffect(() => {
    setSources(null);
    if (!paper) return;
    let live = true;
    // Paragraphs and their hashes are only needed for translation; work them out
    // once the article is on screen instead of holding up its first paint.
    const prepare = () => {
      const blocks = paperBlocks(preparePaper(paper).fragment);
      setGlossaryText(
        [
          paper.title,
          ...blocks
            .filter(
              (b) => b.element.matches('h1,h2,h3,h4,h5,h6') || b.element.closest('.ltx_abstract'),
            )
            .map((b) => b.text),
        ]
          .join('\n')
          .slice(0, GLOSSARY_SOURCE_CHARS),
      );
      void Promise.all(blocks.map((block) => blockHash(block.text))).then((hashes) => {
        if (live)
          setSources(blocks.map((block, index) => ({ hash: hashes[index], text: block.text })));
      });
    };
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(() => live && prepare(), { timeout: 2000 })
      : window.setTimeout(() => live && prepare(), 300);
    return () => {
      live = false;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
    // The paragraphs depend on the article only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, paperContent]);
  const translation = usePaperTranslation(paperId ?? '', language, sources, !!paper);
  const total = sources ? new Set(sources.map((block) => block.hash)).size : 0;
  const done = sources
    ? new Set(sources.filter((block) => block.hash in translation.blocks).map((b) => b.hash)).size
    : 0;
  const running = translation.state === 'running';

  const [exported, setExported] = useState<ExportState>(null);
  const latest = useRef({ translation, sources, language, paper, onExported });
  latest.current = { translation, sources, language, paper, onExported };
  // Saves the translated article as a Markdown child note of the paper, one
  // per language: a later save updates it as a new version. Returns success.
  const exportNote = useCallback(async () => {
    const { translation, sources, language, paper, onExported } = latest.current;
    if (!paper || !sources) return false;
    const fragment = preparePaper(paper).fragment;
    paperBlocks(fragment).forEach((block, index) => {
      const text = translation.blocks[sources[index]?.hash];
      if (text) applyTranslation(block, text);
    });
    const root = document.createElement('div');
    root.appendChild(fragment);
    const title = `${paper.title}（${TRANSLATION_LANGUAGES[language]}译文）`;
    const content = `> 译自《${paper.title}》：${paper.url ?? ''}\n\n${paperMarkdown(root)}`;
    setExported({ state: 'saving', text: '正在保存为子笔记…' });
    try {
      const existing = await saveChildNote(paper.id, title, content);
      setExported({
        state: 'done',
        text: `${existing ? '已更新' : '已保存为'}子笔记「${title}」，旧内容可在版本历史中找回。`,
      });
      onExported();
      return true;
    } catch (e) {
      setExported({ state: 'error', text: `未保存为子笔记：${(e as Error).message}` });
      return false;
    }
  }, []);

  // A full run ends with a notice, and saves the child note when set to.
  const fullRun = useRef(false);
  const runAll = () => {
    if (!sources) return;
    fullRun.current = true;
    setExported(null);
    void translation.run(sources, { glossaryText });
  };
  const runList = (list: PaperBlockSource[], refresh = false) =>
    void translation.run(list, { glossaryText, refresh });
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    if (!fullRun.current || running || !paper) return;
    if (translation.state === 'error') fullRun.current = false;
    else if (translation.state === 'idle') {
      fullRun.current = false;
      if (done !== total) return; // Stopped part way.
      if (!autoExport) {
        finished.current(`《${paper.title}》全文翻译完成`);
        return;
      }
      void exportNote().then((saved) =>
        finished.current(
          saved
            ? `《${paper.title}》全文翻译完成，已保存为子笔记`
            : `《${paper.title}》全文翻译完成，保存子笔记未成功`,
        ),
      );
    }
    // Reacts to a run finishing.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [running, translation.state, done, total]);

  return {
    paper,
    language,
    setLanguage,
    sources,
    translation,
    total,
    done,
    running,
    autoExport,
    setAutoExport,
    exported,
    exportNote,
    runAll,
    runList,
  };
}
export type PaperSession = ReturnType<typeof usePaperSession>;
