"""Full-coverage demo dataset: an enterprise AgentCore platform ("Acme").

Scale: 12 agents (5 root orchestrators + sub-agents + one external A2A partner),
3 gateways fronting 30 tools with Cedar policies, 4 direct tools, 12 skills,
4 LLMs with pricing + guardrails, 10 resources across 8 storage kinds with
OpenLineage data-lineage facets, identity/credential chains, versioned prompts,
evaluations, and ~2 weeks of observed runs (Cedar denies, guardrail blocks,
multi-LLM token usage, version history).

Run:   python -m app.seed
Purge: python -m app.purge default
"""
import random
import uuid
from datetime import datetime, timedelta, timezone

from .database import Base, SessionLocal, engine
from .ingest import ingest_event, upsert_edge, upsert_node
from .models import Evaluation
from .schemas import (
    AgentRunEvent,
    EntityRef,
    GatewayCall,
    GuardrailEvent,
    LLMUsageRef,
    node_id,
)

ACCOUNT = "123456789012"
REGION = "us-east-1"
NS = "default"


def nid(node_type: str, name: str) -> str:
    return node_id(NS, node_type, name)


def _registry(record_type: str, version: str, status: str, publisher: str, **extra) -> dict:
    return {
        "registry_name": "acme-platform-registry",
        "registry_id": "AcmeReg01",
        "record_id": f"rec-{uuid.uuid5(uuid.NAMESPACE_DNS, record_type + version + publisher + str(extra)).hex[:10]}",
        "record_type": record_type,
        "record_version": version,
        "status": status,
        "publisher": publisher,
        "curator": "ai-governance-team",
        "source": "demo:acme-platform-registry",
        **extra,
    }


# ---------------- LLMs (4) ----------------
# (name, desc, provider, pricing per 1k in/out, guardrail)
LLMS = [
    ("claude-sonnet-4-5", "Anthropic Claude Sonnet 4.5 via Bedrock", "Amazon Bedrock",
     (0.003, 0.015), "enterprise-pii-shield"),
    ("claude-haiku-4-5", "Anthropic Claude Haiku 4.5 via Bedrock", "Amazon Bedrock",
     (0.001, 0.005), "enterprise-pii-shield"),
    ("nova-pro", "Amazon Nova Pro for analytical workloads", "Amazon Bedrock",
     (0.0008, 0.0032), "content-safety-standard"),
    ("gpt-4o-mini", "OpenAI GPT-4o mini for cheap classification", "OpenAI (via Identity vault)",
     (0.00015, 0.0006), None),
]

# ---------------- Guardrails (2) ----------------
GUARDRAILS = [
    ("enterprise-pii-shield", "Blocks PII leakage and prompt injection on model I/O",
     ["pii-entities: BLOCK", "prompt-attack: BLOCK", "secrets: BLOCK"]),
    ("content-safety-standard", "Standard content moderation for analytical agents",
     ["hate: BLOCK", "violence: BLOCK", "profanity: MASK"]),
]

# ---------------- User groups (4) ----------------
USER_GROUPS = [
    ("support-team", "Tier-1/2 customer support staff", 64),
    ("finance-ops", "Finance operations analysts", 22),
    ("hr-partners", "HR business partners", 15),
    ("devops-oncall", "DevOps on-call engineers", 31),
]

# ---------------- Resources (10, 8 kinds, with data lineage) ----------------
def _dl(namespace: str, dataset: str, jobs: list[str]) -> dict:
    return {
        "standard": "OpenLineage",
        "namespace": namespace,
        "dataset": dataset,
        "upstream_jobs": jobs,
        "lineage_url": f"https://marquez.acme.internal/datasets/{namespace.replace('://', '%3A%2F%2F')}/{dataset}",
    }

RESOURCES = [
    ("customer-db", "Aurora PostgreSQL customer master (PII)", "aurora-postgresql", "restricted (PII)",
     _dl("postgres://customer-prod", "public.customers", ["airflow.customer_sync", "dbt.customer_model"])),
    ("invoices-warehouse", "Redshift finance marts", "redshift", "confidential",
     _dl("redshift://acme-dw", "finance.invoices", ["dbt.finance_marts", "airflow.billing_daily_load"])),
    ("tickets-attachments", "S3 bucket for support ticket attachments", "s3", "confidential",
     _dl("s3://acme-ticket-attachments", "attachments", ["lambda.attachment_scanner"])),
    ("kb-index", "OpenSearch Serverless knowledge-base index", "opensearch-serverless", "internal",
     _dl("aoss://kb-prod", "kb-articles-v4", ["airflow.kb_articles_sync", "spark.kb_embedder_v4"])),
    ("employee-records", "DynamoDB employee records (PII)", "dynamodb", "restricted (PII)",
     _dl("dynamodb://us-east-1", "employee-records", ["glue.hr_workday_ingest"])),
    ("payroll-db", "Aurora payroll database (highly restricted)", "aurora-postgresql", "restricted (payroll)",
     _dl("postgres://payroll-prod", "public.payroll_runs", ["airflow.payroll_close"])),
    ("metrics-stream", "Kinesis stream of service metrics", "kinesis", "internal",
     _dl("kinesis://us-east-1", "svc-metrics-v2", ["flink.metrics_aggregator"])),
    ("deploy-artifacts", "S3 bucket of deployment artifacts", "s3", "internal",
     _dl("s3://acme-deploy-artifacts", "artifacts", ["codepipeline.release_build"])),
    ("feature-store", "SageMaker Feature Store: customer 360 features", "sagemaker-feature-store", "confidential",
     _dl("sagemaker://acme-fs", "customer-360-v3", ["spark.feature_pipeline_v3"])),
    ("shared-memory-store", "AgentCore Memory store (conversation + facts)", "agentcore-memory", "confidential",
     _dl("agentcore-memory://acme", "shared-mem", ["agentcore.memory_extraction"])),
]

