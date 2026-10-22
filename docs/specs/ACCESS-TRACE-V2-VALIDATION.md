# Core Access Trace v2 validation handoff

Implemented together on `feat/core-access-trace-v2`. No Console source changes, production deployment, live Core/Tunnel restart, or main merge are included.

## Completed implementation

- Typed allowlisted path metadata and conservative namespace attribution; cross-project move endpoints retained independently.
- Exact paths only with `CHATGPT_MCP_TRACE_PATHS=1`; bounded JSON-safe fields and no content/command/args/env/output logging.
- Per-invocation lifecycle correlation, including jobs and screen capture, elapsed time, terminal success/failure and stable error enums. Original HTTP/first-tool correlation retained; further tool invocations are distinct.
- Optional mTLS listener in the same Core, CA validation plus distinct certificate pins; headers cannot establish source. Existing HTTP/stdio stays Unknown.
- Final [field contract](ACCESS-TRACE-V2.md), [JSON Schema](access-trace-v2.schema.json), synthetic [v1](../fixtures/access-trace-v1.jsonl) / [v2](../fixtures/access-trace-v2.jsonl) JSONL fixtures.
- Reviewed [deployment/rollback runbook](TRUSTED-INGRESS-DEPLOYMENT.md), image build, wiring reference and executable isolated smoke script.

## Test evidence

| Check | Result |
| --- | --- |
| TypeScript typecheck and build | PASS |
| Full `pnpm gate` in isolated Linux Docker, `--init --network none` | PASS: 204 tests, 204 passed, 0 failed, 0 skipped; includes original permissions, File Safety, tool/protocol, output, jobs, concurrency, cancellation and hot-swap tests |
| New path/metadata, lifecycle, job, privacy, JSON Schema/fixture and real TLS tests | PASS, included in gate |
| Real mTLS Personal and SOOCKER requests, concurrent provenance | PASS with ephemeral test certificates |
| Forged headers on HTTP, missing certificate, wrong CA, unpinned CA-valid leaf | PASS: HTTP remains Unknown; TLS rejects unauthenticated/unmapped clients |
| Existing bearer and Origin validation on mTLS | PASS |
| Duplicate client pins / malformed operator config | PASS: configuration rejected without printing its contents |
| macOS full gate attempt | 200 passed, 2 failed, 2 skipped. The failures were pre-existing Linux-specific `/proc` and `SO_PEERCRED` requirements, resolved by running the unchanged gate on Linux |
| Linux container without init (initial attempt) | Two descendant-process cleanup checks failed due to missing orphan reaping. Re-run with Docker `--init` passed all 204; no tests were skipped or weakened |

Docker runtime image build: PASS. Isolated runtime smoke: PASS, seven real HTTP calls against two synthetic mount namespaces, including write/read/list, cross-project move, NOT_FOUND, PATH_NOT_ALLOWED, cwd-only shell execution, forged-header Unknown, and content/output non-disclosure in trace. The smoke client accepts both existing MCP JSON and SSE response encodings. Test credentials are generated in temporary directories and removed. JSONL fixtures contain only synthetic mount names and paths. Operational secrets, full local Compose, host-private customer paths, tunnel identifiers and live logs are excluded from the PR.

## Scope of evidence / remaining operator acceptance

Read-only inspection confirmed both existing v0.0.15 tunnels share Core's network namespace and target the same HTTP backend. The installed binary advertises MCP client-certificate support. This PR tests Core's implementation with actual TLS sockets and MCP requests, not production tunnel migration. Until the operator installs distinct credentials and updates the two targets, production remains Unknown. Route provenance is not human/workspace authentication.

A later approved integration window must validate each real connector, the separate Console parser/UI, retained Access History, credential mount isolation and rollback. These are deployment acceptance steps, not missing Core implementation. No code assumes those steps have already passed.

## Changed-file map

- `src/audit.ts`, `src/diagnostics.ts`: metadata, attribution, privacy and correlation.
- `src/tools/register-tools.ts`, `src/tools/register-job-tools.ts`: all registered execution wrappers and path allowlist call sites.
- `src/trusted-ingress.ts`, `src/http-server.ts`: pinned mTLS configuration, shared handler, startup/shutdown.
- `test/audit.test.ts`, `test/audit-contract.test.ts`, `test/trusted-ingress.test.ts`, `test/helpers/audit-schema.ts`: regression, schema and transport verification.
- `docs/specs/ACCESS-TRACE-V2*.md`, `docs/specs/access-trace-v2.schema.json`, `docs/specs/TRUSTED-INGRESS-DEPLOYMENT.md`, `docs/fixtures/access-trace-v*.jsonl`, `README.md`: final consumer contract and operational handoff.
- `deploy/Dockerfile.trace-v2`, `deploy/ingress-wiring.example.yaml`, `.dockerignore`, `scripts/verify-access-trace.mjs`: safe isolated packaging/verification and operator wiring reference.
- `package.json`, `pnpm-lock.yaml`: Ajv and format support for schema validation in tests only; no new runtime dependencies.
