import { useEffect, useState } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';
import { FOLDER_ICON_MAX_BYTES, isFolderEmoji } from '../../shared/folder-icons';
import { NodeIcon } from './Primitives';

export interface FolderIconValue {
  emoji: string | null;
  fileId: string | null;
  file?: File;
}
const choices = ['📁', '📚', '📝', '📑', '🔖', '🌿', '🌙', '⭐', '💡', '🎨', '🧪', '🧭'];

async function thumbnail(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('请选择一张图片。');
  if (file.size > 20_000_000) throw new Error('请选择小于 20 MB 的图片。');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 192;
    const context = canvas.getContext('2d');
    if (!context || !image.naturalWidth || !image.naturalHeight)
      throw new Error('无法读取这张图片，请换一张试试。');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      192,
      192,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.86),
    );
    if (!blob || blob.size > FOLDER_ICON_MAX_BYTES) throw new Error('图片处理失败，请换一张试试。');
    return new File([blob], `folder-icon.${blob.type === 'image/webp' ? 'webp' : 'png'}`, {
      type: blob.type,
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function FolderIconPicker({
  value,
  onChange,
  disabled,
  onBusy,
}: {
  value: FolderIconValue;
  onChange: (value: FolderIconValue) => void;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!value.file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(value.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value.file]);
  return (
    <fieldset className="folder-icon-picker" disabled={disabled}>
      <legend>文件夹图标</legend>
      <div className="folder-icon-current">
        <span className="folder-icon-preview" aria-label="图标预览">
          {value.file && preview ? (
            <img src={preview} alt="" />
          ) : (
            <NodeIcon
              kind="folder"
              size={36}
              node={{ icon_emoji: value.emoji, icon_blob_id: value.fileId }}
            />
          )}
        </span>
        <label className="folder-emoji-input">
          自定义 Emoji
          <input
            value={value.emoji || ''}
            placeholder="粘贴或输入 Emoji"
            maxLength={64}
            onChange={(event) => {
              setError('');
              onChange({ emoji: event.target.value || null, fileId: null });
            }}
            aria-invalid={!!value.emoji && !isFolderEmoji(value.emoji)}
          />
        </label>
      </div>
      <div className="folder-emoji-choices" role="group" aria-label="常用 Emoji">
        {choices.map((emoji) => (
          <button
            type="button"
            key={emoji}
            aria-label={`使用 ${emoji}`}
            aria-pressed={value.emoji === emoji}
            onClick={() => {
              setError('');
              onChange({ emoji, fileId: null });
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
      <div className="folder-icon-actions">
        <label className={`button file-input-button ${disabled ? 'disabled' : ''}`}>
          <ImagePlus size={16} />
          上传图片
          <input
            type="file"
            accept="image/*"
            aria-label="上传文件夹图标"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setError('');
              onBusy(true);
              try {
                onChange({ emoji: null, fileId: null, file: await thumbnail(file) });
              } catch (error) {
                setError((error as Error).message);
              } finally {
                onBusy(false);
              }
            }}
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setError('');
            onChange({ emoji: null, fileId: null });
          }}
        >
          <RotateCcw size={15} />
          恢复默认
        </button>
      </div>
      {(error || (value.emoji && !isFolderEmoji(value.emoji))) && (
        <p className="inline-error" role="alert">
          {error || '请输入一个 Emoji。'}
        </p>
      )}
    </fieldset>
  );
}
