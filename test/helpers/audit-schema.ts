import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import formats from 'ajv-formats';
const ajv = new Ajv({ allErrors: true, strict: false });
// CJS export shape in NodeNext.
(formats as unknown as (ajv: Ajv) => void)(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../docs/specs/access-trace-v2.schema.json', import.meta.url), 'utf8')));
export function assertAuditEvent(event: Record<string, unknown>): void {
  assert.ok(validate(event), JSON.stringify(validate.errors));
  assert.equal(event.timestamp, event.time);
  if (event.event === 'tool_failed') assert.equal(event.code, event.errorCode);
}
