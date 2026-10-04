import { useCallback, useEffect, useState } from 'react';

type Toast = { key: number; message: string; undo?: () => Promise<void> };

// A short status line at the bottom: successes fade on their own, and an
// action that can be undone (move, delete) stays a little longer with 撤销.
// Errors use the notebook's persistent notice instead.
export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.undo ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  const show = useCallback((message: string, undo?: () => Promise<void>) => {
    setToast({
      key: Date.now(),
      message,
      undo:
        undo &&
        (async () => {
          setToast(null);
          await undo();
        }),
    });
  }, []);
  const element = toast && (
    <div key={toast.key} className="move-toast" role="status">
      <span>{toast.message}</span>
      {toast.undo && (
        <button className="text-button" onClick={() => void toast.undo?.()}>
          撤销
        </button>
      )}
    </div>
  );
  return { show, element };
}
