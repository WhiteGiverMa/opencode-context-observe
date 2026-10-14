import { Rpc } from '@opencode/plugin';
import { Schema } from 'effect';

export const PLUGIN_ID = 'o3p.context.observe';
export const Kind = Schema.Literals(['primary', 'title', 'compaction', 'generate']);
export const Row = Schema.Struct({
  id: Schema.String, seq: Schema.Number, sessionID: Schema.String,
  parentID: Schema.NullOr(Schema.String), title: Schema.String, agent: Schema.String,
  providerID: Schema.String, modelID: Schema.String, kind: Kind,
  transport: Schema.Literals(['http', 'websocket']), time: Schema.Number,
  bytes: Schema.Number, mode: Schema.Literals(['snapshot', 'append', 'rebuild']),
  baseID: Schema.NullOr(Schema.String), prefixChanged: Schema.Boolean,
  changedAt: Schema.Number, missingPrevious: Schema.Boolean,
});
export type RequestRow = typeof Row.Type;
export const Detail = Schema.Struct({
  row: Row, raw: Schema.String, logical: Schema.String, delta: Schema.String,
  previous: Schema.NullOr(Schema.String), url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String), hash: Schema.String,
});
export type RequestDetail = typeof Detail.Type;
export const Observer = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    list: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ after: Schema.optional(Schema.Number), sessionID: Schema.optional(Schema.String) })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ rows: Schema.Array(Row), generation: Schema.String })),
    },
    detail: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String, full: Schema.optional(Schema.Boolean) })),
      output: Schema.toStandardSchemaV1(Schema.NullOr(Detail)),
    },
  },
  events: { updated: { schema: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String, seq: Schema.Number })) } },
});
