# Agent Lineage — The Map of Agents

Agent Lineage is an end-to-end provenance, governance, and cost visibility tool for
agentic AI platforms built on Amazon Bedrock AgentCore. It syncs read-only from your
AWS account and builds a living access graph — user groups → agents → sub-agents →
skills → gateways → tools → LLMs → resources — where every connection is classified
as **declared** (registered permission) or **observed** (proven by runtime traffic),
making unused privileges and access drift visible at a glance. Around that graph it
unifies the operational record: Cedar policy decisions per gateway, guardrail
interventions, identity and credential chains, online and on-demand evaluation
results, and full run trajectories rendered as execution graphs with token and
dollar cost attribution per agent and per model. It ships as a single CloudFormation
stack (CloudFront, Fargate, Cognito) with a React lineage UI — think
*"OpenLineage for agents."*

```
User Group → Agent → Sub-agents → Skills → Gateways → Tools / LLMs → Resources
```

Research and architecture analysis: [`docs/RESEARCH.md`](docs/RESEARCH.md) ·
Diagrams: [`deploy/architecture.drawio`](deploy/architecture.drawio),
[`deploy/data-ingestion-flow.drawio`](deploy/data-ingestion-flow.drawio)

## Stack

- **Backend** — Python 3.12, FastAPI, SQLAlchemy (SQLite on EFS; Postgres-ready), boto3
- **Frontend** — React 18 + TypeScript, Vite, React Flow + dagre, light/dark themes
- **Deployment** — CloudFormation: CloudFront + S3 (OAC), ALB + ECS Fargate, EFS, Cognito

## Local quick start

```bash
# Backend (http://localhost:8000, docs at /docs)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m app.seed          # demo dataset (remove: python -m app.purge default)
.venv/bin/uvicorn app.main:app --port 8000 --reload

# Frontend (http://localhost:5173, proxies /api to the backend)
cd frontend
npm install
npm run dev
```

Locally, authentication is disabled and the "Connect AWS" button uses whatever
credentials the backend process has (env vars or the default profile chain).

## Deploying to an AWS account

Prerequisites: AWS CLI with deploy-capable credentials, Docker running, Node.js, openssl.

```bash
# 1. Confirm identity and target account
aws sts get-caller-identity

# 2a. Deploy creating a dedicated VPC
./deploy/deploy.sh us-west-2

# 2b. Or reuse an existing VPC (two PUBLIC subnets in different AZs, IGW-routed)
./deploy/deploy.sh us-west-2 vpc-xxxxxxxx subnet-aaaa,subnet-bbbb
```

The script builds and pushes the backend image to ECR, deploys/updates the
CloudFormation stack (`deploy/template.yaml`), builds the frontend, syncs it to S3,
and invalidates CloudFront. First deploy takes ~10 minutes (CloudFront); updates ~5–8.

```bash
# 3. Create your first user (self-signup is disabled by design)
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId from stack outputs> \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --region us-west-2
# Optional: set a permanent password directly
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> \
  --username you@example.com --password 'YourStrongPassword123' --permanent --region us-west-2
```

4. Open the `AppUrl` stack output, log in, click **Connect AWS**, pick the region,
   leave profile/role empty (the Fargate task role is used automatically), and Sync.

What the stack secures: private S3 (OAC-only), ALB that answers 403 without the
CloudFront origin-verify header, Cognito JWT required on every API call, EFS
encrypted, and a read-only task IAM role for all AWS syncing.

## Sync role and required permissions

