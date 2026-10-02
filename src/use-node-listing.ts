import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { NoteNode } from '../shared/types';

export type NodeListing = { nodes: NoteNode[]; nextOffset: number | null };

// Refresh the pages the reader has already opened, without blanking the list.
// A generation also prevents a late "load more" response from undoing a refresh.
export function useNodeListing(query: string, refresh: number) {
  const current = useRef<{ query: string; listing: NodeListing | null; pages: number }>({
    query,
    listing: null,
    pages: 1,
  });
  const generation = useRef(0);
  const pending = useRef(false);
  const [state, setState] = useState({
    query,
    listing: null as NodeListing | null,
    loading: true,
    error: '',
  });
  useEffect(() => {
    const run = ++generation.current;
    if (current.current.query !== query) current.current = { query, listing: null, pages: 1 };
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
  }, [query, refresh]);

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
