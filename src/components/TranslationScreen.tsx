import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { NoteDetail } from '../../shared/types';
import { usePaperSession } from '../use-paper-session';
import { useAnnotations } from '../annotations';
import { useOffline } from '../connectivity';
import { AssistantPanel, type AssistantHandle } from './AssistantPanel';
import type { AssistantMode } from './AssistantWindow';
import { Empty, Spinner } from './Primitives';
import { FileText } from 'lucide-react';

const CompareView = lazy(() => import('./CompareView'));

// The window opened for a second screen: a paper's translation alone, kept
// on the same paragraph as the reading window. Qingli works here too.
export default function TranslationScreen({ id }: { id: string }) {
  const [note, setNote] = useState<NoteDetail | null>(null),
    [error, setError] = useState('');
  const offline = useOffline();
  useEffect(() => {
    api<NoteDetail>(`/api/nodes/${id}`)
      .then((detail) => {
        if (!detail.arxiv_id) throw new Error('只有导入的 arXiv 论文可以单独打开译文。');
        setNote(detail);
        document.title = `${detail.title}（译文）`;
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);
  const session = usePaperSession(note, { onFinished: () => {}, onExported: () => {} });
  const annotations = useAnnotations(note?.id, !!note);
  const assistant = useRef<AssistantHandle>(null),
    readingRoot = useRef<HTMLDivElement>(null);
  const [assistantOpen, setAssistantOpen] = useState(false),
    [mode, setMode] = useState<AssistantMode>('floating'),
    [selection, setSelection] = useState('');
  const quote = (text: string) => {
    if (!assistant.current) return '青藜尚未就绪，请稍后重试。';
    const failed = assistant.current.addQuote(text);
    if (failed) return failed;
    setAssistantOpen(true);
  };
  if (error)
    return (
      <Empty icon={<FileText />} title="无法打开译文">
        {error}
      </Empty>
    );
  if (!note) return <Spinner label="正在打开译文…" />;
  return (
    <div ref={readingRoot} className="translation-screen">
      <Suspense fallback={<Spinner label="正在打开译文…" />}>
        <CompareView
          note={note}
          session={session}
          only="translation"
          onClose={() => window.close()}
          onChanged={() => {}}
          onQuote={(text) => {
            setSelection(text);
            return quote(text);
          }}
          annotations={annotations}
          offline={offline}
        />
      </Suspense>
      <AssistantPanel
        actionsRef={assistant}
        node={note}
        visible={assistantOpen}
        enabled
        mode={mode === 'docked' ? 'floating' : mode}
        onModeChange={setMode}
        selection={selection}
        readingRoot={readingRoot}
        onClose={() => setAssistantOpen(false)}
        onOpen={() => setAssistantOpen(true)}
        onChanged={() => {}}
        onSettings={() => window.open('/settings/ai', '_blank')}
        onNavigate={() => {}}
        onImage={() => {}}
        annotationCount={annotations.list.length}
      />
    </div>
  );
}
