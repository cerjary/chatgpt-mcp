import { assertAuditEvent } from './helpers/audit-schema.js';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import test from 'node:test';
import type { ComputerAdapter } from '../src/adapter/computer-adapter.js';
import { parseConfig } from '../src/config.js';
import { adapterError } from '../src/errors.js';
import { registerTools } from '../src/tools/register-tools.js';

function fakeAdapter(): ComputerAdapter {
  return {
    async systemInfo() { return { hostname: 'test', platform: 'linux', architecture: 'x64', release: '1', uptimeSeconds: 1, cwd: '/tmp' }; },
    async listDirectory() { return [{ name: 'a.txt', type: 'file', size: 1 }]; },
    async readFile() { return 'a'; },
    async readDocument() { return { format: 'docx', markdown: '# Test', sourceBytes: 128, outputBytes: 6 }; },
    async writeFile() {},
    async makeDirectory() {},
    async movePath() {},
    async deletePath(path) { return { originalPath: path, trashPath: `/tmp/.trash/20260927_000000/${path.split('/').pop() ?? 'item'}`, permanent: false }; },
    async restorePath(trashPath) { return { trashPath, restoredPath: '/tmp/restored' }; },
    async purgePath(path) { return { path, permanent: true }; },
    async xpurgePath(path) { return { path, permanent: true }; },
    async exec() { return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false }; },
    async listProcesses() { return [{ pid: 1, command: 'init' }]; },
    async killProcess() {},
    async serviceStatus(name) { return { name, activeState: 'active', subState: 'running', description: 'test service' }; },
    async serviceControl() {},
    async launchApplication() { return { handle: 'app_test', pid: 42 }; },
    async closeApplication() {},
    async openBrowser() {},
    async captureScreen() { return { mimeType: 'image/png', data: Buffer.from('png').toString('base64'), bytes: 3 }; },
    async startScreenRecording(display, path) { return { handle: 'rec_test', pid: 43, path, display, startedAt: '2026-09-09T00:00:00.000Z' }; },
    async stopScreenRecording(handle) { return { handle, path: '/tmp/test.mp4', display: ':0', bytes: 123, durationMs: 1000 }; },
    async movePointer() {},
    async clickPointer() {},
    async typeText() {},
    async pressKey() {},
  };
}

async function harness(configValue: unknown, adapter: ComputerAdapter = fakeAdapter()) {
  const config = parseConfig(configValue);
  const server = new McpServer({ name: 'chatgpt-computer', version: '0.1.0' });
  registerTools(server, config, adapter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}


import { auditMetadata, beginToolAudit, mountProject } from '../src/audit.js';
import { diagnosticId, withDiagnosticRequest, withDiagnosticTool } from '../src/diagnostics.js';
import { LocalComputerAdapter } from '../src/adapter/local-computer-adapter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function capture(t: import('node:test').TestContext) {
  const lines: Record<string, any>[] = [];
  const old = [process.env.CHATGPT_MCP_TRACE, process.env.CHATGPT_MCP_TRACE_PATHS];
  process.env.CHATGPT_MCP_TRACE = '1'; process.env.CHATGPT_MCP_TRACE_PATHS = '1';
  t.mock.method(console, 'error', (line: string) => { const event = JSON.parse(line); assertAuditEvent(event); lines.push(event); });
  t.after(() => {
    for (const [i, key] of ['CHATGPT_MCP_TRACE', 'CHATGPT_MCP_TRACE_PATHS'].entries()) {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    }
  });
  return lines;
}

