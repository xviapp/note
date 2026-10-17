import { Component, useState, type ReactNode } from 'react';
import { AlertCircle, Copy, RefreshCw } from 'lucide-react';
import { version } from '../../package.json';

export function AppErrorScreen({ error }: { error: unknown }) {
  const [message, setMessage] = useState('');
  const details = `页间 ${version}\n${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;

  async function copyError() {
    try {
      await navigator.clipboard.writeText(details);
      setMessage('错误信息已复制。');
    } catch {
      setMessage('无法复制，请手动选择上方错误信息。');
    }
  }

  return (
    <main className="app-error-screen">
      <section className="app-error-card" aria-labelledby="app-error-title">
        <AlertCircle size={28} aria-hidden="true" />
        <h1 id="app-error-title">页面遇到问题</h1>
        <p>请重新加载，或回到首页后再试。未同步的内容可在恢复后到「设置 → 待发送」查看。</p>
        <div className="app-error-actions">
          <button className="button primary" onClick={() => location.reload()}>
            <RefreshCw size={16} />
            重新加载
          </button>
          <a className="button" href="/">
            回到首页
          </a>
        </div>
        <details>
          <summary>错误详情</summary>
          <pre>{details}</pre>
          <button className="button" onClick={copyError}>
            <Copy size={16} />
            复制错误信息
          </button>
        </details>
        {message && <p role="status">{message}</p>}
      </section>
    </main>
  );
}

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    return this.state.error ? <AppErrorScreen error={this.state.error} /> : this.props.children;
  }
}
