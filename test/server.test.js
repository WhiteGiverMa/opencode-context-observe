import { expect, test } from 'bun:test';
import plugin from '../src/server.ts';

async function host(options = {}, reject = false) {
  const hooks = new Map(); let handlers; let disposed = 0;
  const cleanup = await plugin.setup({ options,
    rpc: { register: async (_contract, methods) => {
      handlers = methods;
      return { dispose: () => disposed++, events: { emit: async () => { if (reject) throw new Error('Synthetic event failure'); } } };
    } },
    session: {
      get: async () => { if (reject) throw new Error('Synthetic metadata failure'); return { agent: 'primary-agent', title: 'Fixture' }; },
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: () => disposed++ }; },
    },
  });
  return { hooks, handlers, cleanup, disposed: () => disposed };
}
const base = { sessionID: 's', agent: 'primary-agent', model: { providerID: 'mock', id: 'm' }, kind: 'primary' };
const logical = { ...base, system: [{ text: 'role' }], messages: [], tools: {}, options: {} };
const request = () => new Request('http://localhost/v1?api_key=secret', { method: 'POST', body: '{"fixture":true}', headers: { authorization: 'Bearer secret' } });

test('observer metadata/event failures do not reject or consume the outgoing request', async () => {
  const api = await host({}, true);
  await api.hooks.get('context')(logical);
  const req = request(); await api.hooks.get('http.request')({ ...base, request: req });
  expect(await req.text()).toBe('{"fixture":true}');
  const row = (await api.handlers.list({})).rows[0];
  const detail = await api.handlers.detail({ id: row.id });
  expect(detail.raw).toBe('{"fixture":true}'); expect(JSON.stringify(detail)).not.toContain('secret');
  api.cleanup(); expect(api.disposed()).toBe(api.hooks.size + 1);
});
test('title snapshots associate with the actual title agent rather than the primary session agent', async () => {
  const api = await host();
  await api.hooks.get('title')({ ...logical, system: [{ text: 'title prompt' }] });
  await api.hooks.get('http.request')({ ...base, kind: 'title', agent: 'dedicated-title-agent', request: request() });
  const row = (await api.handlers.list({})).rows[0];
  const detail = await api.handlers.detail({ id: row.id });
  expect(row.missingPrevious).toBe(false); expect(detail.logical).toContain('title prompt');
  api.cleanup();
});
test('disabled observer registers no hooks or RPC; invalid options are visible errors', async () => {
  const api = await host({ enabled: false, typo: true });
  expect(api.hooks.size).toBe(0); expect(api.handlers).toBeUndefined();
  await Promise.resolve(expect(host({ enabled: 'false' })).rejects.toThrow('enabled'));
  await Promise.resolve(expect(host({ maxRecords: 0 })).rejects.toThrow('maxRecords'));
  await Promise.resolve(expect(host({ typo: true })).rejects.toThrow('Unknown observer option'));
});
test('WebSocket frames remain exact and safe handshake metadata omits credentials', async () => {
  const api = await host(); await api.hooks.get('context')(logical);
  await Promise.resolve(api.hooks.get('experimental.ws.handshake')({ ...base, url: 'wss://user:secret@example.test/v1?token=secret' }));
  const frame = ' {"type":"response.create","previous_response_id":"response-1","input":[]}\n';
  await Promise.resolve(api.hooks.get('experimental.ws.send')({ ...base, frame }));
  const row = (await api.handlers.list({})).rows[0], detail = await api.handlers.detail({ id: row.id });
  expect(row.transport).toBe('websocket'); expect(detail.raw).toBe(frame);
  expect(detail.url).toBe('wss://example.test/v1'); api.cleanup();
});
test('auxiliary kinds and simultaneous sessions retain their own logical snapshots', async () => {
  const api = await host();
  await Promise.all([
    api.hooks.get('context')({ ...logical, sessionID: 'session-a', system: [{ text: 'ROLE_A' }] }),
    api.hooks.get('context')({ ...logical, sessionID: 'session-b', system: [{ text: 'ROLE_B' }] }),
    api.hooks.get('compaction')({ ...logical, system: [{ text: 'COMPACTION' }] }),
    api.hooks.get('generate')({ ...logical, system: [{ text: 'GENERATE' }] }),
  ]);
  await Promise.all([
    api.hooks.get('http.request')({ ...base, sessionID: 'session-a', request: request() }),
    api.hooks.get('http.request')({ ...base, sessionID: 'session-b', request: request() }),
    api.hooks.get('http.request')({ ...base, kind: 'compaction', request: request() }),
    api.hooks.get('http.request')({ ...base, kind: 'generate', request: request() }),
  ]);
  const rows = (await api.handlers.list({})).rows;
  for (const row of rows) {
    const detail = await api.handlers.detail({ id: row.id });
    const marker = row.sessionID === 'session-a' ? 'ROLE_A' : row.sessionID === 'session-b' ? 'ROLE_B' : row.kind.toUpperCase();
    expect(detail.logical).toContain(marker); expect(row.mode).toBe('snapshot');
  }
  api.cleanup();
});
