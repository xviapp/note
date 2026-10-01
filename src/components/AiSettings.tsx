import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { AssistantSettings } from '../../shared/assistant';
import { api } from '../api';
import type { Confirm } from './Management';

export function AiSettings({ confirm }: { confirm: Confirm }) {
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [key, setKey] = useState(''),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    api<AssistantSettings>('/api/ai/settings')
      .then((value) => {
        if (live) setSettings(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  const run = async (action: 'save' | 'test' | 'clear') => {
    if (
      action === 'clear' &&
      !(await confirm('清除 AI 配置？', '会话记录和已保存的笔记会保留。', '清除配置', true))
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'test') {
        await api('/api/ai/test', 'POST', key.trim() ? { apiKey: key.trim() } : {});
        setNotice(key.trim() ? '连接成功，保存后即可使用。' : '连接成功。');
      } else {
        setSettings(
          await api<AssistantSettings>(
            '/api/ai/settings',
            action === 'save' ? 'PUT' : 'DELETE',
            action === 'save' ? { apiKey: key.trim() } : undefined,
          ),
        );
        setKey('');
        setNotice(action === 'save' ? 'AI 配置已保存。' : 'AI 配置已清除。');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section ai-settings">
      <h2>
        <Bot size={19} />
        AI 助手
      </h2>
      <div className="setting-row">
        <div>
          <strong>DeepSeek</strong>
          <p>deepseek-flash · 文字和图片</p>
        </div>
        <span className="muted">
          {settings ? (settings.configured ? '已配置' : '未配置') : '加载中…'}
        </span>
      </div>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run('save');
        }}
      >
        <label>
          DeepSeek API Key
          <input
            type="password"
            autoComplete="off"
            name="deepseek-api-key"
            value={key}
            maxLength={512}
            disabled={busy}
            placeholder={settings?.configured ? '输入新 Key 可替换现有配置' : 'sk-…'}
            onChange={(e) => {
              setKey(e.target.value);
              setNotice('');
            }}
          />
        </label>
        <p className="field-hint">
          密钥加密保存在服务端。仅发送你提交的问题、附件、引用、截图和本文件的近期会话；调用按
          DeepSeek 账户计费。
        </p>
        <div className="ai-settings-actions">
          <button className="button primary" disabled={busy || !key.trim()}>
            保存 AI 配置
          </button>
          <button
            className="button"
            type="button"
            disabled={busy || (!key.trim() && !settings?.configured)}
            onClick={() => void run('test')}
          >
            {busy ? '处理中…' : '测试连接'}
          </button>
          {settings?.configured && (
            <button
              className="text-button danger-text"
              type="button"
              disabled={busy}
              onClick={() => void run('clear')}
            >
              清除配置
            </button>
          )}
        </div>
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