# ---------------- Gateways with tools (3 gateways, 30 tools) ----------------
# tool tuple: (name, desc, target_type, [tool definitions], accesses_resource|None)
GATEWAYS = {
    "enterprise-api-gateway": {
        "desc": "AgentCore Gateway fronting core business APIs",
        "inbound_auth": "OAuth2 (Cognito authorizer)",
        "cedar_policies": {
            "support-tools-any-support-agent":
                'permit(\n  principal in AgentGroup::"support",\n  action in [Action::"tickets:*", Action::"crm:read"],\n  resource in Gateway::"enterprise-api-gateway"\n);',
            "refunds-under-1000":
                'permit(\n  principal == AgentIdentity::"billing-agent",\n  action == Action::"refunds:write",\n  resource in Gateway::"enterprise-api-gateway"\n)\nwhen { context.amount_usd <= 1000 };',
            "no-payment-writes-after-hours":
                'forbid(\n  principal,\n  action == Action::"payments:write",\n  resource in Gateway::"enterprise-api-gateway"\n)\nwhen { context.hour < 6 || context.hour > 22 };',
        },
        "tools": [
            ("create-ticket", "Create a support ticket", "openApiSchema -> Zendesk",
             ["create_ticket(subject, body, priority)"], "tickets-attachments"),
            ("update-ticket", "Update ticket status/comments", "openApiSchema -> Zendesk",
             ["update_ticket(ticket_id, status, comment)"], None),
            ("search-tickets", "Search tickets by customer or text", "openApiSchema -> Zendesk",
             ["search_tickets(query, limit)"], None),
            ("customer-lookup", "Look up customer profile", "lambda",
             ["get_customer(customer_id)", "search_customers(email)"], "customer-db"),
            ("subscription-manage", "Change customer subscriptions", "lambda",
             ["upgrade_plan(customer_id, plan)", "cancel_subscription(customer_id)"], "customer-db"),
            ("refund-processor", "Issue refunds via Stripe", "openApiSchema -> Stripe",
             ["create_refund(charge_id, amount_usd)", "get_refund(refund_id)"], None),
            ("invoice-fetch", "Fetch invoices and line items", "lambda",
             ["get_invoice(invoice_id)", "list_invoices(customer_id, since)"], "invoices-warehouse"),
            ("payment-status", "Check payment status", "openApiSchema -> Stripe",
             ["get_charge(charge_id)"], None),
            ("crm-notes", "Read/write CRM account notes", "openApiSchema -> Salesforce",
             ["add_note(account_id, note)", "list_notes(account_id)"], None),
            ("sla-monitor", "Check SLA breach risk for tickets", "lambda",
             ["check_sla(ticket_id)"], None),
            ("escalation-router", "Route tickets to the right team", "lambda",
             ["route(ticket_id, team)"], None),
            ("notification-sender", "Send customer notifications", "lambda",
             ["send_email(customer_id, template, vars)"], None),
        ],
    },
    "data-platform-gateway": {
        "desc": "AgentCore Gateway fronting the data platform",
        "inbound_auth": "SigV4 (workload identity)",
        "cedar_policies": {
            "read-only-analytics":
                'permit(\n  principal in AgentGroup::"analytics",\n  action == Action::"sql:select",\n  resource in Gateway::"data-platform-gateway"\n);',
            "no-pii-columns":
                'forbid(\n  principal,\n  action == Action::"sql:select",\n  resource in Gateway::"data-platform-gateway"\n)\nwhen { context.columns.containsAny(["ssn", "dob", "salary"]) };',
        },
        "tools": [
            ("sql-query-runner", "Run read-only SQL on the warehouse", "lambda",
             ["run_query(sql, limit)"], "invoices-warehouse"),
            ("warehouse-export", "Export query results to S3", "lambda",
             ["export(sql, s3_prefix)"], "deploy-artifacts"),
            ("kb-semantic-search", "Semantic search over the KB", "mcp -> runtime",
             ["semantic_search(query, top_k)", "get_document(doc_id)"], "kb-index"),
            ("metrics-reader", "Read service metrics windows", "lambda",
             ["get_metrics(service, window)"], "metrics-stream"),
            ("feature-lookup", "Fetch customer-360 features", "lambda",
             ["get_features(customer_id, feature_group)"], "feature-store"),
            ("data-quality-check", "Run DQ suites on a dataset", "lambda",
             ["run_dq(dataset, suite)"], None),
            ("lineage-inspector", "Query OpenLineage/Marquez lineage", "openApiSchema -> Marquez",
             ["get_dataset_lineage(namespace, dataset)"], None),
            ("s3-object-fetch", "Fetch objects with presigned URLs", "lambda",
             ["presign(bucket, key, ttl)"], "tickets-attachments"),
        ],
    },
    "saas-connect-gateway": {
        "desc": "AgentCore Gateway fronting SaaS integrations",
        "inbound_auth": "OAuth2 (Cognito authorizer)",
        "cedar_policies": {
            "hr-tools-hr-agents-only":
                'permit(\n  principal in AgentGroup::"hr",\n  action in [Action::"workday:read", Action::"payroll:adjust"],\n  resource in Gateway::"saas-connect-gateway"\n);',
            "payroll-adjust-limit":
                'permit(\n  principal == AgentIdentity::"hr-assistant",\n  action == Action::"payroll:adjust",\n  resource in Gateway::"saas-connect-gateway"\n)\nwhen { context.delta_usd <= 250 };',
        },
        "tools": [
            ("slack-post", "Post messages to Slack channels", "openApiSchema -> Slack",
             ["post_message(channel, text)"], None),
            ("jira-issue", "Create/update Jira issues", "openApiSchema -> Jira",
             ["create_issue(project, summary, priority)", "transition(issue, state)"], None),
            ("confluence-search", "Search Confluence spaces", "openApiSchema -> Confluence",
             ["search(cql, limit)"], None),
            ("github-pr", "Open and review GitHub PRs", "openApiSchema -> GitHub",
             ["open_pr(repo, branch, title)", "comment(pr, body)"], "deploy-artifacts"),
            ("pagerduty-alert", "Trigger/resolve PagerDuty incidents", "openApiSchema -> PagerDuty",
             ["trigger(service, summary)", "resolve(incident_id)"], None),
            ("workday-hr-lookup", "Look up employee HR records", "openApiSchema -> Workday",
             ["get_employee(emp_id)", "get_org(emp_id)"], "employee-records"),
            ("payroll-adjust", "Submit payroll adjustments", "lambda",
             ["adjust(emp_id, delta_usd, reason)"], "payroll-db"),
            ("calendar-schedule", "Schedule meetings", "openApiSchema -> Google Calendar",
             ["schedule(attendees, when, title)"], None),
            ("docusign-send", "Send documents for signature", "openApiSchema -> DocuSign",
             ["send_envelope(template, recipient)"], None),
            ("salesforce-opportunity", "Manage sales opportunities", "openApiSchema -> Salesforce",
             ["update_opportunity(opp_id, stage)"], None),
        ],
    },
}

