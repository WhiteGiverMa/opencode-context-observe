import { Plugin } from '@opencode/plugin';
import type { SessionContext, SessionRequestKind, SessionTitle } from '@opencode/plugin/promise/session';
import { deflateSync, inflateSync } from 'node:zlib';
import { Observer, PLUGIN_ID } from './contract.ts';
import { canonical, CaptureStore } from './store.ts';

interface Scope { sessionID: string; agent: string; model: { providerID: string; id: string }; kind: SessionRequestKind }
const key = (event: Scope) => JSON.stringify([event.sessionID, event.kind === 'title' ? 'title' : event.agent,
  event.model.providerID, event.model.id, event.kind]);

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    if (ctx.options.enabled === false) return;
    if (ctx.options.enabled !== undefined && typeof ctx.options.enabled !== 'boolean') throw new Error('Invalid observer option: enabled');
    for (const option of Object.keys(ctx.options)) {
      if (!['enabled', 'maxRecords', 'maxBytes'].includes(option)) throw new Error(`Unknown observer option: ${option}`);
    }
    const limit = (name: string, fallback: number) => {
      const value = ctx.options[name] ?? fallback;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid observer option: ${name}`);
      return value;
    };
    const store = new CaptureStore(limit('maxRecords', 128), limit('maxBytes', 64 * 1024 * 1024));
    const logical = new Map<string, Buffer>();
    const urls = new Map<string, string>();
    let active = true;
    const registrations: Array<{ dispose(): void }> = [];
    const observe = async (action: () => void | Promise<void>) => {
      try { await action(); }
      catch { console.error('[o3p.context.observe] Could not record this request; model execution is unaffected.'); }
    };
    const rpc = await ctx.rpc.register(Observer, {
      list: async input => store.list(input.after, input.sessionID),
      detail: async input => store.detail(input.id, input.full),
    });
    registrations.push(rpc);
    const remember = (kind: SessionRequestKind, event: SessionContext | SessionTitle, agent: string) => {
      logical.set(key({ ...event, agent, kind }), deflateSync(Buffer.from(canonical({ system: event.system, messages: event.messages,
        tools: 'tools' in event ? event.tools : {}, options: event.options }))));
      let size = [...logical.values()].reduce((total, bytes) => total + bytes.length, 0);
      while (logical.size > store.maxRecords || size > store.maxBytes) {
        const first = logical.entries().next().value;
        if (!first) break;
        size -= first[1].length; logical.delete(first[0]);
      }
    };
    for (const kind of ['context', 'compaction', 'generate'] as const) {
      registrations.push(await ctx.session.hook(kind, event => observe(() => remember(kind === 'context' ? 'primary' : kind, event, event.agent))));
    }
    registrations.push(await ctx.session.hook('title', event => observe(() => remember('title', event, 'title'))));
    const capture = async (event: Scope, raw: string, transport: 'http' | 'websocket', url: string, headers: Record<string, string>) => {
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => null);
      if (!active) return;
      const bytes = logical.get(key(event));
      const snapshot = bytes ? inflateSync(bytes).toString() : '';
      const row = store.add({ sessionID: event.sessionID, parentID: session?.parentID ? String(session.parentID) : null,
        title: session?.title ?? '', agent: event.agent, providerID: event.model.providerID, modelID: event.model.id,
        kind: event.kind, raw, transport, url, headers, logical: snapshot, missingPrevious: !snapshot });
      await rpc.events.emit('updated', { id: row.id, seq: row.seq });
    };
    registrations.push(await ctx.session.hook('http.request', event => observe(async () => {
      const url = new URL(event.request.url);
      url.username = ''; url.password = '';
      for (const name of [...url.searchParams.keys()]) {
        if (/key|token|secret|password|credential|signature/i.test(name)) url.searchParams.set(name, '[redacted]');
      }
      const headers = Object.fromEntries([...event.request.headers].filter(([name]) =>
        ['content-type', 'accept', 'user-agent'].includes(name.toLowerCase())));
      await capture(event, await event.request.clone().text(), 'http', url.href, headers);
    })));
    registrations.push(await ctx.session.hook('experimental.ws.handshake', event => observe(() => {
      const url = new URL(event.url); url.username = ''; url.password = ''; url.search = '';
      urls.set(key(event), url.href);
      if (urls.size > store.maxRecords) urls.delete(urls.keys().next().value ?? '');
    })));
    registrations.push(await ctx.session.hook('experimental.ws.send', event =>
      observe(() => capture(event, event.frame, 'websocket', urls.get(key(event)) ?? '', {}))));
    return () => {
      active = false;
      for (const registration of registrations.reverse()) registration.dispose();
      logical.clear(); urls.clear();
    };
  },
});
