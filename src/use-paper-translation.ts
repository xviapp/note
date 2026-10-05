import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import {
  PAPER_BATCH_BLOCKS,
  PAPER_BATCH_CHARS,
  type PaperBlockSource,
  type PaperTerm,
  type PaperTranslation,
} from '../shared/paper-translation';
import type { TranslationLanguage } from '../shared/translation';

export type PaperTranslationState = 'loading' | 'idle' | 'running' | 'error';

// Saved paragraph translations of one paper, and runs that translate them a
// batch at a time. Each batch is saved on the server as it finishes, so
// stopping or closing loses at most the batch in flight, and a later run
// continues from there. Failed batches are never retried automatically,
// since each request is a paid model call.
export function usePaperTranslation(
  nodeId: string,
  language: TranslationLanguage,
  sources: PaperBlockSource[] | null,
) {
  const [blocks, setBlocks] = useState<Record<string, string>>({}),
    [glossary, setGlossary] = useState<PaperTerm[] | null>(null),
    [state, setState] = useState<PaperTranslationState>('loading'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const running = useRef(false),
    stopped = useRef(false),
    known = useRef<Record<string, string>>({}),
    terms = useRef<PaperTerm[] | null>(null);
  const path = `/api/nodes/${nodeId}/paper-translation`;
  useEffect(() => {
    let live = true;
    stopped.current = true;
    setState('loading');
    setError('');
    setNotice('');
    api<PaperTranslation>(`${path}?language=${language}`)
      .then((saved) => {
        if (!live) return;
        known.current = saved.blocks;
        terms.current = saved.glossary;
        setBlocks(saved.blocks);
        setGlossary(saved.glossary);
        setState('idle');
      })
      .catch((e) => {
        if (!live) return;
        setError((e as Error).message);
        setState('error');
      });
    return () => {
      live = false;
      stopped.current = true;
    };
  }, [path, language]);
  const send = useCallback(
    async (batch: PaperBlockSource[], refresh: boolean) => {
      const saved = await api<PaperTranslation>(path, 'POST', {
        language,
        blocks: batch,
        ...(refresh ? { refresh } : {}),
      });
      known.current = { ...known.current, ...saved.blocks };
      setBlocks(known.current);
    },
    [path, language],
  );
  // Translates `list` in batches: missing paragraphs, or all of them again
  // when refreshing (e.g. after the glossary changed).
  const run = useCallback(
    async (
      list: PaperBlockSource[],
      options: { refresh?: boolean; glossaryText?: string } = {},
    ) => {
      if (running.current) return;
      running.current = true;
      stopped.current = false;
      setState('running');
      setError('');
      setNotice('');
      try {
        // A glossary is drawn up once, before the first batch. Without one the
        // translation still goes ahead.
        if (terms.current === null && options.glossaryText) {
          try {
            const drawn = await api<PaperTranslation>(`${path}/glossary`, 'POST', {
              language,
              text: options.glossaryText,
            });
            terms.current = drawn.glossary;
            setGlossary(drawn.glossary);
          } catch (e) {
            setNotice(`术语表未生成，先按原样翻译：${(e as Error).message}`);
          }
        }
        // Repeated paragraphs share one translation.
        const seen = new Set<string>();
        let queue = list.filter(
          (block) =>
            (options.refresh || !(block.hash in known.current)) &&
            !seen.has(block.hash) &&
            seen.add(block.hash),
        );
        while (queue.length && !stopped.current) {
          const batch: PaperBlockSource[] = [];
          let size = 0;
          for (const block of queue) {
            if (
              batch.length &&
              (size + block.text.length > PAPER_BATCH_CHARS || batch.length >= PAPER_BATCH_BLOCKS)
            )
              break;
            batch.push(block);
            size += block.text.length;
          }
          await send(batch, !!options.refresh);
          // Never pay for the same batch twice in a loop.
          if (batch.some((block) => !(block.hash in known.current)))
            throw new Error('部分段落没有保存译文，已暂停，请稍后继续。');
          queue = queue.slice(batch.length);
        }
        setState('idle');
      } catch (e) {
        setError((e as Error).message);
        setState('error');
      } finally {
        running.current = false;
      }
    },
    [path, language, send],
  );
  const stop = useCallback(() => {
    stopped.current = true;
  }, []);
  const saveGlossary = useCallback(
    async (list: PaperTerm[]) => {
      const saved = await api<PaperTranslation>(`${path}/glossary`, 'PUT', {
        language,
        terms: list,
      });
      terms.current = saved.glossary;
      setGlossary(saved.glossary);
      return saved.glossary ?? [];
    },
    [path, language],
  );
  return { blocks, glossary, state, error, notice, run, stop, saveGlossary, sources };
}
