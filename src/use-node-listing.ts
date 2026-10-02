import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { NoteNode } from '../shared/types';

export type NodeListing = { nodes: NoteNode[]; nextOffset: number | null };
type CachedListing = { listing: NodeListing; pages: number; refresh: number };
export type ListingCache = Map<string, CachedListing>;
// Listings are scoped to the signed-in Notebook, never persisted with private data.
// Returning to a page shows the loaded listing; library changes, foregrounding and
// reconnecting advance `refresh`, which revalidates it in place.
export const ListingCacheContext = createContext<ListingCache | null>(null);
// Opening any note reorders recent visits without a library change.
const alwaysRevalidate = (query: string) => query === 'view=recent';

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
      setState({ query, listing: saved.listing, loading: false, error: '' });
      return () => {
        generation.current++;
      };
    }
    const pages = current.current.pages;
    pending.current = true;
    setState({ query, listing: current.current.listing, loading: true, error: '' });
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
        cache?.set(query, { listing, pages: loaded, refresh });
        setState({ query, listing, loading: false, error: '' });
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
      if (saved) cache?.set(query, { ...saved, listing, pages: current.current.pages });
      setState({ query, listing, loading: false, error: '' });
    } catch (error) {
      if (run === generation.current)
        setState((value) => ({ ...value, loading: false, error: (error as Error).message }));
    } finally {
      if (run === generation.current) pending.current = false;
    }
  };
  return {
    listing: state.query === query ? state.listing : null,
    loading: state.query !== query || state.loading,
    error: state.query === query ? state.error : '',
    more,
  };
}
