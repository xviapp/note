import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { RotateCcw } from 'lucide-react';
import { Modal } from './Primitives';
import {
  readingDefaults,
  readingPresets,
  setReadingPreferences,
  useReadingPreferences,
} from '../reading-preferences';
import {
  setReadingWindowPreferences,
  useReadingWindowPreferences,
  type ReadingWindowPreferences,
} from '../reading-window';
import '../reading-settings.css';

export function ReadingControls() {
  const value = useReadingPreferences();
  return (
    <div className="reading-controls">
      <fieldset className="reading-fonts">
        <legend>字体</legend>
        {(
          [
            ['system', '系统'],
            ['serif', '宋体'],
            ['sans', '黑体'],
          ] as const
        ).map(([font, name]) => (
          <label key={font} className={`reading-font-${font}`}>
            <input
              type="radio"
              name="reading-font"
              value={font}
              checked={value.font === font}
              onChange={() => setReadingPreferences({ font })}
            />
            <span>{name}</span>
          </label>
        ))}
      </fieldset>
      <label className="reading-slider">
        <span>
          字号 <output>{value.size}</output>
        </span>
        <input
          aria-label="正文字号"
          type="range"
          min="14"
          max="28"
          step="1"
          value={value.size}
          onChange={(e) => setReadingPreferences({ size: Number(e.target.value) })}
        />
      </label>
      <div className="reading-presets" role="group" aria-label="排版预设">
        {Object.entries(readingPresets).map(([name, preset]) => (
          <button
            key={name}
            className="button compact"
            aria-pressed={Object.entries(preset).every(
              ([key, setting]) => value[key as keyof typeof value] === setting,
            )}
            onClick={() => setReadingPreferences(preset)}
          >
            {name}
          </button>
        ))}
      </div>
      <details className="reading-adjustments">
        <summary>微调间距</summary>
        {(
          [
            ['letterSpacing', '字间距', 0, 0.16, 0.01, 'em'],
            ['lineHeight', '行距', 1.4, 2.6, 0.1, '倍'],
            ['paragraphSpacing', '段落间距', 0.5, 2, 0.1, 'em'],
            ['width', '正文宽度', 520, 1040, 20, 'px'],
          ] as const
        ).map(([key, label, min, max, step, unit]) => (
          <label className="reading-slider" key={key}>
            <span>
              {label}
              <output>
                {value[key]} {unit}
              </output>
            </span>
            <input
              aria-label={label}
              type="range"
              min={min}
              max={max}
              step={step}
              value={value[key]}
              onChange={(e) => setReadingPreferences({ [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </details>
      {Capacitor.getPlatform() === 'android' && <DeviceReadingControls />}
      <button
        className="text-button reading-reset"
        onClick={() => setReadingPreferences(readingDefaults)}
      >
        <RotateCcw size={14} />
        恢复默认
      </button>
    </div>
  );
}

// This device only: the window while a note is open.
function DeviceReadingControls() {
  const value = useReadingWindowPreferences();
  const rows: [keyof ReadingWindowPreferences, string, string][] = [
    ['keepAwake', '阅读时屏幕常亮', '阅读时不熄屏，10 分钟没操作则恢复'],
    ['volumeKeys', '音量键翻页', '音量减翻到下一屏，音量加翻回上一屏'],
  ];
  return (
    <div className="reading-device">
      {rows.map(([key, label, hint]) => (
        <div className="setting-row" key={key}>
          <div>
            <strong>{label}</strong>
            <p>{hint}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label={label}
              checked={value[key]}
              onChange={(event) => setReadingWindowPreferences({ [key]: event.target.checked })}
            />
            <span className="toggle-switch-track" aria-hidden="true" />
          </label>
        </div>
      ))}
    </div>
  );
}

export function ReadingSettingsButton({ beforeChange, menu = false }: { beforeChange: () => void; menu?: boolean }) {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <>
      <button
        className={menu ? 'menu-compact-only' : 'icon-button reading-settings-toggle toolbar-secondary'}
        aria-label="阅读设置"
        title="阅读设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          if (menu) {
            const details = event.currentTarget.closest('details');
            returnFocus.current = details?.querySelector('summary') ?? null;
            if (details) details.open = false;
          }
          beforeChange();
          setOpen(true);
        }}
      >
        {menu ? '阅读设置' : <span aria-hidden="true">Aa</span>}
      </button>
      {open && createPortal(
        <Modal title="阅读设置" className="reading-settings-dialog" onClose={() => {
          setOpen(false);
          if (menu) requestAnimationFrame(() => returnFocus.current?.focus());
        }}>
          <ReadingControls />
        </Modal>,
        document.body,
      )}
    </>
  );
}
