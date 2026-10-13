import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, cachedApi } from './api';
import type { NoteNode } from '../shared/types';
import { prefetchNotes } from './prefetch';
import { applyChanges, rememberNodes, useOptimisticVersion } from './optimistic';

export type NodeListing = { nodes: NoteNode[]; nextOffset: number | null };
type CachedListing = { listing: NodeListing; pages: number; refresh: number };
export type ListingCache = Map<string, CachedListing>;
// Listings are scoped to the signed-in Notebook, never persisted with private data.
// Returning to a page shows the loaded listing; library changes, foregrounding and
// reconnecting advance `refresh`, which revalidates it in place.
export const ListingCacheContext = createContext<ListingCache | null>(null);
// Opening any note reorders recent visits without a library change.
const alwaysRevalidate = (query: string) => query === 'view=recent' || query === 'view=continue';

// Several views can show the same folder (the sidebar and the page). The one that
// has loaded more pages for the current revision keeps the shared entry.
function remember(cache: ListingCache | null, query: string, entry: CachedListing) {
  const saved = cache?.get(query);
  if (saved && saved.refresh === entry.refresh && saved.pages > entry.pages) return;
  cache?.set(query, entry);
}

// Refresh the pages the reader has already opened, without blanking the list.
// A generation also prevents a late "load more" response from undoing a refresh.
export function useNodeListing(query: string, refresh: number) {
  const cache = useContext(ListingCacheContext);
  const cached = cache?.get(query);
  const current = useRef<{ query: string; listing: NodeListing | null; pages: number }>({
    query,
    listing: cached?.listing ?? null,
    pages: cached?.pages ?? 1,
  });
  const generation = useRef(0);
  const pending = useRef(false);
  const [state, setState] = useState({
    query,
    listing: cached?.listing ?? null,
    loading: !cached,
    error: '',
  });
  useEffect(() => {
    const run = ++generation.current;
    const saved = cache?.get(query);
    if (current.current.query !== query)
      current.current = { query, listing: saved?.listing ?? null, pages: saved?.pages ?? 1 };
    if (saved && saved.refresh === refresh && !alwaysRevalidate(query)) {
      // An interrupted fetch or "load more" no longer owns the pending flag.
      pending.current = false;
      setState({ query, listing: saved.listing, loading: false, error: '' });
      return () => {
        // A generation counter, not an element: bumping it voids late responses.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        generation.current++;
      };
    }
    const pages = current.current.pages;
    pending.current = true;
    setState({ query, listing: current.current.listing, loading: true, error: '' });
    // A cold start shows the device's last snapshot until the server answers.
    if (!current.current.listing)
      void cachedApi<NodeListing>(`/api/nodes?${query}`)
        .then((saved) => {
          if (!saved || run !== generation.current || current.current.listing) return;
          setState((value) => (value.listing ? value : { ...value, listing: saved }));
        })
        .catch(() => {});
    void (async () => {
      try {
        const nodes = new Map<string, NoteNode>();
        let nextOffset: number | null = null;
        let loaded = 0;
        do {
          const result: NodeListing = await api(
            `/api/nodes?${query}${nextOffset === null ? '' : `&offset=${nextOffset}`}`,
          );
          if (run !== generation.current) return;
          for (const node of result.nodes) nodes.set(node.id, node);
          nextOffset = result.nextOffset;
          loaded++;
        } while (nextOffset !== null && loaded < pages);
        const listing = { nodes: [...nodes.values()], nextOffset };
        current.current = { query, listing, pages: loaded };
        remember(cache, query, { listing, pages: loaded, refresh });
        rememberNodes(listing.nodes);
        setState({ query, listing, loading: false, error: '' });
        // Opening one of them then shows its text at once.
        prefetchNotes(listing.nodes);
      } catch (error) {
        if (run === generation.current)
          setState({
            query,
            listing: current.current.listing,
            loading: false,
            error: (error as Error).message,
          });
      } finally {
        if (run === generation.current) pending.current = false;
      }
    })();
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [query, refresh, cache]);

  const more = async () => {
    const previous = current.current;
    if (pending.current || previous.query !== query || previous.listing?.nextOffset == null) return;
    const run = generation.current;
    pending.current = true;
    setState((value) => ({ ...value, loading: true, error: '' }));
    try {
      const result = await api<NodeListing>(
        `/api/nodes?${query}&offset=${previous.listing.nextOffset}`,
      );
      if (run !== generation.current) return;
      const nodes = new Map(
        [...previous.listing.nodes, ...result.nodes].map((node) => [node.id, node]),
      );
      const listing = { nodes: [...nodes.values()], nextOffset: result.nextOffset };
      current.current = { query, listing, pages: previous.pages + 1 };
      const saved = cache?.get(query);
      if (saved) remember(cache, query, { ...saved, listing, pages: current.current.pages });
      setState({ query, listing, loading: false, error: '' });
    } catch (error) {
      if (run === generation.current)
        setState((value) => ({ ...value, loading: false, error: (error as Error).message }));
    } finally {
      if (run === generation.current) pending.current = false;
    }
  };
  // Changes not confirmed yet (src/optimistic.ts) show over what was loaded.
  const pendingChanges = useOptimisticVersion();
  const loadedListing = state.query === query ? state.listing : null;
  const shown = useMemo(
    () => loadedListing && { ...loadedListing, nodes: applyChanges(query, loadedListing.nodes) },
    // pendingChanges is the version of the changes applyChanges reads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [loadedListing, query, pendingChanges],
  );
  return {
    listing: shown,
    loading: state.query !== query || state.loading,
    error: state.query === query ? state.error : '',
    more,
  };
}