test('path attribution is bounded, lexical, conservative and opt-in', t => {
  capture(t);
  for (const path of ['/', 'relative/a', '/workspace/mounts', '/workspace/mounts-evil/a', '//workspace/mounts/a', '/workspace/mounts/a/../../b', '/workspace/mounts/a/../b']) assert.equal(mountProject(path), null);
  assert.equal(mountProject('/workspace/mounts/foo2/a'), 'foo2');
  assert.equal(mountProject('/workspace/mounts/中文/./a'), '中文');
  const original = '/workspace/mounts/wow-taiwan//PM/./README.md';
  assert.equal(auditMetadata('fs.read', { path: original }).path, original);
  assert.equal(auditMetadata('fs.read', { path: original }).project, 'wow-taiwan');
  for (const path of ['x'.repeat(4097), '/a\nsecret', 'https://secret.example/token']) assert.equal(auditMetadata('fs.read', { path }).path, null);
  assert.equal(auditMetadata('browser.open', { path: original }).path, null);
  const move = auditMetadata('fs.move', { sourcePath: '/workspace/mounts/a/f', destinationPath: '/workspace/mounts/b/f' });
  assert.deepEqual([move.project, move.projectBasis, move.sourceProject, move.destinationProject], [null, 'multiple', 'a', 'b']);
  assert.equal(auditMetadata('fs.move', { sourcePath: '/workspace/mounts/a/f', destinationPath: '/outside' }).projectBasis, 'unknown');
  assert.equal(auditMetadata('fs.move', { sourcePath: '/workspace/mounts/a/f', destinationPath: '/workspace/mounts/a/g' }).project, 'a');
  const shell = auditMetadata('shell.exec', { cwd: '/workspace/mounts/a', path: original });
  assert.deepEqual([shell.path, shell.pathKind, shell.projectBasis], [null, 'cwd', 'cwd_only']);
  assert.equal(auditMetadata('shell.exec').projectBasis, 'unknown');
  process.env.CHATGPT_MCP_TRACE_PATHS = '0';
  assert.equal(auditMetadata('fs.read', { path: original }).project, null);
  assert.equal(auditMetadata('exec.start', { cwd: original }).cwd, null);
});

test('all allowlisted registrations repeat lifecycle metadata; secrets and output stay out', async t => {
  const lines = capture(t);
  const adapter = fakeAdapter();
  const secret = 'DO_NOT_LOG_token_password_API_KEY_content';
  adapter.replaceFile = async () => ({ sha256: 'a'.repeat(64) });
  adapter.readFile = async () => secret;
  adapter.readDocument = async () => ({ format: 'pdf', markdown: secret, sourceBytes: 1, outputBytes: secret.length });
  adapter.exec = async () => ({ stdout: secret, stderr: secret, exitCode: 1, durationMs: 1, timedOut: false });
  const { client, server } = await harness({ filesystem: { read: true, write: true, roots: ['/workspace/mounts'] }, shell: { enabled: true, allowedCommands: ['node'] }, desktop: { hostDisplayAccess: true, screenCapture: true } }, adapter);
  t.after(async () => { await client.close(); await server.close(); });
  const path = '/workspace/mounts/wow-taiwan/PM/README.md';
  const calls: [string, Record<string, unknown>][] = [
    ['fs.read', { path }], ['fs.list', { path: '/workspace/mounts/other' }], ['document.read', { path }],
    ['fs.write', { path, content: secret }], ['fs.mkdir', { path }], ['fs.delete', { path }],
    ['fs.restore', { trashPath: path }], ['fs.purge', { path }], ['fs.xpurge', { path, confirm: 'PERMANENT_DELETE' }],
    ['fs.replace', { path, content: secret, expectedSha256: null }],
    ['fs.move', { source: path, destination: '/workspace/mounts/other/a' }],
    ['shell.exec', { command: secret, args: [secret], env: { SECRET: secret }, cwd: '/workspace/mounts/wow-taiwan' }],
    ['shell.exec', { command: secret }], ['screen.capture', { display: ':99' }],
  ];
  for (const [name, args] of calls) {
    const before = lines.length;
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined);
    const events = lines.slice(before);
    assert.deepEqual(events.map(e => e.event), ['tool_received', 'tool_started', 'tool_completed']);
    assert.equal(new Set(events.map(e => e.requestId)).size, 1);
    for (const e of events) {
      assert.equal(e.operation, name); assert.equal(e.timestamp, e.time);
      assert.equal(e.traceSchemaVersion, 2); assert.equal(e.ingressVerified, false); assert.equal(e.ingressSource, null);
      assert.ok(e.elapsedMs >= 0); assert.equal(e.path, events[0]!.path);
    }
    if (name.startsWith('fs.') && name !== 'fs.move' || name === 'document.read') assert.equal(events[0]!.path, args.path ?? args.trashPath);
  }
  assert.equal(JSON.stringify(lines).includes(secret), false);
  assert.equal(JSON.stringify(lines).includes('PERMANENT_DELETE'), false);
  assert.equal(new Set(lines.filter(e => e.event === 'tool_received').map(e => e.requestId)).size, calls.length);
});