# Direct (non-gateway) tools.
DIRECT_TOOLS = [
    ("code-interpreter", "AgentCore built-in Code Interpreter", "AgentCore built-in tool", [], None),
    ("browser-tool", "AgentCore built-in Browser", "AgentCore built-in tool", [], None),
    ("vector-search-mcp", "MCP server on AgentCore Runtime: vector search", "AgentCore Runtime (MCP server)",
     ["similar_docs(text, top_k)"], "kb-index"),
    ("log-analyzer-mcp", "MCP server: parse and cluster service logs", "AgentCore Runtime (MCP server)",
     ["cluster_errors(service, window)"], "metrics-stream"),
]

# ---------------- Skills (12) ----------------
SKILLS = [
    ("ticket-triage", "Classify and route tickets by intent and severity", "platform-team"),
    ("ticket-summarization", "Summarize ticket threads into agent-ready briefs", "support-tools-team"),
    ("refund-policy", "Policy-aware refund decisioning", "billing-team"),
    ("grounded-answering", "RAG answers with citation enforcement", "platform-team"),
    ("sql-generation", "Text-to-SQL with schema awareness", "data-team"),
    ("reconciliation-rules", "Invoice/ledger reconciliation heuristics", "finance-team"),
    ("audit-trail-analysis", "Trace anomalies across audit logs", "finance-team"),
    ("hr-policy-qa", "HR policy question answering", "hr-tools-team"),
    ("onboarding-checklist", "New-hire onboarding orchestration", "hr-tools-team"),
    ("incident-runbook", "Runbook-guided incident response", "devops-team"),
    ("postmortem-writing", "Structured postmortem drafting", "devops-team"),
    ("brand-voice", "Marketing brand-voice rewriting", "marketing-team"),
]

