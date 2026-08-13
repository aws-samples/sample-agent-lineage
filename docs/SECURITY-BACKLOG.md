# Security Findings — Remediation Plan of Record

Status of the Medium/Low findings from the PCSR review, as committed to the
security reviewer. CI gates (`.gitlab-ci.yml`: ASH + IAM Access Analyzer)
prevent regression of all previously remediated findings.

## Fixed

| ID | Finding | Evidence |
|---|---|---|
| F1 (Critical) | Cross-tenant enumeration / unscoped write & read APIs | commits `40254db`, `381ab37` |
| F2 (High) | Stored XSS via `lineage_url` scheme | commit `381ab37` |
| F4 (Med) | Static, published ExternalId | commit `40254db` |
| F5 (Med) | Unauthenticated OTel ingestion | commit `381ab37`; key moved to SSM SecureString + ECS Secrets injection (this commit) |
| F11 (Med) | Self-attested audit decisions | Option A + admin-gated writes, commit `40254db` |
| F13 (Med) | No MFA on Cognito | TOTP MFA enabled `OPTIONAL` (this commit); flip to `ON` after user enrollment — target +30 days |
| F3 (Med, interim) | Tokens in localStorage | Token validity reduced 8h → 1h (this commit); full httpOnly-cookie session refactor targeted next quarter |

## Open — tracked with target timelines

| ID | Sev | Finding | Plan | Target |
|---|---|---|---|---|
| F10 | Med | No rate limiting | In-app token bucket on `POST /aws/sync`, `POST /costs/recompute` | +30 days |
| F3 | Med | Tokens in localStorage (full fix) | Backend session layer + httpOnly cookies | next quarter |
| F9 | Low | Unvalidated CloudWatch JSON | Schema/size validation in otel_translator and ingestion | +90 days |
| F12 | Low | No size/cardinality caps | Payload size limit + per-run event caps at ingestion (with F9) | +90 days |
| F6 | Low | EFS root POSIX identity | Move access point to uid 1000; requires file-ownership migration on existing EFS data | +90 days |

## Accepted risk — documented justification

| ID | Sev | Finding | Justification |
|---|---|---|---|
| F7 | Low | Auth disabled without env vars | Intentional local-development mode. The shipped CloudFormation always sets the Cognito variables, so deployed environments cannot fail open. |
| F8 | Info | No WAF | Deferred for POC (recurring cost). Revisit at production promotion together with the custom-domain / HTTPS-origin transport hardening (checkov CKV_AWS_2/103/174). |

Infra-hardening checkov items (access logging, KMS log group, S3 versioning,
HTTPS origin leg) are tracked in `.security/ash-allowlist.json` with reasons
and gate any new findings via CI.
