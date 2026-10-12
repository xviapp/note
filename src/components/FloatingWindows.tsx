import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CalendarDays, ExternalLink, X } from 'lucide-react';
import { api, cachedApi } from '../api';
import { useOffline } from '../connectivity';
import { createJournalRecorder } from '../journal-record';
import { flushJournalOutbox } from '../journal-outbox';
import { isUnlocked, keysVersion, subscribeKeys } from '../keyring';
import { device } from '../mobile';
import { dismissReadingOverlay } from '../mobile-back';
import { localDate, longDate, weekday } from '../../shared/journals';
import type { AuthStatus, NoteNode } from '../../shared/types';
import { AssistantPanel, type AssistantHandle } from './AssistantPanel';
import type { AssistantMode } from './AssistantWindow';
import { LockedJournalComposer } from './LockedJournal';
import { Spinner } from './Primitives';
import { QuickAppend } from './QuickAppend';

const ImageViewer = lazy(() => import('./ImageViewer'));

const close = (options: { message?: string; path?: string } = {}) =>
  void device.closeWindow(options).catch(() => window.close());

// The system Back key: close what is open inside the window, else the window.
function useBack(busy = false) {
  useEffect(() => {
    const back = (event: Event) => {
      event.preventDefault();
      if (!dismissReadingOverlay() && !busy) close();
    };
    window.addEventListener('note:native-back', back);
    return () => window.removeEventListener('note:native-back', back);
  }, [busy]);
}

// Android draws a native stand-in card until the page's own has painted.
function useReady(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    requestAnimationFrame(() => requestAnimationFrame(() => void device.finishBoot().catch(() => {})));
  }, [ready]);
}

// A device signed in before opens at once from its cached session; the server's
// answer follows (and signs it out if the session ended).
function useSignedIn() {
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');
  useEffect(() => {
    let live = true;
    void cachedApi<AuthStatus>('/api/auth/status').then((cached) => {
      if (live && cached?.authenticated) setAuth((current) => (current === 'checking' ? 'in' : current));
    });
    api<AuthStatus>('/api/auth/status')
      .then((status) => live && setAuth(status.authenticated ? 'in' : 'out'))
      // Offline: the device's session is assumed until the server says otherwise.
      .catch(() => live && setAuth('in'));
    return () => {
      live = false;
    };
  }, []);
  return auth;
}

