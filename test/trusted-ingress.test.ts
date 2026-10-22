import { assertAuditEvent } from './helpers/audit-schema.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { createComputerHttpServer } from '../src/http-server.js';
import { loadTrustedIngress } from '../src/trusted-ingress.js';

// Ephemeral keys stay in a temporary test directory, never in fixtures or logs.
function certificates(directory: string) {
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Audit Test CA', '-keyout', 'ca.key', '-out', 'ca.pem');
  for (const name of ['server', 'personal', 'soocker', 'unmapped']) {
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`);
    writeFileSync(join(directory, `${name}.ext`), name === 'server'
      ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
    openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
  }
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=rogue', '-keyout', 'rogue.key', '-out', 'rogue.pem');
  const pin = (name: string) => new X509Certificate(readFileSync(join(directory, `${name}.pem`))).fingerprint256.replaceAll(':', '').toLowerCase();
  const config = { port: 3321, certFile: join(directory, 'server.pem'), keyFile: join(directory, 'server.key'), caFile: join(directory, 'ca.pem'), personalFingerprint: pin('personal'), soockerFingerprint: pin('soocker') };
  const file = join(directory, 'ingress.json'); writeFileSync(file, JSON.stringify(config));
  return { config, file };
}

test('mTLS proves independent routes; headers, no certificate, wrong CA and unpinned leaf cannot spoof', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-ingress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { config, file } = certificates(directory);
  const ingress = loadTrustedIngress(file)!;
  const lines: Record<string, any>[] = [];
  const previous = process.env.CHATGPT_MCP_TRACE; process.env.CHATGPT_MCP_TRACE = '1';
  t.after(() => { if (previous === undefined) delete process.env.CHATGPT_MCP_TRACE; else process.env.CHATGPT_MCP_TRACE = previous; });
  t.mock.method(console, 'error', (line: string) => { if (line.startsWith('{')) { const event = JSON.parse(line); if (event.traceSchemaVersion === 2) assertAuditEvent(event); lines.push(event); } });
  const token = 'test-bearer-not-for-audit';
  const { server, ingressServer, closeHandler } = createComputerHttpServer(parseConfig({ http: { token } }), undefined, undefined, ingress);
  assert.ok(ingressServer);
  server.listen(0, '127.0.0.1'); ingressServer.listen(0, '127.0.0.1');
  await Promise.all([once(server, 'listening'), once(ingressServer, 'listening')]);
  t.after(async () => {
    await Promise.all([server, ingressServer].map(item => new Promise<void>(resolve => { item.close(() => resolve()); item.closeAllConnections(); })));
    await closeHandler();
  });
  const port = (ingressServer.address() as AddressInfo).port;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'system.info', arguments: {} } });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'x-ingress-source': 'SOOCKER', 'x-mcp-ingress-source': 'Personal', 'x-mcp-ingress-verified': 'true' };
  function call(name: string | null, overrides: Record<string, string> = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', ca: readFileSync(config.caFile),
        ...(name ? { cert: readFileSync(join(directory, `${name}.pem`)), key: readFileSync(join(directory, `${name}.key`)) } : {}),
        headers: { ...headers, ...overrides }, agent: false }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  const verified = await Promise.all([call('personal'), call('soocker')]);
  assert.deepEqual(verified.map(r => r.status), [200, 200]);
  const complete = lines.filter(e => e.event === 'tool_completed');
  assert.deepEqual(complete.map(e => e.ingressSource).sort(), ['Personal', 'SOOCKER']);
  assert.ok(complete.every(e => e.ingressVerified === true));
  assert.equal((await call('unmapped')).status, 403);
  await assert.rejects(call(null)); await assert.rejects(call('rogue'));
  assert.equal((await call('personal', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call('personal', { origin: 'https://evil.example' })).status, 403);
  const plain = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, { method: 'POST', headers, body });
  assert.equal(plain.status, 200); await plain.text();
  assert.equal(lines.filter(e => e.event === 'tool_completed').at(-1)!.ingressSource, null);
  assert.equal(lines.filter(e => e.event === 'tool_completed').at(-1)!.ingressVerified, false);
  assert.equal(lines.filter(e => e.event === 'tool_received').length, 3);
  assert.equal(JSON.stringify(lines).includes(token), false);
  writeFileSync(file, JSON.stringify({ ...config, soockerFingerprint: config.personalFingerprint }));
  assert.throws(() => loadTrustedIngress(file), /Invalid trusted ingress/);
  writeFileSync(file, '{"private":"SECRET_CONFIG"}');
  assert.throws(() => loadTrustedIngress(file), error => error instanceof Error && !error.message.includes('SECRET_CONFIG'));
});
