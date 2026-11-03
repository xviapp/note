import { useEffect, useState } from 'react';
import type { ApiToken } from '../../shared/types';
import { api } from '../api';
import type { Confirm } from './Primitives';

const date = (value: number) => new Date(value).toLocaleDateString('zh-CN');
// Credentials `xvi login` created; they are revoked here, from any device.
export function ApiTokenSettings({
  confirm,
  onError,
}: {
  confirm: Confirm;
  onError: (error: unknown) => void;
}) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  useEffect(() => {
    let live = true;
    api<{ tokens: ApiToken[] }>('/api/tokens')
      .then((result) => {
        if (live) setTokens(result.tokens);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [onError]);
  const revoke = async (token: ApiToken) => {
    if (!(await confirm('撤销这个令牌？', `使用「${token.name}」的命令行工具需要重新登录。`, '撤销')))
      return;
    try {
      await api(`/api/tokens/${token.id}`, 'DELETE');
      setTokens((current) => current.filter((item) => item.id !== token.id));
    } catch (error) {
      onError(error);
    }
  };
  if (!tokens.length) return null;
  return (
    <>
      {tokens.map((token) => (
        <div className="setting-row" key={token.id}>
          <div>
            <strong>命令行令牌：{token.name}</strong>
            <p>
              {token.scope === 'read' ? '只读' : '可修改笔记'}，
              {token.last_used_at ? `${date(token.last_used_at)} 使用过` : `${date(token.created_at)} 创建`}。
            </p>
          </div>
          <button className="button" onClick={() => revoke(token)}>
            撤销
          </button>
        </div>
      ))}
    </>
  );
}
