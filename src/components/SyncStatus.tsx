import { CloudAlert, CloudOff, CloudUpload } from 'lucide-react';
import { useOffline } from '../connectivity';

// What this device saved but the server does not have yet; opens 设置 → 待发送.
// Shown only while something waits, so it stays out of the way otherwise.
export function SyncStatus({
  count,
  failed,
  onOpen,
}: {
  count: number;
  failed: number;
  onOpen: () => void;
}) {
  const offline = useOffline();
  if (!count) return null;
  const Icon = failed ? CloudAlert : offline ? CloudOff : CloudUpload;
  const text = failed
    ? `${failed} 项未能同步，需要处理`
    : offline
      ? `离线中，${count} 项已存本机`
      : `${count} 项正在同步`;
  return (
    <button className={`sync-status${failed ? ' failed' : ''}`} title="查看待发送" onClick={onOpen}>
      <Icon size={16} aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}
