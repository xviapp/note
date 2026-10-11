import { useState } from 'react';
import { Copy, FilePlus2, Lock, Pin, PinOff, TextCursorInput, Trash2 } from 'lucide-react';
import type { Clip } from '../../shared/clips';
import type { PendingClip } from '../clips';
import { fileUrl, formatDate } from '../api';
import { isUnlocked } from '../keyring';
import { CachedImage } from './CachedImage';

type Item = Clip & { pending?: PendingClip };
const LONG = 280;

export function ClipRow({
  item,
  offline,
  onCopy,
  onCopyImage,
  onView,
  onPin,
  onRemove,
  onInsert,
  onConvert,
  onSource,
}: {
  item: Item;
  offline: boolean;
  onCopy: () => void;
  onCopyImage: () => void;
  onView: () => void;
  onPin: () => void;
  onRemove: () => void;
  onInsert?: () => void;
  onConvert: () => void;
  onSource: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sealed = !!item.key_id && !isUnlocked(item.key_id);
  return (
    <li className={`clip-item${item.pending ? ' is-pending' : ''}`}>
      {sealed ? (
        <p className="clip-text clip-sealed">
          <Lock size={13} aria-hidden="true" />
          已加密，解锁后显示
        </p>
      ) : (
        // The image is a small thumbnail beside the text.
        <div className="clip-body">
          {item.text && (
            <p className={`clip-text${open ? ' is-open' : ''}`}>
              {item.text}
            </p>
          )}
          {item.file && (
            <button className="clip-image" title="查看大图" onClick={onView}>
              <CachedImage src={fileUrl(item.file.id)} alt={item.file.name} />
            </button>
          )}
        </div>
      )}
      <div className="clip-meta">
        <span>{formatDate(item.created_at)}</span>
        {item.source_id && item.source_title && (
          <button className="text-button clip-source" onClick={onSource}>
            {item.source_title}
          </button>
        )}
        {item.pending &&
          (item.pending.error ? (
            <span className="clip-error" role="alert">
              {item.pending.error}
            </span>
          ) : (
            <span className="clip-waiting">{offline ? '联网后保存' : '正在保存'}</span>
          ))}
        <span className="clip-actions">
          {item.text && !sealed && (
            <button className="icon-button clip-copy" aria-label="复制文字" title="复制文字" onClick={onCopy}>
              <Copy size={15} />
            </button>
          )}
          {item.text.length > LONG && !sealed && (
            <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '收起' : '展开'}
            </button>
          )}
          {item.file && !sealed && (
            <button className="icon-button" aria-label="复制图片" title="复制图片" onClick={onCopyImage}>
              <Copy size={15} />
            </button>
          )}
          {onInsert && !sealed && (
            <button
              className="icon-button"
              aria-label="插入到正文"
              title="插入到正文"
              disabled={offline && !!item.file}
              onClick={onInsert}
            >
              <TextCursorInput size={15} />
            </button>
          )}
          {!item.pending && !sealed && (
            <button
              className="icon-button"
              aria-label="转为笔记"
              title="转为笔记"
              disabled={offline}
              onClick={onConvert}
            >
              <FilePlus2 size={15} />
            </button>
          )}
          {!item.pending && (
            <button
              className="icon-button"
              aria-label={item.pinned ? '取消置顶' : '置顶'}
              title={item.pinned ? '取消置顶' : '置顶'}
              disabled={offline}
              onClick={onPin}
            >
              {item.pinned ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="删除"
            title="删除"
            disabled={offline && !item.pending}
            onClick={onRemove}
          >
            <Trash2 size={15} />
          </button>
        </span>
      </div>
    </li>
  );
}