// The sheet over the other app, as in the share window (share.css).
function Sheet({ title, detail, onClose, onInput, children }: {
  title: string;
  onInput?: () => void;
  detail?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="share-window page-window">
      <button type="button" className="share-window-scrim" aria-label="关闭" tabIndex={-1} onClick={onClose} />
      <section className="share-window-sheet" role="dialog" aria-modal="true" aria-label={title} onInput={onInput}>
        <header className="share-window-header">
          <h1>
            {title}
            {detail && <small>{detail}</small>}
          </h1>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function OpenApp({ message, path = '/', label = '打开页间' }: { message: string; path?: string; label?: string }) {
  return (
    <div className="share-window-status">
      <p>{message}</p>
      <button type="button" className="button" onClick={() => close({ path })}>
        <ExternalLink size={15} />
        {label}
      </button>
    </div>
  );
}

// 今日记: a title, text and photos for today's entry in the journal written in
// most recently. Saving hides the window at once and closes it when the server
// has the record; a failure keeps the input on this device for the next time.
export function JournalWindow() {
  const auth = useSignedIn();
  const offline = useOffline();
  const [today] = useState(localDate);
  const [journal, setJournal] = useState<NoteNode | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useSyncExternalStore(subscribeKeys, keysVersion);
  useBack(saving);
  // The journal shows from this device's last list at once, alongside the
  // session check; the server's list (and the journal chosen in settings) then
  // replaces it, except under text already typed while the shown one remains.
  const typed = useRef(false);
  useEffect(() => {
    let live = true,
      shown: NoteNode | null | undefined;
    const show = (nodes: NoteNode[]) => {
      const kept = typed.current ? nodes.find((node) => node.id === shown?.id) : undefined;
      const next = kept ?? nodes[0] ?? null;
      shown = next;
      setJournal(next);
    };
    const path = '/api/nodes?view=journals';
    void cachedApi<{ nodes: NoteNode[] }>(path).then((cached) => {
      if (live && cached && shown === undefined) show(cached.nodes);
    });
    api<{ nodes: NoteNode[] }>(path)
      .then((list) => live && show(list.nodes))
      .catch((reason: Error) => live && shown === undefined && setError(reason.message));
    return () => {
      live = false;
    };
  }, []);
  const recorder = useMemo(() => journal && createJournalRecorder(journal.id, today), [journal, today]);
  const day = `${longDate(today)} ${weekday(today)}`;
  // An encrypted journal not unlocked here still takes records; they wait on
  // this device until it is (see LockedJournalComposer).
  const [locked, setLocked] = useState(false);
  const journalId = journal?.id, keyId = journal?.key_id;
  useEffect(() => setLocked(!!keyId && !isUnlocked(keyId)), [journalId, keyId]);
  // Records kept while it was locked go out once it is unlocked here.
  useEffect(() => {
    if (!journalId || locked || auth !== 'in') return;
    void flushJournalOutbox().then((sent) => {
      if (sent) void device.notify({ message: `${sent} 条今日记已记入日记` }).catch(() => {});
    });
  }, [journalId, locked, auth]);
  useReady(auth === 'out' || journal !== undefined || !!error);
  return (
    <Sheet
      onInput={() => (typed.current = true)}
      title="今日记"
      detail={<><CalendarDays size={13} aria-hidden="true" />{day}{journal && ` · ${journal.title}`}</>}
      onClose={() => !saving && close()}
    >
      {auth === 'out' ? (
        <OpenApp message="登录页间后才能记录。" label="打开页间登录" />
      ) : journal === undefined && !error ? (
        <Spinner />
      ) : error ? (
        <p className="inline-error" role="alert">{error}</p>
      ) : !journal ? (
        <OpenApp message="还没有日记本，先在页间里新建一个。" />
      ) : locked && journal.key_id ? (
        <LockedJournalComposer
          journal={{ ...journal, key_id: journal.key_id }}
          date={today}
          onQueued={() => close({ message: `已记下，解锁「${journal.title}」后自动记入` })}
          onUnlocked={() => setLocked(false)}
        />
      ) : (
        <>
          {offline && <p className="field-hint">离线中，可以先写下</p>}
          <QuickAppend
            // The same draft as the journal's own 写今天 on this device.
            id={`journal:${journal.id}:${today}`}
            keyId={journal.key_id}
            uploadScope={journal.id}
            disabled={offline}
            expanded
            autoFocus
            label="保存"
            placeholder="记下此刻…"
            // Saving hides the window at once; photos still uploading finish first.
            onSubmit={() => {
              setSaving(true);
              void device.hideWindow().catch(() => {});
            }}
            onAppend={async (title, text, key, attachmentIds) => {
              await recorder!(title, text, key, attachmentIds);
            }}
            onSaveFailed={(message) => close({ message: `没保存成功，内容还在，再打开可继续。${message}` })}
            // A save cut off last time (the window closed or Android ended the
            // app) completes on reopening; the window stays for a new record.
            onSaved={({ resumed }) =>
              resumed
                ? void device.notify({ message: '上次的今日记已记入日记' }).catch(() => {})
                : close({ message: '已记入今日日记' })
            }
          />
        </>
      )}
    </Sheet>
  );
}

// 问青藜: the global conversation as a sheet over the other app. Opening a note
// or the settings hands over to the notebook.
export function AssistantSheet() {
  const auth = useSignedIn();
  const actions = useRef<AssistantHandle | null>(null);
  const reading = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<AssistantMode>('floating');
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  useBack();
  useReady(auth !== 'checking');
  if (auth !== 'in')
    return (
      <Sheet title="问青藜" onClose={() => close()}>
        {auth === 'checking' ? <Spinner /> : <OpenApp message="登录页间后才能和青藜对话。" label="打开页间登录" />}
      </Sheet>
    );
  return (
    <div className="page-window" ref={reading}>
      <AssistantPanel
        global
        actionsRef={actions}
        visible
        enabled
        showLauncher={false}
        centered
        mode={mode}
        onModeChange={setMode}
        selection=""
        readingRoot={reading}
        onOpen={() => {}}
        onClose={() => close()}
        onChanged={() => {}}
        onSettings={() => close({ path: '/settings/ai' })}
        onNavigate={(id) => close({ path: `/n/${id}` })}
        onImage={(src, alt) => setImage({ src, alt })}
      />
      {image && (
        <Suspense fallback={<Spinner />}>
          <ImageViewer {...image} onClose={() => setImage(null)} />
        </Suspense>
      )}
    </div>
  );
}