# ---------------- Prompts (versioned) ----------------
PROMPTS = {
    "support-orchestrator-prompt": ("System prompt for the support orchestrator", [
        ("v14", "2026-07-14", "j.rivera", "Tighten refund escalation wording"),
        ("v13", "2026-06-30", "j.rivera", "Add fraud-review A2A handoff"),
        ("v12", "2026-06-02", "m.chen", "Initial multi-agent routing rules"),
    ]),
    "finance-orchestrator-prompt": ("System prompt for the finance orchestrator", [
        ("v6", "2026-07-08", "k.osei", "Add month-end close guardrails"),
        ("v5", "2026-06-12", "k.osei", "Reconciliation delegation rules"),
    ]),
    "hr-assistant-prompt": ("System prompt for the HR assistant", [
        ("v9", "2026-07-01", "l.novak", "Payroll adjustment limits in instructions"),
        ("v8", "2026-05-20", "l.novak", "Onboarding checklist handoff"),
    ]),
    "devops-incident-prompt": ("System prompt for the incident agent", [
        ("v11", "2026-07-10", "s.imani", "Prefer runbook steps before improvising"),
        ("v10", "2026-06-25", "s.imani", "Postmortem writer delegation"),
    ]),
}

# ---------------- Agents (12) ----------------
# gateway_tools: {gateway: [tool names used]}  (declared USES_TOOL agent->gateway + drives runs)
AGENTS = [
    {
        "name": "support-orchestrator", "desc": "Root agent routing customer support requests",
        "framework": "strands-agents 1.4", "versions": ["2.4.0", "2.3.1"], "owner": "platform-team",
        "groups": ["support-team"], "subs": ["billing-agent", "kb-research-agent"],
        "gateway_tools": {"enterprise-api-gateway": ["create-ticket", "update-ticket", "search-tickets", "customer-lookup", "sla-monitor", "escalation-router", "notification-sender"]},
        "direct_tools": ["code-interpreter"], "llms": ["claude-sonnet-4-5"],
        "resources": ["shared-memory-store"], "skills": ["ticket-triage", "ticket-summarization"],
        "prompt": "support-orchestrator-prompt",
    },
    {
        "name": "billing-agent", "desc": "Sub-agent for billing, refunds and subscriptions",
        "framework": "langgraph 0.5", "versions": ["1.9.0"], "owner": "billing-team",
        "subs": ["fraud-review-agent"],
        "gateway_tools": {"enterprise-api-gateway": ["refund-processor", "invoice-fetch", "payment-status", "subscription-manage"]},
        "llms": ["claude-haiku-4-5", "gpt-4o-mini"], "resources": ["customer-db"],
        "skills": ["refund-policy"],
    },
    {
        "name": "kb-research-agent", "desc": "Sub-agent for knowledge-base research (RAG)",
        "framework": "strands-agents 1.4", "versions": ["3.1.0"], "owner": "platform-team",
        "gateway_tools": {"data-platform-gateway": ["kb-semantic-search"]},
        "direct_tools": ["vector-search-mcp"], "llms": ["claude-sonnet-4-5"],
        "resources": ["kb-index"], "skills": ["grounded-answering"],
    },
    {
        "name": "finance-orchestrator", "desc": "Root agent for finance operations workflows",
        "framework": "strands-agents 1.4", "versions": ["1.2.0", "1.1.2"], "owner": "finance-team",
        "groups": ["finance-ops"], "subs": ["reconciliation-agent", "audit-agent"],
        "gateway_tools": {"enterprise-api-gateway": ["invoice-fetch"], "data-platform-gateway": ["sql-query-runner", "data-quality-check"]},
        "llms": ["claude-sonnet-4-5"], "resources": ["shared-memory-store"],
        "skills": ["sql-generation"], "prompt": "finance-orchestrator-prompt",
    },
    {
        "name": "reconciliation-agent", "desc": "Sub-agent reconciling invoices against the ledger",
        "framework": "langgraph 0.5", "versions": ["2.0.1"], "owner": "finance-team",
        "gateway_tools": {"data-platform-gateway": ["sql-query-runner", "warehouse-export"]},
        "llms": ["nova-pro"], "resources": ["invoices-warehouse"],
        "skills": ["reconciliation-rules"],
    },
    {
        "name": "audit-agent", "desc": "Sub-agent tracing anomalies across audit trails",
        "framework": "crewai 0.9", "versions": ["1.0.3"], "owner": "finance-team",
        "gateway_tools": {"data-platform-gateway": ["lineage-inspector", "sql-query-runner"]},
        "llms": ["nova-pro"], "resources": ["invoices-warehouse"],
        "skills": ["audit-trail-analysis"],
    },
    {
        "name": "hr-assistant", "desc": "Root agent for HR partner workflows",
        "framework": "strands-agents 1.4", "versions": ["3.0.0", "2.9.4"], "owner": "hr-tools-team",
        "groups": ["hr-partners"], "subs": ["onboarding-agent"],
        "gateway_tools": {"saas-connect-gateway": ["workday-hr-lookup", "payroll-adjust", "calendar-schedule"]},
        "llms": ["claude-haiku-4-5"], "resources": ["employee-records", "payroll-db", "shared-memory-store"],
        "skills": ["hr-policy-qa"], "prompt": "hr-assistant-prompt",
    },
    {
        "name": "onboarding-agent", "desc": "Sub-agent orchestrating new-hire onboarding",
        "framework": "langgraph 0.5", "versions": ["1.4.0"], "owner": "hr-tools-team",
        "gateway_tools": {"saas-connect-gateway": ["calendar-schedule", "docusign-send", "jira-issue"]},
        "llms": ["claude-haiku-4-5"], "resources": ["employee-records"],
        "skills": ["onboarding-checklist"],
    },
    {
        "name": "devops-incident-agent", "desc": "Root agent for incident response",
        "framework": "strands-agents 1.4", "versions": ["4.2.0", "4.1.0"], "owner": "devops-team",
        "groups": ["devops-oncall"], "subs": ["postmortem-writer"],
        "gateway_tools": {"saas-connect-gateway": ["pagerduty-alert", "jira-issue", "github-pr", "slack-post"],
                          "data-platform-gateway": ["metrics-reader"]},
        "direct_tools": ["log-analyzer-mcp", "browser-tool"], "llms": ["claude-sonnet-4-5"],
        "resources": ["metrics-stream", "deploy-artifacts"], "skills": ["incident-runbook"],
        "prompt": "devops-incident-prompt",
    },
    {
        "name": "postmortem-writer", "desc": "Sub-agent drafting structured postmortems",
        "framework": "strands-agents 1.4", "versions": ["1.1.0"], "owner": "devops-team",
        "gateway_tools": {"saas-connect-gateway": ["confluence-search", "slack-post"]},
        "llms": ["nova-pro"], "resources": [], "skills": ["postmortem-writing"],
    },
    {
        "name": "marketing-content-agent", "desc": "Root agent for campaign content operations",
        "framework": "langgraph 0.5", "versions": ["0.9.0"], "owner": "marketing-team",
        "groups": ["support-team"],
        "gateway_tools": {"saas-connect-gateway": ["slack-post", "salesforce-opportunity"],
                          "data-platform-gateway": ["feature-lookup"]},
        "llms": ["gpt-4o-mini", "nova-pro"], "resources": ["feature-store"],
        "skills": ["brand-voice"],
    },
    {
        "name": "fraud-review-agent", "desc": "External partner agent for fraud review (A2A)",
        "framework": "unknown (A2A peer)", "versions": ["0.9.1"], "owner": "risk-team",
        "external": True, "gateway_tools": {}, "llms": [], "resources": [], "skills": [],
    },
]

