# chatgpt-mcp Core — Access Trace v2 / Codex Implementation Brief

- Date: 2026-10-22
- Status: **Approved direction / pending Codex implementation**
- Target repository: `cerjary/chatgpt-mcp` (public); implement on a feature branch and open a PR
- Companion project: Mac-local MCP Control Center (existing access-log consumer)
- Scope: trustworthy tool **requested path / project attribution** first; independently evaluate **Personal/SOOCKER ingress attribution** second
- Out of scope: rewriting the MCP tool protocol, changing capability grants, mount Apply/Rollback state machine, fabricating caller identity, persisting tool argument bodies

## 1. Problem and evidence

The Control Center Access Log shows `MCP Client`, `未提供` project and `未提供` path even when MCP operations such as `fs.read` / `fs.list` succeed.

Root cause verified in the Core source:

- `src/diagnostics.ts`: `trace()` logs timestamp/event plus explicitly passed scalar fields, and currently forbids logging arbitrary arguments.
- `src/tools/register-tools.ts`: `run()` emits `tool_received`, `tool_started`, `tool_completed`, `tool_failed` with `requestId`, `operation`, result/error code and duration; it does **not** receive per-operation path metadata.
- `src/tools/register-job-tools.ts`: job-tool trace follows a related independent wrapper; examine its compatibility before implementing v2.
- `src/http-server.ts`: creates diagnostic `requestId`, but both configured tunnels arrive at the same MCP backend without a verified per-tunnel identity.
- Control Center `src/lib/access-log.ts`: parses and merges lifecycle trace by `requestId`, persists Host-only history, and derives a project from `/workspace/mounts/<name>/...` **only if an actual path is present**.

Changing only Control Center cannot recover missing Core fields. The previous v0.1.0/v0.1.1 Control Center documents explicitly defer richer Core metadata to a later phase.

## 2. Architecture and ownership

```text
Personal ChatGPT -> Personal Tunnel --+
                                      +-> chatgpt-mcp Core -> tool handler -> ComputerAdapter
SOOCKER ChatGPT  -> SOOCKER Tunnel ---+           |
                                                  v
                                     Structured, bounded audit event
                                                  |
                                                  v
                              Docker logs (existing trace transport)
                                                  |
                                                  v
                         Control Center access-log parser / dedupe
                                                  |
                                                  v
                         Host-only persistent Access History + UI
```

**Contract**:

- Core owns what it knows at tool invocation and execution: operation, request correlation, requested path(s), cwd (execution context only), lifecycle, elapsed time.
- Core may derive `project` from a validated mount namespace prefix, with an explicit attribution basis. Unknown is `null`.
- Trusted transport/ingress infrastructure—not a caller-controlled field—must establish any Personal/SOOCKER route identifier.
- Control Center owns rendering, old/new event compatibility, Host-only retention and UI filter/export if later needed.
- Do **not** change the core mount/runtime architecture or the Control Center Desired/Applied/Runtime model.

## 3. Phase A: Path + project trace (first PR; main implementation)

### 3.1 Add small, privacy-safe audit metadata to Core

Keep existing event names and keys. Add new fields while retaining existing `requestId`, `operation`, `elapsedMs`, `code` where applicable.

Illustrative JSONL event (no user content):

```json
{
  "time": "2026-10-22T14:09:50.000Z",
  "event": "tool_received",
  "requestId": "example-uuid",
  "operation": "fs.read",
  "traceSchemaVersion": 2,
  "path": "/workspace/mounts/wow-taiwan/PM/README.md",
  "pathKind": "requested",
  "project": "wow-taiwan",
  "projectBasis": "requested_mount_path",
  "ingressSource": null
}
```

For `fs.move`, keep both paths as distinct scalar fields, e.g. `sourcePath`, `destinationPath`. Preserve a nullable single `path` for single-path operations. Do not concatenate two paths into a misleading single target. A later Control Center renderer may show source → destination. For `shell.exec`, only record `cwd`, if present, and `pathKind: "cwd"` / `projectBasis: "cwd_only"`; **do not claim that cwd equals the file actually accessed by arbitrary executed code**.

`traceSchemaVersion` is additive; historical JSONL without the field must continue to work.

### 3.2 Metadata must come from an explicit allowlist

Avoid passing a full tool argument object to `trace()`, logger middleware, or a generic recursive serializer. Never include:

- `content` / file bodies, document output, stdout/stderr, screenshot contents
- `command`, `args`, `env` for shell tools
- tokens, passwords, headers, URLs/query strings, request bodies
- arbitrary exception messages or broad adapter return objects

Allowed fields by operation (verify actual tool schemas in Core first):

