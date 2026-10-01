import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { ReadingPosition, ReadingState } from '../shared/types';

// Each update compares the last confirmed cloud version. An old offline position
// never wins over a newer position from another device.
export function useReading(id: string) {
  const [initial, setInitial] = useState<ReadingPosition | null>(null);
  const state = useRef({
    id,
    version: 0,
    position: {} as ReadingPosition,
    dirty: false,
    generation: 0,
    busy: false,
    ready: false,
  });
  const persist = () => {
    try {
      localStorage.setItem(`reading:${id}`, JSON.stringify(state.current));
    } catch {
      /* Storage may be disabled. */
    }
  };
  const flush = useCallback(async () => {
    const current = state.current;
    if (!current.ready || !current.dirty || current.busy) return;
    current.busy = true;
    const generation = current.generation;
    try {
      const saved = await api<ReadingState>(`/api/nodes/${id}/reading`, 'PUT', {
        version: current.version,
        position: current.position,
      });
      current.version = saved.version;
      if (generation === current.generation) current.dirty = false;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'READING_CONFLICT') {
        // Discard the queued position. Only a subsequent foreground reading event
        // can create a new update after learning the current cloud revision.
        const latest = await api<ReadingState>(`/api/nodes/${id}/reading`).catch(() => null);
        current.dirty = false;
        if (latest) current.version = latest.version;
      }
    } finally {
      current.busy = false;
      persist();
    }
  }, [id]);
  useEffect(() => {
    let active = true;
    void api<ReadingState>(`/api/nodes/${id}/open`, 'POST', {})
      .then((cloud) => {
        if (!active) return;
        let cached: typeof state.current | null = null;
        try {
          cached = JSON.parse(localStorage.getItem(`reading:${id}`) || 'null');
        } catch {
          /* Ignore corrupt local data. */
        }
        const resumeLocal = cached?.dirty && cached.version === cloud.version;
        state.current = {
          id,
          version: cloud.version,
          position: resumeLocal ? cached!.position : cloud.position,
          dirty: !!resumeLocal,
          generation: 0,
          busy: false,
          ready: true,
        };
        setInitial(state.current.position);
      })
      .catch(() => {
        if (active) setInitial({});
      });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void flush();
    }, 30_000);
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', flush);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', flush);
      void flush();
    };
  }, [id, flush]);
  const update = useCallback(
    (position: ReadingPosition) => {
      if (!state.current.ready || document.visibilityState !== 'visible') return;
      state.current.position = position;
      state.current.generation++;
      state.current.dirty = true;
      persist();
    },
    [id],
  );
  return { initial, update, flush };
}
