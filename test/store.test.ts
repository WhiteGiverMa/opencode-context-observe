import { expect, test } from 'bun:test';
import { CaptureStore, canonical, type Capture } from '../src/store.ts';

const logical = (messages: unknown[], system = 'role', tools: unknown = {}) => canonical({ system, tools, options: {}, messages });
const capture = (text: string, extra: Partial<Capture> = {}): Capture => ({ sessionID: 's', parentID: null, title: 'fixture', agent: 'build',
  providerID: 'mock', modelID: 'm', kind: 'primary', transport: 'http', raw: ` {"fixture":"中文"}\n`, logical: text,
  url: 'http://localhost/v1', headers: {}, missingPrevious: false, ...extra });

test('append only, earlier edits rebuild, full wire text is exact', () => {
  const store = new CaptureStore();
  const first = store.add(capture(logical(['one'])));
  const second = store.add(capture(logical(['one', 'two'])));
  expect(second.mode).toBe('append');
  expect(JSON.parse(store.detail(second.id)!.delta)).toEqual(['two']);
  expect(store.detail(first.id)!.raw).toBe(' {"fixture":"中文"}\n');
  for (const text of [logical(['one', 'two'], 'new role'), logical(['one'], 'new role'), logical(['summary'], 'new role')]) {
    const row = store.add(capture(text)); expect(row.mode).toBe('rebuild'); expect(row.prefixChanged).toBe(true);
  }
});
test('tools and model changes rebuild; sessions and request kinds do not borrow baselines', () => {
  const store = new CaptureStore(); store.add(capture(logical([])));
  expect(store.add(capture(logical([], 'role', { read: {} }))).prefixChanged).toBe(true);
  expect(store.add(capture(logical([], 'role', { read: {} }), { modelID: 'other' })).prefixChanged).toBe(true);
  expect(store.add(capture(logical([]), { sessionID: 'other' })).mode).toBe('snapshot');
  expect(store.add(capture(logical([]), { kind: 'title' })).mode).toBe('snapshot');
});
test('eviction leaves retained record and previous context independently readable', () => {
  const store = new CaptureStore(1); const a = store.add(capture(logical(['one'])));
  const b = store.add(capture(logical(['one', 'two'])));
  expect(store.detail(a.id)).toBeNull(); expect(store.detail(b.id)!.previous).toBe(logical(['one']));
  expect(store.list().rows).toHaveLength(1);
});
test('sampling and output budget changes are not prompt-prefix edits', () => {
  const store = new CaptureStore();
  const make = (maxTokens: number) => canonical({ system: 'role', tools: {}, options: { maxTokens }, messages: ['one'] });
  store.add(capture(make(1000)));
  const next = store.add(capture(make(500)));
  expect(next.prefixChanged).toBe(false); expect(next.mode).toBe('append');
  expect(store.detail(next.id)!.logical).toBe(make(500));
});
test('single oversize record never defeats the configured byte budget', () => {
  const store = new CaptureStore(128, 1);
  const row = store.add(capture(logical(['fixture'])));
  expect(store.list().rows).toHaveLength(0); expect(store.detail(row.id)).toBeNull();
});
test('final HTTP body overlays that change the prefix trigger a rebuild too', () => {
  const store = new CaptureStore();
  const base = logical(['one']);
  store.add(capture(base, { raw: JSON.stringify({ messages: [{ role: 'system', content: 'old' }, { role: 'user', content: 'one' }] }) }));
  const row = store.add(capture(logical(['one', 'two']), { raw: JSON.stringify({ messages: [{ role: 'system', content: 'new' }, { role: 'user', content: 'one' }, { role: 'user', content: 'two' }] }) }));
  expect(row.mode).toBe('rebuild'); expect(row.prefixChanged).toBe(true);
});
test('incremental detail query does not retransmit full bodies; full is explicitly available', () => {
  const store = new CaptureStore(); store.add(capture(logical(['one'])));
  const next = store.add(capture(logical(['one', 'two'])));
  const lean = store.detail(next.id, false);
  expect(lean!.raw).toBe(''); expect(lean!.logical).toBe(''); expect(lean!.previous).toBeNull();
  expect(JSON.parse(lean!.delta)).toEqual(['two']);
  expect(store.detail(next.id, true)!.raw).toBe(' {"fixture":"中文"}\n');
});
