import type { Env } from './types';
import { AppError, asError, body, enforceOrigin, idValue, integer, json } from './http';
import { publicAuth, requireSession, accountAuth, editToken, requireEdit } from './auth';
import {
  createNode,
  getNode,
  listNodes,
  noteDetail,
  operationKey,
  restoreVersion,
  saveNote,
  updateNode,
  versionDetail,
  versionsList,
} from './library';
import { discardFile, serveFile, storageInfo, uploadFile } from './storage';
import { cleanup, deletePreview, listTrash, purgeTrash, restoreTrash, trashNode } from './recovery';
import { favorite, openReading, readingState, saveReading } from './reading';
import { aiSettings, saveAiSettings, testAiSettings } from './deepseek';
import { chatHistory, clearChat, exportReply, sendChat } from './assistant';
import { uploadChatFile } from './chat-files';
import { CHAT_BODY_BYTE_LIMIT } from '../shared/chat-files';
import { importArxiv } from './arxiv';
import { deleteTranslation, getTranslation, translate, translationHistory } from './translation';

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/'))
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response('页间', { headers: { 'content-type': 'text/plain;charset=utf-8' } });
    try {
      enforceOrigin(request);
      const publicResponse = await publicAuth(request, env, url.pathname);
      if (publicResponse) return publicResponse;
      const session = await requireSession(request, env);
      const accountResponse = await accountAuth(request, env, session, url.pathname);
      if (accountResponse) return accountResponse;
      const method = request.method,
        path = url.pathname;
      if (path === '/api/edit/unlock' && method === 'POST') {
        const data = await body(request),
          nodeId = idValue(data.nodeId);
        const node = await getNode(env, nodeId);
        if (!['markdown', 'text'].includes(node.kind))
          throw new AppError(400, '这个节点没有可编辑的正文。');
        return json({ token: await editToken(env, session, nodeId) });
      }
      if (path === '/api/storage' && method === 'GET') return json(await storageInfo(env));
      if (path === '/api/ai/settings' && method === 'GET') return json(await aiSettings(env));
      if (path === '/api/ai/settings' || path === '/api/ai/test') {
        if (path === '/api/ai/settings' && method === 'PUT')
          return json(await saveAiSettings(env, await body(request)));
        if (path === '/api/ai/settings' && method === 'DELETE') {
          await env.DB.prepare('DELETE FROM ai_settings WHERE id=1').run();
          return json(await aiSettings(env));
        }
        if (path === '/api/ai/test' && method === 'POST')
          return json(await testAiSettings(env, await body(request)));
      }
      if (path === '/api/settings' && method === 'PATCH') {
        const data = await body(request),
          quota = integer(data.quotaBytes, '容量上限', 1_000_000, 1_000_000_000_000);
        await env.DB.prepare('UPDATE site SET quota_bytes=? WHERE id=1').bind(quota).run();
        return json(await storageInfo(env));
      }
      if (path === '/api/cleanup' && method === 'POST') {
        return json(await cleanup(env));
      }
      if (path === '/api/nodes' && method === 'GET') return json(await listNodes(env, url));
      if (path === '/api/nodes' && method === 'POST') {
        return json(await createNode(env, await body(request), operationKey(request)), 201);
      }
      if (path === '/api/import/arxiv' && method === 'POST')
        return json(
          await importArxiv(env, await body(request), operationKey(request), request.signal),
          201,
        );
      if (path === '/api/files' && method === 'POST') {
        const f = await uploadFile(env, request);
        return json({ id: f.id, name: f.name, mime: f.mime, size: f.size }, 201);
      }
      const file = path.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
      if (file) {
        if (method === 'GET' || method === 'HEAD') return await serveFile(env, request, file[1]);
        if (method === 'DELETE') {
          if (!(await discardFile(env, file[1])))
            throw new AppError(409, '文件仍被笔记或历史版本引用。');
          return json({ ok: true });
        }
      }
      if (path === '/api/trash' && method === 'GET') return json({ batches: await listTrash(env) });
      const trash = path.match(/^\/api\/trash\/([a-zA-Z0-9_-]+)(\/restore)?$/);
      if (trash) {
        if (method === 'POST' && trash[2]) return json(await restoreTrash(env, trash[1]));
        if (method === 'DELETE' && !trash[2]) {
          await purgeTrash(env, trash[1]);
          execution.waitUntil(cleanup(env));
          return json({ ok: true });
        }
      }
      const note = path.match(/^\/api\/nodes\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
      if (note) {
        const id = note[1],
          action = note[2] || '';
        if (!action && method === 'GET') return json(await noteDetail(env, id));
        if (action === 'translations' && method === 'GET')
          return json(
            await translationHistory(
              env,
              id,
              integer(Number(url.searchParams.get('offset') || 0), '分页位置'),
            ),
          );
        if (action === 'translations' && method === 'POST')
          return await translate(
            env,
            execution,
            request,
            id,
            await body(request),
            operationKey(request),
          );
        const translation = action.match(/^translations\/([a-zA-Z0-9_-]+)$/);
        if (translation && method === 'GET')
          return json(await getTranslation(env, id, translation[1]));
        if (translation && method === 'DELETE') {
          await deleteTranslation(env, id, translation[1]);
          return json({ ok: true });
        }
        if (action === 'assistant/files' && method === 'POST') {
          const node = await getNode(env, id);
          if (node.kind === 'folder') throw new AppError(400, '请打开一个文件与青藜对话。');
          return json(await uploadChatFile(env, request), 201);
        }
        if (action === 'assistant' && method === 'GET')
          return json(
            await chatHistory(
              env,
              id,
              integer(
                Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER),
                '分页位置',
                1,
              ),
            ),
          );
        if (action === 'assistant' && method === 'POST')
          return await sendChat(
            env,
            execution,
            request,
            id,
            await body(
              request,
              CHAT_BODY_BYTE_LIMIT,
              '本次对话数据超过 16 MiB，请减少附件或缩小 PDF 页码范围。',
            ),
            operationKey(request),
          );
        if (action === 'assistant' && method === 'DELETE') {
          await clearChat(env, id);
          execution.waitUntil(cleanup(env));
          return json({ ok: true });
        }
        const reply = action.match(/^assistant\/([a-zA-Z0-9_-]+)\/export$/);
        if (reply && method === 'POST') {
          return json(await exportReply(env, id, reply[1]), 201);
        }
        if (action === 'favorite' && method === 'PUT') {
          await favorite(env, id, (await body(request)).enabled);
          return json({ ok: true });
        }
        if (action === 'open' && method === 'POST') return json(await openReading(env, id));
        if (action === 'reading' && method === 'GET') return json(await readingState(env, id));
        if (action === 'reading' && method === 'PUT')
          return json(await saveReading(env, id, await body(request)));
        if (action === 'delete-preview' && method === 'GET')
          return json(await deletePreview(env, id));
        if (action === 'versions' && method === 'GET')
          return json({ versions: await versionsList(env, id) });
        const version = action.match(/^versions\/([a-zA-Z0-9_-]+)(\/restore)?$/);
        if (version && method === 'GET' && !version[2]) {
          const { bodyId, ...result } = await versionDetail(env, id, version[1]);
          return json(result);
        }
        if (!action && method === 'PATCH')
          return json(await updateNode(env, id, await body(request)));
        if (!action && method === 'DELETE')
          return json(await trashNode(env, id, (await body(request)).count));
        if (action === 'content' && method === 'PUT') {
          await requireEdit(request, env, session, id);
          return json(await saveNote(env, id, await body(request), operationKey(request)));
        }
        if (version && method === 'POST' && version[2]) {
          await requireEdit(request, env, session, id);
          return json(
            await restoreVersion(
              env,
              id,
              version[1],
              (await body(request)).revision,
              operationKey(request),
            ),
          );
        }
      }
      return json({ error: '此操作不存在。' }, 404);
    } catch (error) {
      const known = asError(error);
      if (known.status === 500)
        console.error('API error', error instanceof Error ? error.message : String(error));
      return json({ error: known.message, code: known.code }, known.status);
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    execution: ExecutionContext,
  ): Promise<void> {
    execution.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
