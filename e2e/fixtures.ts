import { test as base, expect, request as apiRequest } from '@playwright/test';
import { preparePassword } from '../shared/password';

export * from '@playwright/test';

const origin = 'http://127.0.0.1:8799';
const headers = { origin };

// Every spec shares one e2e server. Start each test from an empty library so
// earlier tests' notes cannot push this test's items past the first page.
// The cleanup uses its own API session, leaving the browser signed out.
async function emptyLibrary() {
  const api = await apiRequest.newContext({ baseURL: origin });
  try {
    const status = await (await api.get('/api/auth/status')).json();
    if (!status.initialized) return; // The first test sets the password itself.
    const login = await api.post('/api/auth/login', {
      headers,
      data: { password: await preparePassword('Note2026', status.password) },
    });
    expect(login.ok(), await login.text()).toBe(true);
    for (;;) {
      const { nodes } = await (await api.get('/api/nodes?parent=')).json();
      if (!nodes.length) break;
      for (const node of nodes) {
        const preview = await api.get(`/api/nodes/${node.id}/delete-preview`);
        if (!preview.ok()) continue;
        const { count } = await preview.json();
        await api.delete(`/api/nodes/${node.id}`, { headers, data: { count } });
      }
    }
    const { batches } = await (await api.get('/api/trash')).json();
    for (const batch of batches) await api.delete(`/api/trash/${batch.id}`, { headers });
    await api.delete('/api/ai/settings', { headers });
  } finally {
    await api.dispose();
  }
}

export const test = base.extend<{ cleanLibrary: void }>({
  cleanLibrary: [
    async ({}, use) => {
      await emptyLibrary();
      await use();
    },
    { auto: true },
  ],
});
