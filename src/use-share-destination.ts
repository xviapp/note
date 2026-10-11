import { useEffect, useState } from 'react';
import type { ShareSettings } from '../shared/types';
import { api } from './api';

export const shareDestinationLabel = (settings: ShareSettings) =>
  settings.breadcrumbs.map((part) => part.title).join(' / ') || '根目录';

interface Destination {
  parentId: string | null;
  title: string;
  path: ShareSettings['breadcrumbs'];
}

// Each incoming item gets its own selection. A failed lookup never silently
// changes the destination to the root; callers offer an explicit retry.
export function useShareDestination(scope: string | null, enabled: boolean) {
  const [state, setState] = useState<{
    scope: string | null;
    destination: Destination | null;
    error: string;
  }>({ scope, destination: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const destination = state.scope === scope ? state.destination : null;
  const error = state.scope === scope ? state.error : '';
  useEffect(() => {
    if (!scope || !enabled || destination) return;
    let live = true;
    setState({ scope, destination: null, error: '' });
    api<ShareSettings>('/api/share/settings')
      .then((settings) => {
        if (live) setState({
          scope,
          destination: {
            parentId: settings.parentId,
            title: shareDestinationLabel(settings),
            path: settings.breadcrumbs,
          },
          error: '',
        });
      })
      .catch((reason) => {
        if (live) setState({
          scope, destination: null,
          error: reason instanceof Error ? reason.message : '无法读取保存位置，请重试。',
        });
      });
    return () => { live = false; };
  }, [scope, enabled, destination, attempt]);
  return {
    destination,
    parent: destination?.parentId ?? null,
    error,
    retry: () => setAttempt((value) => value + 1),
    select: (parentId: string | null, title: string) => {
      if (destination) setState({ scope, destination: { ...destination, parentId, title }, error: '' });
    },
  };
}