# ---------------- Identity & credentials ----------------
CREDENTIALS = [
    ("stripe-restricted-key", "API key (restricted)", "Stripe", "gateway", "enterprise-api-gateway"),
    ("salesforce-oauth-client", "OAuth2 client-credentials", "Salesforce", "gateway", "enterprise-api-gateway"),
    ("workday-oauth-client", "OAuth2 client-credentials", "Workday", "gateway", "saas-connect-gateway"),
    ("slack-bot-token", "Bot token", "Slack", "gateway", "saas-connect-gateway"),
    ("github-app-token", "GitHub App installation token", "GitHub", "gateway", "saas-connect-gateway"),
    ("openai-api-key", "API key", "OpenAI", "llm", "gpt-4o-mini"),
]
# agent name -> credentials its identity uses
AGENT_CREDENTIALS = {
    "billing-agent": ["stripe-restricted-key"],
    "support-orchestrator": ["salesforce-oauth-client"],
    "hr-assistant": ["workday-oauth-client"],
    "devops-incident-agent": ["slack-bot-token", "github-app-token"],
    "marketing-content-agent": ["openai-api-key", "salesforce-oauth-client"],
}

# ---------------- Evaluations ----------------
EVALUATIONS = [
    ("support-orchestrator", "online-helpfulness-monitor", "online", "ENABLED", None,
     {"evaluators": ["helpfulness-judge-v2"], "sampling": "20% of invocations"}),
    ("hr-assistant", "online-pii-monitor", "online", "ENABLED", None,
     {"evaluators": ["pii-leak-detector"], "sampling": "100% of invocations"}),
    ("support-orchestrator", "trajectory-eval-v4", "trajectory", "PASSED", 0.93, {"cases": 180}),
    ("support-orchestrator", "helpfulness-llm-judge", "correctness", "PASSED", 0.89, {"judge": "claude-sonnet-4-5", "cases": 240}),
    ("support-orchestrator", "guardrail-safety-suite", "safety", "PASSED", 0.99, {"checks": ["pii-leak", "prompt-injection"]}),
    ("billing-agent", "refund-policy-compliance", "correctness", "FAILED", 0.74, {"cases": 80, "notes": "4 over-limit refunds attempted"}),
    ("billing-agent", "trajectory-eval-v4", "trajectory", "PASSED", 0.91, {"cases": 80}),
    ("kb-research-agent", "rag-faithfulness", "correctness", "PASSED", 0.95, {"metric": "faithfulness + citations", "cases": 150}),
    ("finance-orchestrator", "close-process-eval", "trajectory", "PASSED", 0.9, {"cases": 60}),
    ("reconciliation-agent", "recon-accuracy", "correctness", "PASSED", 0.97, {"cases": 400}),
    ("audit-agent", "anomaly-recall", "correctness", "FAILED", 0.68, {"cases": 90, "notes": "missed cross-ledger anomalies"}),
    ("hr-assistant", "hr-policy-accuracy", "correctness", "PASSED", 0.92, {"cases": 120}),
    ("hr-assistant", "pii-handling-suite", "safety", "PASSED", 1.0, {"checks": ["pii-leak"]}),
    ("onboarding-agent", "checklist-completion", "trajectory", "PASSED", 0.88, {"cases": 45}),
    ("devops-incident-agent", "runbook-adherence", "trajectory", "PASSED", 0.86, {"cases": 70}),
    ("devops-incident-agent", "mttr-improvement", "custom", "RUNNING", None, {"window": "Q3"}),
    ("postmortem-writer", "postmortem-quality-judge", "correctness", "PASSED", 0.9, {"judge": "nova-pro"}),
    ("marketing-content-agent", "brand-voice-eval", "correctness", "PASSED", 0.84, {"cases": 55}),
]


