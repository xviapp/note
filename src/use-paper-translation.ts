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
// Batches in flight at once: roughly a third of the time of one at a time,
// while staying well below the provider's rate limits.
const CONCURRENT_BATCHES = 3;

// Saved paragraph translations of one paper, and runs that translate them a
// batch at a time. Each batch is saved on the server as it finishes, so
// stopping or closing loses at most the batch in flight, and a later run
// continues from there. Failed batches are never retried automatically,
// since each request is a paid model call.
export function usePaperTranslation(
  nodeId: string,
  language: TranslationLanguage,
  sources: PaperBlockSource[] | null,
  // Only papers have a translation to load.
  enabled = true,
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
    if (!enabled) {
      setState('idle');
      return;
    }
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
  }, [path, language, enabled]);
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
        const queue = list.filter(
          (block) =>
            (options.refresh || !(block.hash in known.current)) &&
            !seen.has(block.hash) &&
            seen.add(block.hash),
        );
        const batches: PaperBlockSource[][] = [];
        let batch: PaperBlockSource[] = [],
          size = 0;
        for (const block of queue) {
          if (
            batch.length &&
            (size + block.text.length > PAPER_BATCH_CHARS || batch.length >= PAPER_BATCH_BLOCKS)
          ) {
            batches.push(batch);
            batch = [];
            size = 0;
          }
          batch.push(block);
          size += block.text.length;
        }
        if (batch.length) batches.push(batch);
        // A few batches run at once; the server merges their saves. The first
        // failure stops the rest from starting, and nothing is retried.
        let next = 0,
          failure: unknown = null;
        const worker = async () => {
          while (next < batches.length && !stopped.current && !failure) {
            const current = batches[next++];
            try {
              await send(current, !!options.refresh);
              // Never pay for the same batch twice in a loop.
              if (current.some((block) => !(block.hash in known.current)))
                throw new Error('部分段落没有保存译文，已暂停，请稍后继续。');
            } catch (e) {
              failure ??= e;
            }
          }
        };
        await Promise.all(Array.from({ length: CONCURRENT_BATCHES }, worker));
        if (failure) throw failure;
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