| Operation family | Trace metadata | Notes |
|---|---|---|
| `fs.list/read/write/mkdir/delete/restore/purge/xpurge/replace` | `path` or appropriately named requested path | Path only, never content or confirmation token |
| `document.read` | `path` | Never extracted text |
| `fs.move` | `sourcePath`, `destinationPath` | If two different mount names: `project: null`, `projectBasis: "multiple"` |
| `shell.exec`, long-running exec jobs | `cwd` only, when actually supplied | Not proof of file access; no command or arguments |
| `system.info`, process/service/desktop/browser/other tools | `path: null` unless explicitly justified and safe | Do not infer from unrelated fields |

For filesystem tools, a path in the request is a **requested path**, not necessarily the final canonical filesystem target after symlink resolution. The audit UI must label this accurately; do not bypass authorization to obtain a resolved path. Optionally expose a separate verified effective path only when the adapter already safely returns it after normal authorization.

### 3.3 Project attribution

- Derive a project only from an absolute, normalized POSIX path **under** `/workspace/mounts/<name>`, with a true path-boundary check. `/workspace/mounts/foo2` is not project `foo`.
- Never infer a project from tool name, caller prompt, file text, host usernames or regex substrings.
- If the path is outside a named mount, relative, missing or ambiguous: `project: null`, `projectBasis: "unknown"`.
- For `sourcePath` and `destinationPath` spanning different projects, record distinct `sourceProject`/`destinationProject` if supported; otherwise use `project: null`, `projectBasis: "multiple"`.
- For `shell.exec` project derived from `cwd`, label it `cwd_only`, not `actual_file_access`.
- Mount identity comes from the stable `<name>` component. Do not assume the display name or user-supplied host directory is authoritative.
- Normalize for attribution only; never rewrite requested arguments passed to the adapter.

### 3.4 Privacy and configuration

Existing `CHATGPT_MCP_TRACE=1` emits minimal metadata. Full requested path logging is more sensitive and must be controlled via an explicit opt-in (proposed `CHATGPT_MCP_TRACE_PATHS=1`; final name/documentation by Codex). Default remains **off** for general/public deployments; this local owner-controlled deployment can enable it deliberately.

- Preserve existing trace transport and line formatting; JSONL event fields must be bounded in length and JSON-safe.
- A denied path attempt may be logged as a requested path only under the opt-in setting; do not present it as verified effective access.
- Do not log system secrets, authorization headers, file contents or arbitrary tool args even with path opt-in.
- Control Center stores history Host-only, defaults to 30-day retention and max 20,000 rows. Update its parser only for explicit new fields; preserve historical rows.
- Consider an additional UI note explaining that path metadata may contain private directory and file names.

### 3.5 Implementation seam

Currently `run(operation, concurrency, signal, fn, ...)` logs generic lifecycle data. Introduce a narrow, typed `AuditMetadata` (or equivalent) and pass **pre-extracted, allowlisted metadata** from each tool registration. Do not call a generic JSON.stringify(args) logger.

Keep all existing `run()` callers backward compatible or migrate them exhaustively. Check `register-job-tools.ts` and all supported tool families. Add a low-overhead resolver/attribution helper that has deterministic unit tests and does not perform unauthorized filesystem I/O.

Do not change externally visible MCP tool names, input/output schemas, tool responses, permission boundaries, or error handling merely to support audit.

## 4. Phase B: Trusted ingress source (separate design/review and PR)

Desired UI values:

```text
Personal
SOOCKER
Unknown / MCP Client
```

**Not feasible to certify from current Core Trace alone**: both tunnel processes send requests to the same `http://127.0.0.1:3210/mcp`. Core cannot identify the original ChatGPT connection from HTTP timing, source IP (shared local namespace), arbitrary client-supplied headers, or MCP tool parameters.

Required process before coding Phase B:

1. Inspect the actual OpenAI tunnel-client capabilities and local Compose topology to see whether an authenticated or otherwise trustworthy per-tunnel route signal is available. Do not assume tunnel-client supports custom headers.
2. Design a verified ingress attribution boundary. If considering local per-tunnel proxy/listeners, spell out which component can inject the label, how incoming caller-supplied labels are removed, how the backend distinguishes trusted from untrusted traffic, and how spoofing/cross-routing is prevented. Two unprotected localhost ports alone are an **operational routing convention, not strong client authentication**, especially with shared network namespace.
3. Determine whether this proves tunnel route, ChatGPT workspace or human identity. Unless independently verified, claim **route only**.
4. Include `ingressSource` only if the trusted route is established; otherwise `null`. No timing inference.
5. Keep both tunnels connected to the same Core service and preserve connection/health behavior.
6. Present a small deployment/rollback plan before touching active tunnel processes.

Phase A must be shippable with `ingressSource: null` and a UI fallback of `MCP Client`.

## 5. Control Center compatibility (after Core Phase A)

In `control-center/src/lib/access-log.ts`:

- Recognize new `traceSchemaVersion: 2`, `path`, `sourcePath`, `destinationPath`, `cwd`, `pathKind`, `project`, `projectBasis`, optional `ingressSource`.
- Preserve historical v1 parser paths and Host-only merge/history behavior.
- Merge lifecycle entries by existing `requestId` and retain metadata from `tool_received` when `tool_completed` omits metadata.
- Use `event` and `time` as already emitted; do not invent timestamp or duration.
- For multiple paths, UI should show an honest direction or detail view rather than hiding destination.
- For `shell.exec` display `cwd` as **工作目錄** (not actual accessed path).
- Reject/canonicalize only the defined ingress source enum from trusted Core; unknown remains `MCP Client`.
- Keep no automatic access to Host-only registry from MCP; the consumer's auth boundary remains unchanged.

Prefer a follow-up PR in the private Control Center source workflow rather than mixing Mac Control Center implementation into the public Core repository.

## 6. Test matrix / acceptance

Core unit tests:

1. `fs.read` path under `/workspace/mounts/wow-taiwan/...` → correct requested path/project.
2. `fs.list` another mount name → correct project.
3. `fs.move` same-project source/destination → source and destination preserved, project correct.
4. `fs.move` cross-project → projects distinct or `project: null` + `multiple`.
5. Root/relative/unknown/outside-mount path → `project: null`; no false prefix matching.
6. `shell.exec` with cwd → cwd-only semantics; command/args/env excluded.
7. `shell.exec` without cwd → path/project unknown.
8. `fs.replace` with secret-looking `content` → no content leakage in audit JSON.
9. `fs.read` denied path → audit shows requested vs verified distinction, and existing denial remains intact.
10. Path opt-in off → existing minimal Trace unchanged.
11. All lifecycle events share request correlation; success/failure elapsed/result remain correct.
12. No unauthorized metadata leakage (tokens, stdout/stderr, document text, URL, env).
13. Old trace line parses correctly in Control Center and merges with new entries without duplication.

Integration:

- `pnpm gate` (TypeScript, tests, build) on the correct Core checkout.
- A non-disruptive isolated/Core test with paths under two mounts, including missing-path failures.
- Only after green tests, owner-approved deployment to the Docker MCP runtime.
- Control Center displays path/project for filesystem operations; absent fields remain honest.
- Existing MCP capability grants, File Safety, image/tag, health, both tunnel connections, output limits and lifecycle idempotency remain unaffected.
- Existing Control Center Access History survives container recreation.

Acceptance for Phase B additionally requires proving a trustworthy Personal/SOOCKER route label without spoofing and exercising both tunnel routes.

## 7. Suggested work order for Codex

1. Inspect Git branch/status and live production deployment; **do not modify or restart the active MCP container/tunnels** during planning/development.
2. Create branch `feat/core-access-trace-v2` from the latest intended GitHub base. Reconcile local checkout vs GitHub before writing code; do not force-push.
3. Implement Phase A as focused commits: typed metadata / safe attribution / optional path trace / tests.
4. Run the repository's documented `pnpm gate`; report failures with evidence.
5. Update `README.md` or configuration reference with opt-in, field meanings and privacy limits.
6. Open a PR in `cerjary/chatgpt-mcp`; do not push secrets, real local paths, Mac auth state, logs or operational Compose configuration.
7. After owner reviews Core, update Control Center parser/UI in its own project and test with both v1 and v2 fixture logs.
8. Keep Phase B as a separate reviewed design/PR; don't invent tunnel-client features or trust caller-defined origin labels.

## 8. Guardrails / explicit non-goals

- **Never** emit raw MCP tool arguments, file contents, command arguments, environment variables, API keys, tokens, complete tool results or stack trace messages to access history.
- **Never** label a route Personal/SOOCKER on a guess.
- **Never** attempt to read Control Center Host-only state through MCP to enrich these logs.
- **Never** change current mounted folder allowlists or Root/Trash/permission policy as a by-product.
- **Never** silently recreate or restart the active container/tunnels while working over that same MCP connection.
- **Never** publicly upload `mounts.yaml`, private customer/project folders, runtime JSON state or live logs.
- If the Core PR cannot safely support verified route attribution, ship path/project only and document `ingressSource: null`.

## 9. Copy/paste Codex task

> In the repository `cerjary/chatgpt-mcp`, read `docs/plans/2026-10-22-CORE-ACCESS-TRACE-V2-PLAN.md` and implement **Phase A only** on a new branch. First review actual Core source and tests, then add opt-in allowlisted requested-path and project metadata to the existing JSONL `tool_*` trace without changing MCP tool schemas or leaking file content, commands, args, environment, URLs or secrets. Keep backward compatibility and run the existing Core gate. Do not restart the live MCP service, modify tunnel wiring, or implement claimed Personal/SOOCKER attribution without a separate trustworthy-ingress design. Prepare a PR summary and list Control Center parser changes required. Do not deploy or force-push.