def _seed_nodes_and_edges(db) -> None:
    # User groups.
    for name, desc, members in USER_GROUPS:
        n = upsert_node(db, EntityRef(node_type="user_group", name=name, facets={
            "idp": "okta", "members": members,
            "access_via": "AgentCore Identity (inbound OAuth)",
        }))
        n.description = desc

    # LLMs + guardrails + GUARDED_BY.
    for gname, gdesc, policies in GUARDRAILS:
        n = upsert_node(db, EntityRef(node_type="guardrail", name=gname, facets={
            "provider": "Amazon Bedrock Guardrails",
            "arn": f"arn:aws:bedrock:{REGION}:{ACCOUNT}:guardrail/{gname}",
            "policies": policies, "applied_on": "model input + output",
        }))
        n.description = gdesc
    for lname, ldesc, provider, (pin, pout), guardrail in LLMS:
        n = upsert_node(db, EntityRef(node_type="llm", name=lname, facets={
            "provider": provider, "model_id": lname,
            "pricing_per_1k": {"input_usd": pin, "output_usd": pout},
        }))
        n.description = ldesc
        db.flush()
        if guardrail:
            upsert_edge(db, nid("llm", lname), nid("guardrail", guardrail),
                        "GUARDED_BY", origin="declared", facets={"applied_on": "input + output"})

    # Resources with data lineage.
    for rname, rdesc, kind, classification, dl in RESOURCES:
        n = upsert_node(db, EntityRef(node_type="resource", name=rname, facets={
            "kind": kind, "classification": classification,
            "arn": f"arn:aws:{kind.split('-')[0]}:{REGION}:{ACCOUNT}:{rname}",
            "data_lineage": dl,
        }))
        n.description = rdesc

    # Gateways, their tools, ROUTES_TO, tool registry records + resource ACCESSES.
    for gwname, gw in GATEWAYS.items():
        n = upsert_node(db, EntityRef(node_type="gateway", name=gwname, facets={
            "arn": f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:gateway/{gwname}",
            "inbound_auth": gw["inbound_auth"], "protocol": "MCP (streamable HTTP)",
            "cedar_policies": gw["cedar_policies"],
            "targets": [t[0] for t in gw["tools"]],
        }))
        n.description = gw["desc"]
        db.flush()
        for tname, tdesc, ttype, defs, accesses in gw["tools"]:
            t = upsert_node(db, EntityRef(node_type="tool", name=tname, facets={
                "hosting": f"Gateway target ({ttype})",
                "registry": _registry("MCP", "1.0.0", "APPROVED", "platform-team",
                                      tool_definitions=defs),
            }))
            t.description = tdesc
            db.flush()
            upsert_edge(db, nid("gateway", gwname), nid("tool", tname), "ROUTES_TO",
                        origin="declared", facets={"target_type": ttype})
            if accesses:
                upsert_edge(db, nid("tool", tname), nid("resource", accesses), "ACCESSES",
                            origin="declared", facets={"via": "gateway target execution role"})

    # Direct tools.
    for tname, tdesc, hosting, defs, accesses in DIRECT_TOOLS:
        t = upsert_node(db, EntityRef(node_type="tool", name=tname, facets={
            "hosting": hosting,
            **({"registry": _registry("MCP", "1.0.0", "APPROVED", "platform-team",
                                      tool_definitions=defs)} if defs else {}),
        }))
        t.description = tdesc
        db.flush()
        if accesses:
            upsert_edge(db, nid("tool", tname), nid("resource", accesses), "ACCESSES",
                        origin="declared", facets={"via": "runtime execution role"})

    # Skills.
    for sname, sdesc, publisher in SKILLS:
        n = upsert_node(db, EntityRef(node_type="skill", name=sname, facets={
            "registry": _registry("AGENT_SKILLS", "1.0.0", "APPROVED", publisher,
                                  repository=f"https://git.acme.internal/skills/{sname}"),
        }))
        n.description = sdesc

    # Prompts.
    for pname, (pdesc, versions) in PROMPTS.items():
        n = upsert_node(db, EntityRef(node_type="prompt", name=pname, facets={
            "current_version": versions[0][0],
            "change_control": "git + PR review (prompts repo)",
            "repository": f"https://git.acme.internal/prompts/{pname}",
            "versions": [
                {"version": v, "date": d, "author": a, "summary": s}
                for v, d, a, s in versions
            ],
        }))
        n.description = pdesc

    # Agents, their edges and identity chain.
    for a in AGENTS:
        status = "DRAFT" if a.get("external") else "APPROVED"
        engine = "External (partner-hosted)" if a.get("external") else "AgentCore Runtime"
        n = upsert_node(db, EntityRef(node_type="agent", name=a["name"], facets={
            "engine": engine, "framework": a["framework"], "owner": a["owner"],
            "version": a["versions"][0],
            "arn": f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/{a['name']}",
            "registry": _registry("A2A", a["versions"][0], status, a["owner"],
                                  protocol_validation="A2A schema: PASSED"),
        }))
        n.description = a["desc"]
        db.flush()
        aid = nid("agent", a["name"])

        for g in a.get("groups", []):
            upsert_edge(db, nid("user_group", g), aid, "INVOKES", origin="declared",
                        facets={"mechanism": "AgentCore Runtime invoke",
                                "auth": "OAuth2 inbound (AgentCore Identity)"})
        for sub in a.get("subs", []):
            mech = ({"mechanism": "A2A", "auth": "OAuth2 client-credentials (Identity vault)"}
                    if sub == "fraud-review-agent"
                    else {"mechanism": "AgentCore Runtime (sub-agent invoke)",
                          "auth": "SigV4 workload identity"})
            upsert_edge(db, aid, nid("agent", sub), "DELEGATES_TO", origin="declared", facets=mech)
        for gwname, tool_names in a.get("gateway_tools", {}).items():
            upsert_edge(db, aid, nid("gateway", gwname), "USES_TOOL", origin="declared",
                        facets={"auth": GATEWAYS[gwname]["inbound_auth"],
                                "tools_in_scope": tool_names})
        for t in a.get("direct_tools", []):
            upsert_edge(db, aid, nid("tool", t), "USES_TOOL", origin="declared",
                        facets={"via": "direct (runtime)"})
        for llm in a.get("llms", []):
            upsert_edge(db, aid, nid("llm", llm), "CALLS_LLM", origin="declared",
                        facets={"via": "Bedrock InvokeModel" if "gpt" not in llm else "OpenAI API"})
        for r in a.get("resources", []):
            upsert_edge(db, aid, nid("resource", r), "ACCESSES", origin="declared",
                        facets={"via": "IAM execution role"})
        for s in a.get("skills", []):
            upsert_edge(db, aid, nid("skill", s), "HAS_SKILL", origin="declared",
                        facets={"source": "A2A agent card (registry)"})
        if a.get("prompt"):
            upsert_edge(db, aid, nid("prompt", a["prompt"]), "USES_PROMPT", origin="declared",
                        facets={"pinned_version": PROMPTS[a["prompt"]][1][0][0]})

        # Identity chain.
        if not a.get("external"):
            wid = f"{a['name']}-wid"
            upsert_node(db, EntityRef(node_type="identity", name=wid, facets={
                "provider": "AgentCore Identity",
                "arn": f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:workload-identity/{wid}",
            }))
            db.flush()
            upsert_edge(db, aid, nid("identity", wid), "AUTHENTICATES_AS", origin="declared",
                        facets={"mechanism": "AgentCore Identity workload identity"})

    # Credentials + identity->credential->target edges.
    for cname, ctype, vendor, ttype, tname in CREDENTIALS:
        upsert_node(db, EntityRef(node_type="credential", name=cname, facets={
            "vault": "AgentCore Identity credential provider",
            "type": ctype, "vendor": vendor, "rotation": "90 days",
        }))
        db.flush()
        upsert_edge(db, nid("credential", cname), nid(ttype, tname), "GRANTS_ACCESS_TO",
                    origin="declared", facets={})
    for agent_name, creds in AGENT_CREDENTIALS.items():
        for cname in creds:
            upsert_edge(db, nid("identity", f"{agent_name}-wid"), nid("credential", cname),
                        "USES_CREDENTIAL", origin="declared",
                        facets={"fetched_from": "credential vault at call time"})

    # Evaluations.
    now = datetime.now(timezone.utc)
    for agent_name, ename, etype, status, score, extra in EVALUATIONS:
        db.add(Evaluation(
            agent_id=nid("agent", agent_name), name=ename, eval_type=etype,
            status=status, score=score,
            facets={"suite": "AgentCore Evaluations", **extra},
            executed_at=now - timedelta(days=random.Random(ename).randint(0, 12)),
        ))
    db.commit()


