import { posix } from 'node:path';
import { diagnosticId, diagnosticIngress, trace } from './diagnostics.js';
import { errorCodes } from './errors.js';

/** Only pre-extracted fields may cross the audit seam. Never pass tool args here. */
export interface AuditMetadata {
  path?: string;
  sourcePath?: string;
  destinationPath?: string;
  cwd?: string;
}
const singlePathTools = new Set(['fs.list', 'fs.read', 'fs.write', 'fs.mkdir', 'fs.delete', 'fs.restore', 'fs.purge', 'fs.xpurge', 'fs.replace', 'document.read']);
export const MAX_AUDIT_PATH = 4096;
function boundedPath(value: string | undefined): string | null {
  // Drop rather than truncate: a shortened path could identify the wrong target.
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_AUDIT_PATH
    && !/[\x00-\x1f\x7f]/u.test(value) && !value.includes('://') ? value : null;
}
export function mountProject(path: string | null): string | null {
  if (!path?.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  // Dot-dot is ambiguous in the presence of symlinks. Do not invent canonical access.
  if (path.split('/').includes('..')) return null;
  const normalized = posix.normalize(path);
  const prefix = '/workspace/mounts/';
  if (!normalized.startsWith(prefix)) return null;
  const name = normalized.slice(prefix.length).split('/')[0];
  return name && name.length <= 255 ? name : null;
}
export function auditMetadata(operation: string, input: AuditMetadata = {}) {
  const enabled = process.env.CHATGPT_MCP_TRACE_PATHS === '1';
  const path = enabled && singlePathTools.has(operation) ? boundedPath(input.path) : null;
  const sourcePath = enabled && operation === 'fs.move' ? boundedPath(input.sourcePath) : null;
  const destinationPath = enabled && operation === 'fs.move' ? boundedPath(input.destinationPath) : null;
  const cwd = enabled && ['shell.exec', 'exec.start'].includes(operation) ? boundedPath(input.cwd) : null;
  const sourceProject = mountProject(sourcePath);
  const destinationProject = mountProject(destinationPath);
  let project = mountProject(path ?? cwd);
  let projectBasis = project ? (cwd ? 'cwd_only' : 'requested_mount_path') : 'unknown';
  if (operation === 'fs.move') {
    project = sourceProject && sourceProject === destinationProject ? sourceProject : null;
    projectBasis = project ? 'requested_mount_path' : sourceProject && destinationProject ? 'multiple' : 'unknown';
  }
  return { path, sourcePath, destinationPath, cwd, sourceProject, destinationProject, project, projectBasis,
    pathKind: cwd ? 'cwd' : path || sourcePath || destinationPath ? 'requested' : null };
}

/** Stable allowlisted metadata is repeated on every lifecycle line for robust consumers. */
export function beginToolAudit(operation: string, input: AuditMetadata = {}) {
  const started = performance.now();
  const ingressSource = diagnosticIngress();
  const fields = { traceSchemaVersion: 2, requestId: diagnosticId(), operation,
    ...auditMetadata(operation, input), ingressSource, ingressVerified: ingressSource !== null };
  const emit = (event: string, success: boolean | null, code: string | null = null) => {
    const errorCode = code === null ? null : (errorCodes as readonly string[]).includes(code) ? code : 'OS_ERROR';
    trace(event, { ...fields, success, errorCode, ...(errorCode ? { code: errorCode } : {}),
      elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
  };
  emit('tool_received', null);
  return { started: () => emit('tool_started', null), completed: () => emit('tool_completed', true),
    failed: (code: string) => emit('tool_failed', false, code) };
}