test('denial, missing file, output limit and unknown exceptions retain exact outcomes', async t => {
  const lines = capture(t);
  const root = await mkdtemp(join(tmpdir(), 'audit-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { filesystem: { read: true, roots: [root] } };
  const local = await harness(config, new LocalComputerAdapter(parseConfig(config)));
  t.after(async () => { await local.client.close(); await local.server.close(); });
  for (const [path, code] of [['/denied', 'PATH_NOT_ALLOWED'], [join(root, 'missing'), 'NOT_FOUND']]) {
    const result = await local.client.callTool({ name: 'fs.read', arguments: { path } });
    assert.equal(result.isError, true);
    const end = lines.at(-1)!;
    assert.equal(end.errorCode, code); assert.equal(end.code, code); assert.equal(end.success, false); assert.equal(end.path, path);
    assert.equal(JSON.parse((result.content as { text: string }[])[0]!.text).error.diagnosticId, end.requestId);
  }
  const fake = fakeAdapter(); fake.readFile = async () => 'a'.repeat(7 * 1024 * 1024);
  const large = await harness(config, fake);
  t.after(async () => { await large.client.close(); await large.server.close(); });
  assert.equal((await large.client.callTool({ name: 'fs.read', arguments: { path: root } })).isError, true);
  assert.equal(lines.at(-1)!.errorCode, 'OUTPUT_LIMIT');
  fake.readFile = async () => { throw new Error('SECRET_EXCEPTION'); };
  await large.client.callTool({ name: 'fs.read', arguments: { path: root } });
  assert.equal(lines.at(-1)!.errorCode, 'OS_ERROR');
  assert.equal(JSON.stringify(lines).includes('SECRET_EXCEPTION'), false);
});

test('concurrent tools in one request have distinct IDs, with isolated provenance', async t => {
  const lines = capture(t);
  await Promise.all(['Personal', 'SOOCKER', null].map(source => withDiagnosticRequest(async () => {
    const transportId = diagnosticId();
    await Promise.all([0, 1].map(index => withDiagnosticTool(async () => {
      if (index === 0) assert.equal(diagnosticId(), transportId); else assert.notEqual(diagnosticId(), transportId);
      const audit = beginToolAudit('system.info'); await new Promise(resolve => setImmediate(resolve)); audit.started(); audit.completed();
    })));
  }, undefined, source as 'Personal' | 'SOOCKER' | null)));
  assert.equal(new Set(lines.map(e => e.requestId)).size, 6);
  for (const id of new Set(lines.map(e => e.requestId))) {
    const events = lines.filter(e => e.requestId === id);
    assert.equal(new Set(events.map(e => e.ingressSource)).size, 1);
    assert.equal(events.length, 3);
  }
  process.env.CHATGPT_MCP_TRACE = '0';
  beginToolAudit('fs.read', { path: '/private' }).completed();
  assert.equal(lines.length, 18);
});

test('durable job wrappers emit started, elapsed and safe cwd even on policy failure', async t => {
  const lines = capture(t);
  const root = await mkdtemp(join(tmpdir(), 'audit-jobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { client, server } = await harness({ filesystem: { roots: [root] }, shell: { enabled: true, allowedCommands: ['node'] }, jobs: { enabled: true, directory: join(root, 'jobs'), launcher: 'detached' } });
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'exec.start', arguments: { operationId: 'audit-job-001', command: 'DISALLOWED_SECRET', args: ['SECRET_ARGS'], env: { TOKEN: 'SECRET_ENV' }, cwd: '/workspace/mounts/a' } });
  assert.equal(result.isError, true);
  assert.deepEqual(lines.map(e => e.event), ['tool_received', 'tool_started', 'tool_failed']);
  assert.equal(lines[0]!.cwd, '/workspace/mounts/a'); assert.equal(lines[0]!.projectBasis, 'cwd_only');
  await client.callTool({ name: 'exec.list', arguments: {} });
  assert.equal(lines.at(-1)!.success, true);
  assert.equal(lines.at(-1)!.cwd, null);
  assert.equal(JSON.stringify(lines).includes('SECRET'), false);
});