def _agent(name: str) -> dict:
    return next(a for a in AGENTS if a["name"] == name)


def _llm_usage(rng: random.Random, llm: str) -> LLMUsageRef:
    heavy = "sonnet" in llm
    return LLMUsageRef(
        name=llm,
        inputTokens=rng.randint(4000, 16000) if heavy else rng.randint(800, 4000),
        outputTokens=rng.randint(600, 2600) if heavy else rng.randint(120, 900),
    )


def _agent_step(db, rng: random.Random, run_id: str, ts: datetime, agent: dict) -> None:
    """One ACCESS step for an agent: gateway tool calls (Cedar), guardrails, LLMs, resources."""
    gw_calls = []
    for gwname, tool_names in agent.get("gateway_tools", {}).items():
        for tool in rng.sample(tool_names, k=min(len(tool_names), rng.randint(1, 3))):
            deny = rng.random() < (0.10 if tool in ("refund-processor", "payroll-adjust") else 0.02)
            policy = {
                "refund-processor": "refunds-under-1000",
                "payroll-adjust": "payroll-adjust-limit",
            }.get(tool, next(iter(GATEWAYS[gwname]["cedar_policies"])))
            gw_calls.append(GatewayCall(
                gateway=EntityRef(node_type="gateway", name=gwname),
                tool=EntityRef(node_type="tool", name=tool),
                decision="DENY" if deny else "ALLOW", policyId=policy,
            ))
    guardrail_events = []
    llms = []
    for llm in agent.get("llms", []):
        llms.append(_llm_usage(rng, llm))
        guardrail = next((g for n, _, _, _, g in LLMS if n == llm and g), None)
        if guardrail:
            blocked = rng.random() < 0.06
            guardrail_events.append(GuardrailEvent(
                guardrail=EntityRef(node_type="guardrail", name=guardrail),
                llm=EntityRef(node_type="llm", name=llm),
                action="BLOCKED" if blocked else "PASSED",
                category="pii" if blocked else "",
            ))
    ingest_event(db, AgentRunEvent(
        eventType="ACCESS", eventTime=ts, runId=run_id, producer="demo-otel",
        agent=EntityRef(node_type="agent", name=agent["name"]),
        subAgents=[EntityRef(node_type="agent", name=s) for s in agent.get("subs", [])],
        tools=[EntityRef(node_type="tool", name=t) for t in agent.get("direct_tools", [])],
        gatewayCalls=gw_calls,
        guardrailEvents=guardrail_events,
        llms=llms,
        resources=[EntityRef(node_type="resource", name=r) for r in agent.get("resources", [])],
    ))


