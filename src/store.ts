import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { RequestDetail, RequestRow } from './contract.ts';

export interface Capture {
  sessionID: string; parentID: string | null; title: string; agent: string;
  providerID: string; modelID: string; kind: RequestRow['kind'];
  transport: RequestRow['transport']; raw: string; logical: string;
  url: string; headers: Record<string, string>; missingPrevious: boolean;
}
interface Stored {
  row: RequestRow; raw: Buffer; logical: Buffer; delta: Buffer;
  previous: Buffer | null; url: string; headers: Record<string, string>; hash: string;
}
const pack = (text: string) => deflateSync(Buffer.from(text));
const unpack = (bytes: Buffer) => inflateSync(bytes).toString();
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Keep object key order irrelevant to logical prefix comparisons; preserve wire bytes separately.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface Logical { system: unknown; tools: unknown; options: unknown; messages: unknown[] }
function logicalShape(text: string): Logical | undefined {
  if (!text) return;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('messages' in value) || !Array.isArray(value.messages)) return;
  return { system: 'system' in value ? value.system : null, tools: 'tools' in value ? value.tools : null,
    options: 'options' in value ? value.options : null, messages: value.messages };
}

export function compare(previous: string, next: string) {
  const before = logicalShape(previous), after = logicalShape(next);
  if (before && after) {
    const a = [canonical(before.system), canonical(before.tools), ...before.messages.map(canonical)];
    const b = [canonical(after.system), canonical(after.tools), ...after.messages.map(canonical)];
    let keep = 0;
    while (keep < a.length && keep < b.length && a[keep] === b[keep]) keep++;
    const changed = keep < a.length;
    return { changed, changedAt: keep, delta: changed ? next : JSON.stringify(after.messages.slice(before.messages.length), null, 2) };
  }
  return { changed: previous !== next, changedAt: 0, delta: next };
}

function wireContext(raw: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return; }
  if (!value || typeof value !== 'object' || 'previous_response_id' in value) return;
  const messages = 'messages' in value ? value.messages : 'input' in value ? value.input : undefined;
  if (!Array.isArray(messages)) return;
  return canonical({ messages, tools: 'tools' in value ? value.tools : {}, system: {
    system: 'system' in value ? value.system : null,
    instructions: 'instructions' in value ? value.instructions : null,
  } });
}

export class CaptureStore {
  readonly generation = randomUUID();
  private seq = 0;
  private records = new Map<string, Stored>();
  constructor(readonly maxRecords = 128, readonly maxBytes = 64 * 1024 * 1024) {}

  add(input: Capture): RequestRow {
    const baseline = [...this.records.values()].findLast(item => item.row.sessionID === input.sessionID &&
      item.row.agent === input.agent && item.row.kind === input.kind);
    const previous = baseline ? unpack(baseline.logical) : null;
    const sameRoute = baseline?.row.providerID === input.providerID && baseline.row.modelID === input.modelID &&
      baseline.row.transport === input.transport && baseline.url === input.url;
    const diff = previous === null ? null : compare(previous, input.logical);
    const wireBefore = baseline?.row.transport === 'http' ? wireContext(unpack(baseline.raw)) : undefined;
    const wireAfter = input.transport === 'http' ? wireContext(input.raw) : undefined;
    const wireDiff = wireBefore && wireAfter ? compare(wireBefore, wireAfter) : undefined;
    const changed = baseline !== undefined && (!sameRoute || Boolean(diff?.changed) || Boolean(wireDiff?.changed));
    const row: RequestRow = {
      id: randomUUID(), seq: ++this.seq, sessionID: input.sessionID, parentID: input.parentID,
      title: input.title, agent: input.agent, providerID: input.providerID, modelID: input.modelID,
      kind: input.kind, transport: input.transport, time: Date.now(), bytes: Buffer.byteLength(input.raw),
      mode: !baseline ? 'snapshot' : changed ? 'rebuild' : 'append', baseID: baseline?.row.id ?? null,
      prefixChanged: changed, changedAt: sameRoute ? (wireDiff?.changed ? wireDiff.changedAt : diff?.changedAt ?? 0) : 0,
      missingPrevious: input.missingPrevious,
    };
    this.records.set(row.id, { row, raw: pack(input.raw), logical: pack(input.logical),
      delta: pack(!baseline || changed ? input.logical : diff?.delta ?? input.logical),
      previous: previous === null ? null : pack(previous), url: input.url,
      headers: input.headers, hash: hash(input.raw) });
    // ponytail: independent compressed snapshots keep retained records reconstructible after eviction.
    let bytes = [...this.records.values()].reduce((n, item) => n + item.raw.length + item.logical.length +
      item.delta.length + (item.previous?.length ?? 0), 0);
    while (this.records.size > 0 && (this.records.size > this.maxRecords || bytes > this.maxBytes)) {
      const first = this.records.entries().next().value;
      if (!first) break;
      bytes -= first[1].raw.length + first[1].logical.length + first[1].delta.length + (first[1].previous?.length ?? 0);
      this.records.delete(first[0]);
    }
    if (!this.records.has(row.id)) console.error('[o3p.context.observe] Request exceeds maxBytes; increase the retention budget to keep it.');
    return row;
  }

  list(after = 0, sessionID?: string) {
    return { generation: this.generation, rows: [...this.records.values()].map(item => item.row)
      .filter(row => row.seq > after && (!sessionID || row.sessionID === sessionID)) };
  }

  detail(id: string, full = true): RequestDetail | null {
    const item = this.records.get(id);
    if (!item) return null;
    const incremental = !full && item.row.mode === 'append';
    return { row: item.row, raw: incremental ? '' : unpack(item.raw), logical: incremental ? '' : unpack(item.logical),
      delta: unpack(item.delta), previous: !incremental && item.previous ? unpack(item.previous) : null,
      url: item.url, headers: item.headers, hash: item.hash };
  }
}
