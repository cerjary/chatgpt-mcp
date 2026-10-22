/** Synthetic Docker smoke only. Never mount production data into this container. */
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { decodeRpc } from '../dist/src/hotswap/sse.js';
import { parseConfig } from '../dist/src/config.js';
import { startComputerHttpServer } from '../dist/src/http-server.js';

if (process.env.CHATGPT_MCP_SYNTHETIC_SMOKE !== '1') throw new Error('Run only in a disposable container with CHATGPT_MCP_SYNTHETIC_SMOKE=1.');
const a = '/workspace/mounts/trace-demo-a';
const b = '/workspace/mounts/trace-demo-b';
// Non-recursive final creation refuses reuse of any existing data directory.
await mkdir('/workspace/mounts', { recursive: true });
await mkdir(a); await mkdir(b);
const rows = [];
const originalError = console.error;
console.error = line => { if (typeof line === 'string' && line.startsWith('{')) rows.push(JSON.parse(line)); };
process.env.CHATGPT_MCP_TRACE = '1'; process.env.CHATGPT_MCP_TRACE_PATHS = '1';
delete process.env.CHATGPT_MCP_INGRESS_CONFIG;
const running = await startComputerHttpServer(parseConfig({ http: { port: 3210 }, filesystem: { read: true, write: true, roots: [a, b] }, shell: { enabled: true, allowedCommands: [process.execPath] } }));
let id = 0;
async function call(name, args, errorCode) {
  const response = await fetch(running.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-mcp-ingress-source': 'Personal', 'x-mcp-ingress-verified': 'true' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  const result = decodeRpc(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type') ?? undefined).result;
  if (errorCode) {
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, errorCode);
  } else assert.equal(result.isError, undefined);
  return result;
}
try {
  await call('fs.write', { path: `${a}/a.txt`, content: 'SYNTHETIC_SECRET_CONTENT' });
  assert.equal((await call('fs.read', { path: `${a}/a.txt` })).structuredContent.content, 'SYNTHETIC_SECRET_CONTENT');
  await call('fs.list', { path: b });
  await call('fs.move', { source: `${a}/a.txt`, destination: `${b}/b.txt` });
  await call('fs.read', { path: `${a}/missing` }, 'NOT_FOUND');
  await call('fs.read', { path: '/etc/hosts' }, 'PATH_NOT_ALLOWED');
  await call('shell.exec', { command: process.execPath, args: ['-e', 'console.log("SYNTHETIC_SECRET_OUTPUT")'], cwd: b });
  const completed = rows.filter(row => row.event === 'tool_completed');
  const move = completed.find(row => row.operation === 'fs.move');
  assert.deepEqual([move.project, move.projectBasis, move.sourceProject, move.destinationProject], [null, 'multiple', 'trace-demo-a', 'trace-demo-b']);
  const shell = completed.find(row => row.operation === 'shell.exec');
  assert.equal(shell.cwd, b); assert.equal(shell.path, null); assert.equal(shell.projectBasis, 'cwd_only');
  const toolRows = rows.filter(row => row.traceSchemaVersion === 2);
  assert.equal(toolRows.length, 21);
  assert.ok(toolRows.every(row => row.ingressSource === null && row.ingressVerified === false));
  assert.equal(new Set(toolRows.map(row => row.requestId)).size, 7);
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC_SECRET'), false);
  console.log('PASS: 7 real HTTP tool calls, two synthetic mounts, cross-project move, missing/denied paths, cwd-only, forged ingress Unknown, no content/output leakage.');
} finally {
  await running.close(); console.error = originalError;
  await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true });
}