def _seed_runs(db, days: int = 14) -> int:
    rng = random.Random(7)
    total = 0
    roots = [a for a in AGENTS if a.get("groups")]
    for root in roots:
        for day in range(days):
            for _ in range(rng.randint(1, 2)):
                run_id = str(uuid.uuid4())
                ts = datetime.now(timezone.utc) - timedelta(days=day, minutes=rng.randint(0, 720))
                old = day >= days // 2 and len(root["versions"]) > 1
                version = root["versions"][1] if old else root["versions"][0]
                prompt_v = None
                if root.get("prompt"):
                    versions = PROMPTS[root["prompt"]][1]
                    prompt_v = versions[1][0] if old and len(versions) > 1 else versions[0][0]
                agent_ref = EntityRef(node_type="agent", name=root["name"])
                ingest_event(db, AgentRunEvent(
                    eventType="START", eventTime=ts, runId=run_id, producer="demo-otel",
                    agent=agent_ref,
                    onBehalfOf=EntityRef(node_type="user_group", name=rng.choice(root["groups"])),
                    runFacets={"agent_version": version,
                               **({"prompt_version": prompt_v} if prompt_v else {})},
                ))
                _agent_step(db, rng, run_id, ts, root)
                for sub_name in root.get("subs", []):
                    sub = _agent(sub_name)
                    if not sub.get("external"):
                        _agent_step(db, rng, run_id, ts + timedelta(seconds=rng.randint(2, 30)), sub)
                failed = rng.random() < 0.05
                ingest_event(db, AgentRunEvent(
                    eventType="FAIL" if failed else "COMPLETE",
                    eventTime=ts + timedelta(seconds=rng.randint(30, 180)),
                    runId=run_id, producer="demo-otel", agent=agent_ref,
                ))
                total += 1
    return total


def seed() -> None:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        _seed_nodes_and_edges(db)
        runs = _seed_runs(db)
        tools = sum(len(g["tools"]) for g in GATEWAYS.values()) + len(DIRECT_TOOLS)
        print(
            f"Seeded demo namespace '{NS}': {len(AGENTS)} agents, "
            f"{len(GATEWAYS)} gateways, {tools} tools, {len(SKILLS)} skills, "
            f"{len(LLMS)} LLMs, {len(RESOURCES)} resources (with data lineage), "
            f"{len(GUARDRAILS)} guardrails, {len(EVALUATIONS)} evaluations, {runs} runs."
        )
    finally:
        db.close()


if __name__ == "__main__":
    seed()
