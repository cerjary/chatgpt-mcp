import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertAuditEvent } from './helpers/audit-schema.js';

test('published JSONL fixtures validate and a v1-compatible requestId consumer merges mixed lifecycle rows', () => {
  const read = (version: number): Record<string, unknown>[] => readFileSync(new URL(`../docs/fixtures/access-trace-v${version}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const v2 = read(2); v2.forEach(assertAuditEvent);
  const v1 = read(1);
  // Reference consumer only: Console code remains independently owned.
  const merged = new Map<unknown, Record<string, unknown>>();
  for (const row of [...v1, ...v2, ...v2]) merged.set(row.requestId, { ...merged.get(row.requestId), ...row });
  assert.equal(merged.size, 10);
  assert.ok([...merged.values()].every(row => ['tool_completed', 'tool_failed'].includes(String(row.event))));
  assert.equal(merged.get('legacy-example-id')!.traceSchemaVersion, undefined);
  const move = [...merged.values()].find(row => row.projectBasis === 'multiple')!;
  assert.equal(move.path, null); assert.equal(move.project, null);
  assert.equal(move.sourceProject, 'demo-a'); assert.equal(move.destinationProject, 'demo-b');
  assert.throws(() => assertAuditEvent({ ...v2[0], ingressVerified: false, ingressSource: 'Personal' }));
  assert.throws(() => assertAuditEvent({ ...v2[0], content: 'secret' }));
});
