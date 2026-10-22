# Core Access Trace v2: Console contract

Status: implemented in Core. Console parser, UI, persistence, and production end-to-end acceptance are separately owned. All examples are synthetic.

Enable JSONL on stderr with `CHATGPT_MCP_TRACE=1`. Additionally set `CHATGPT_MCP_TRACE_PATHS=1` to opt into requested paths, cwd, and derived project names. Both default off. Without path opt-in, all path/project fields are null, `pathKind` is null and `projectBasis` is `unknown`; lifecycle and authenticated ingress are still available. No runtime config or Tool API schema changes are required.

Machine-readable contract: [access-trace-v2.schema.json](access-trace-v2.schema.json), JSON Schema draft-07. Fixtures: [v2](../fixtures/access-trace-v2.jsonl) and [legacy v1](../fixtures/access-trace-v1.jsonl). The v2 schema applies only to `tool_*` events, not existing HTTP diagnostics or other stderr messages. Validators run against fixtures and actual emitted events in tests.

| Field | Definition |
| --- | --- |
| `traceSchemaVersion` | Integer `2`. Absent means historical v1. |
| `time`, `timestamp` | Equal UTC ISO-8601 timestamps generated when this line is emitted. `time` retains the old field. |
| `event` | `tool_received`, `tool_started`, `tool_completed`, `tool_failed`. |
| `requestId` | Core-generated UUID for one tool invocation, repeated through its lifecycle. Never a client-supplied JSON-RPC id. Concurrent tools receive distinct IDs even within one transport context. The error response `diagnosticId` matches this ID. The first tool retains the existing HTTP request ID correlation; further or nested invocations get new IDs. |
| `operation` | Registered tool name, e.g. `fs.read`. |
| `path` | Exact requested path for a single-path allowlisted tool; otherwise null. For `fs.restore`, this is the requested `trashPath`, not the restored output location. |
| `sourcePath`, `destinationPath` | Exact `fs.move` request endpoints. `path` stays null. |
| `cwd` | Supplied `shell.exec` / `exec.start` working directory only. No default cwd inference and no claim about files accessed. |
| `pathKind` | `requested`, `cwd`, or null. A denied path remains only a request. |
| `project` | Mount namespace component under `/workspace/mounts/<name>`, or null. Does not establish existence, authorization, configured mount membership, or physical symlink target. |
| `sourceProject`, `destinationProject` | Independently derived move endpoint namespaces, or null. |
| `projectBasis` | `requested_mount_path`: known single namespace (both move endpoints must agree); `multiple`: two different known namespaces; `cwd_only`: derived solely from supplied cwd; `unknown`: cannot assign one. |
| `ingressSource` | Exactly `Personal`, `SOOCKER`, or null. Null is the wire representation of Unknown / MCP Client. |
| `ingressVerified` | True only for a CA-validated and SHA-256-pinned client certificate on the dedicated TLS listener. Identifies route credential, not human/workspace. False always accompanies null. |
| `success` | Null on received/started, true on completed, false on failed. This is Tool API completion, not shell exit code, durable job eventual success, or business success. |
| `elapsedMs` | Nonnegative integer from a monotonic clock since tool receipt, including queue time. Every event carries elapsed time; terminal events carry total time. |
| `errorCode` | Null except on failure; fixed Core error enum in schema. No messages, details, stacks or adapter payloads. |
| `code` | Legacy failure field, equal to `errorCode`; absent otherwise. |

All fields except legacy `code` are present on every v2 lifecycle event. A queue/admission rejection can produce received → failed without started. Normal invocation produces received → started → completed/failed. Process termination may leave an incomplete lifecycle; a received/started-only row is **incomplete**, never an invented success/failure. Invalid/unknown/disabled calls rejected by the MCP SDK before a registered handler runs are protocol errors, not tool executions, and have no `tool_*` lifecycle. Trace is best-effort diagnostics, not a transactionally durable audit ledger; logging failure must not change the tool result.

## Metadata and privacy

Only pre-extracted `path`, `sourcePath`, `destinationPath`, `cwd` cross the typed audit seam. The resolver additionally checks the operation allowlist. Single paths: `fs.list/read/write/mkdir/delete/restore/purge/xpurge/replace`, `document.read`. Move: two endpoints. Shell/job start: cwd only. All other tools (including key manager, browser, screen, process, service, input) emit null path metadata. Job status/output/cancel/list never recover paths or arguments from stored jobs.

Paths are bounded to 4096 UTF-16 code units. Empty, overlong, control-character-containing and URL-like values are omitted, not truncated. Project names are at most 255 code units. Only absolute POSIX paths with a genuine `/workspace/mounts/` boundary qualify. Repeated slashes and `.` are normalized for attribution only; `..`, double-leading slash and backslash paths remain unattributed because lexical normalization could misrepresent symlink traversal. Original adapter arguments are never rewritten and no extra filesystem probes are performed. An endpoint outside a named namespace makes a move's overall project unknown, while its independently known endpoint remains available.

Path opt-in includes denied attempts and private filenames. Do not put credentials in file/directory names; an opted-in literal path is inherently visible to the log owner. This mechanism does not inspect file contents or guess secret strings. It never records content, command/args/env, confirmation tokens, API keys, passwords, headers, URLs, arbitrary parameters, tool output or exception text from those fields. No effective/canonical path is claimed. Existing permission, File Safety, output limits, tool schemas and results remain unchanged. Oversized responses now correctly produce failed/OUTPUT_LIMIT instead of a premature completed event.

## Console integration

1. Filter structured JSON lines to supported `tool_*` events. Historical events without a version remain v1. Do not feed unrelated diagnostics to the v2 schema.
2. Merge lifecycle by `requestId`; dedupe repeated lines. Keep missing v1 values unknown, never reconstruct them from timestamps or tool names. v2 repeats all metadata, allowing recovery even if the received line is missing.
3. For v2 use `time` (equal to `timestamp`) and terminal `elapsedMs`. Retain received time separately if needed. Prefer terminal state over late/duplicate earlier events; event order within a request is received < started < terminal. Conflicting terminal states are a diagnostic anomaly, not a reason to invent success.
4. Show `sourcePath → destinationPath` for moves; do not force cross-project moves into one project. Label cwd **工作目錄**, requested paths **請求路徑**.
5. Recognize Personal/SOOCKER only when `traceSchemaVersion === 2`, source is in the exact enum, and `ingressVerified === true`. Otherwise show Unknown / MCP Client. This assumes the JSONL itself came from the trusted Core log transport; importing arbitrary caller-provided JSON does not make its marker trustworthy.
6. Preserve historical rows/retention. No Console changes are part of this PR. Fixture merge tests are reference-consumer checks, not claims that the separately owned Console parser has passed integration.