The sync is strictly read-only. The deployed stack creates the role automatically
(`agent-lineage-readonly-sync`, attached to the Fargate task); for local use or
cross-account syncing, create a role/user with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AgentLineageReadOnlySync",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:List*",
        "bedrock-agentcore:Get*",
        "bedrock:ListGuardrails",
        "bedrock:GetGuardrail",
        "logs:FilterLogEvents",
        "logs:DescribeLogGroups"
      ],
      "Resource": "*"
    }
  ]
}
```

What each permission feeds: `bedrock-agentcore` List/Get covers AgentCore Runtime
agents, Gateways + targets, Identity (workload identities, credential providers —
metadata only, never secret values), Registry records, and Evaluations;
`bedrock:*Guardrail*` covers guardrail nodes; `logs:FilterLogEvents` reads OTel
GenAI spans from `aws/spans` (runs, tokens, cost) and online-evaluation result
log groups.

**Cross-account (hub-and-spoke):** create the role above in each spoke account with
a trust policy allowing the hub's task role to assume it, then enter the spoke role
ARN in the Connect AWS modal:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::HUB_ACCOUNT_ID:role/agent-lineage-readonly-sync" },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "agent-lineage" } }
    }
  ]
}
```

Note: the hub task role additionally needs `sts:AssumeRole` on
`arn:aws:iam::*:role/agent-lineage-readonly` — not included in the stack by default
(single-account deployments stay minimal); add it when enabling spokes.

## Core concepts

| Concept | Description |
|---|---|
| **Node** | `user_group`, `agent`, `skill`, `prompt`, `identity`, `credential`, `gateway`, `guardrail`, `tool`, `llm`, `resource` |
| **Edge** | `INVOKES`, `DELEGATES_TO`, `HAS_SKILL`, `USES_PROMPT`, `AUTHENTICATES_AS`, `USES_CREDENTIAL`, `GRANTS_ACCESS_TO`, `USES_TOOL`, `CALLS_LLM`, `ACCESSES`, `ROUTES_TO`, `GUARDED_BY` |
| **Origin** | `declared` (registry/config), `observed` (runtime), `both` — the delta powers least-privilege analysis |
| **Gateway** | Carries its Cedar policies; per-call ALLOW/DENY decisions are logged and accumulated on edges |
| **Run / Event** | OpenLineage-style run events (`START`/`ACCESS`/`COMPLETE`/`FAIL`), mapped from OTel GenAI spans; failures carry exception details; each run links to its CloudWatch trace |
| **Facets** | Free-form JSON metadata on any node, edge or run |
| **Namespace** | `account/region` — multiple accounts/regions coexist in one graph |

## Key API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/aws/sync` | Pull real data from an AWS account (region + optional profile/role ARN) |
| `POST /api/v1/lineage/events` | Ingest observed runtime events (OTel-compatible; incl. token usage, gateway calls, guardrail events) |
| `GET /api/v1/lineage/graph?node_id=&depth=` | Directional lineage graph; repeat `node_id` for multi-focus |
| `GET /api/v1/search?q=` | Cross-type catalog search (agents, tools, skills, gateways, LLMs…) |
| `GET /api/v1/runs`, `GET /api/v1/runs/{id}/timeline` | Paginated run history with cost rollups; per-run trajectory |
| `GET /api/v1/costs/{agent_id}`, `GET /api/v1/llm-stats` | Cost attribution per agent / per model (time-windowed) |
| `GET /api/v1/cedar-decisions`, `GET /api/v1/guardrail-interventions` | Governance audit logs |
| `GET /api/v1/evaluations?agent_id=` | Online + on-demand evaluation results |
| `DELETE /api/v1/namespaces/{ns}` | Purge one namespace (e.g. the demo dataset) |

## Notes

- Cost is derived from token usage via each LLM node's `pricing_per_1k` facet, with a
  built-in pricing catalog fallback; `POST /api/v1/costs/recompute` backfills.
- The spans/eval lookback windows default to 30 days
  (`AGENT_LINEAGE_SPANS_WINDOW_HOURS`, `AGENT_LINEAGE_EVAL_RESULTS_WINDOW_HOURS`).
- Streaming ingestion skeleton: `integrations/otel_translator/handler.py`
  (CloudWatch Logs subscription → lineage events), for when pull-based sync isn't fresh enough.
