import {
  Archive,
  ChevronRight,
  Download,
  HardDrive,
  Info,
  LockKeyhole,
  Palette,
  Server,
  Share2,
  ShieldCheck,
  Type,
  UploadCloud,
} from 'lucide-react';
import { useOutboxCount } from '../outbox';
import { nativeServer } from '../server';
import { QingliIcon } from './QingliIcon';
import { settingsTitles, type SettingsSection } from '../navigation';

const groups = [
  {
    title: '偏好',
    items: [
      { key: 'theme', icon: Palette },
      { key: 'reading', icon: Type },
      { key: 'ai', icon: QingliIcon },
    ],
  },
  {
    title: '资料',
    items: [
      { key: 'offline', icon: Download },
      { key: 'share', icon: Share2 },
      { key: 'outbox', icon: UploadCloud },
      { key: 'backup', icon: Archive },
      { key: 'storage', icon: HardDrive },
      { key: 'encryption', icon: LockKeyhole },
    ],
  },
  {
    title: '应用',
    items: [
      { key: 'server', icon: Server },
      { key: 'account', icon: ShieldCheck },
      { key: 'about', icon: Info },
    ],
  },
] as const;

export function SettingsIndex({ onOpen }: { onOpen: (section: SettingsSection) => void }) {
  const waiting = useOutboxCount();
  return (
    <section className="collection-page settings-page settings-index">
      <h1>设置</h1>
      {groups.map((group) => (
        <section className="settings-group" key={group.title} aria-label={group.title}>
          <h2>{group.title}</h2>
          <div className="settings-entries">
            {group.items
              .filter(
                ({ key }) =>
                  (key !== 'server' || nativeServer) && (key !== 'backup' || !nativeServer),
              )
              .map(({ key, icon: Icon }) => (
                <button key={key} className="settings-entry" onClick={() => onOpen(key)}>
                  <Icon size={22} />
                  <span>{settingsTitles[key]}</span>
                  {key === 'outbox' && waiting > 0 && (
                    <span className="settings-badge" aria-label={`${waiting} 条`}>{waiting}</span>
                  )}
                  <ChevronRight size={18} />
                </button>
              ))}
          </div>
        </section>
      ))}
    </section>
  );
}
