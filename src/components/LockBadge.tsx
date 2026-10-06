import { useSyncExternalStore } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { isUnlocked, keysVersion, subscribeKeys } from '../keyring';

// Re-renders when a key is unlocked, locked or expires.
export function useKeys() {
  return useSyncExternalStore(subscribeKeys, keysVersion);
}
// Marks encrypted content: closed while its password is locked on this
// device, open while it is unlocked.
export function LockBadge({ keyId, size = 13 }: { keyId?: string | null; size?: number }) {
  useKeys();
  if (!keyId) return null;
  const open = isUnlocked(keyId);
  const Icon = open ? LockOpen : Lock;
  return (
    <Icon
      size={size}
      className={`lock-badge${open ? ' is-open' : ''}`}
      aria-label={open ? '已加密，已解锁' : '已加密'}
      role="img"
    />
  );
}
