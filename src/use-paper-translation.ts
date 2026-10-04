import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import {
  PAPER_BATCH_BLOCKS,
  PAPER_BATCH_CHARS,
  type PaperBlockSource,
  type PaperTranslation,
} from '../shared/paper-translation';
import type { TranslationLanguage } from '../shared/translation';

export type PaperTranslationState = 'loading' | 'idle' | 'running' | 'error';

// Saved paragraph translations of one paper, and a run that translates the
// missing ones a batch at a time. Each batch is saved on the server as it
// finishes, so stopping or closing loses at most the batch in flight, and a
// later run continues from there. Failed batches are never retried
// automatically, since each request is a paid model call.
export function usePaperTranslation(
  nodeId: string,
  language: TranslationLanguage,
  sources: PaperBlockSource[] | null,
) {
  const [blocks, setBlocks] = useState<Record<string, string>>({}),
    [state, setState] = useState<PaperTranslationState>('loading'),
    [error, setError] = useState('');
  const running = useRef(false),
    stopped = useRef(false),
    known = useRef<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    stopped.current = true;
    setState('loading');
    setError('');
    api<PaperTranslation>(`/api/nodes/${nodeId}/paper-translation?language=${language}`)
      .then((saved) => {
        if (!live) return;
        known.current = saved.blocks;
        setBlocks(saved.blocks);
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
  }, [nodeId, language]);
  const send = useCallback(
    async (batch: PaperBlockSource[], refresh = false) => {
      const saved = await api<PaperTranslation>(`/api/nodes/${nodeId}/paper-translation`, 'POST', {
        language,
        blocks: batch,
        ...(refresh ? { refresh } : {}),
      });
      known.current = { ...known.current, ...saved.blocks };
      setBlocks(known.current);
    },
    [nodeId, language],
  );
  const start = useCallback(async () => {
    if (!sources || running.current) return;
    running.current = true;
    stopped.current = false;
    setState('running');
    setError('');
    try {
      for (;;) {
        if (stopped.current) break;
        // Repeated paragraphs share one translation.
        const seen = new Set<string>();
        const pending = sources.filter(
          (block) =>
            !(block.hash in known.current) && !seen.has(block.hash) && seen.add(block.hash),
        );
        if (!pending.length) break;
        const batch: PaperBlockSource[] = [];
        let size = 0;
        for (const block of pending) {
          if (
            batch.length &&
            (size + block.text.length > PAPER_BATCH_CHARS || batch.length >= PAPER_BATCH_BLOCKS)
          )
            break;
          batch.push(block);
          size += block.text.length;
        }
        await send(batch);
        // Never pay for the same batch twice in a loop.
        if (batch.some((block) => !(block.hash in known.current)))
          throw new Error('部分段落没有保存译文，已暂停，请稍后继续。');
      }
      setState('idle');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    } finally {
      running.current = false;
    }
  }, [sources, send]);
  const stop = useCallback(() => {
    stopped.current = true;
  }, []);
  const retranslate = useCallback(
    async (source: PaperBlockSource) => {
      if (running.current) return;
      running.current = true;
      setState('running');
      setError('');
      try {
        await send([source], true);
        setState('idle');
      } catch (e) {
        setError((e as Error).message);
        setState('error');
      } finally {
        running.current = false;
      }
    },
    [send],
  );
  return { blocks, state, error, start, stop, retranslate };
}
