# Agent Lineage — Research & Approach Analysis

Goal: end-to-end lineage of an agent in an Agentic AI platform — which tools, resources,
LLMs it has access to, and which user groups can invoke it. Visualized left-to-right:
`User Group -> Agent -> Sub-agents -> Tools / LLMs -> Resources`.

## 1. What we can learn from OpenLineage (data lineage)

OpenLineage succeeded with three ideas we adopt directly
([spec](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md),
[object model](https://openlineage.io/docs/spec/object-model/)):

1. **Small core object model.** Jobs, Datasets, Runs. The backend learns about datasets
   by receiving job events and weaves the graph from many observations.
2. **Event-based ingestion API.** Producers emit `RunEvent`s (START/COMPLETE/FAIL) with
   inputs/outputs; the backend (e.g. Marquez) aggregates them into a lineage graph.
3. **Facets for extensibility.** Self-contained JSON blobs attached to any entity, so
   the core model stays small while metadata stays rich
   ([facets](https://openlineage.io/docs/next/spec/facets/)).

**Mapping to agents:**

| OpenLineage | Agent Lineage |
|---|---|
| Job | Agent / Sub-agent |
| Run | Agent run (one invocation/session) |
| Dataset (inputs/outputs) | Tools, LLMs, Resources, User Groups |
| Facets | Facets (unchanged concept) |

## 2. Runtime signal: OpenTelemetry GenAI & OpenInference

Agent observability has converged on two open conventions
([Arthur comparison](https://www.arthur.ai/column/openinference-vs-opentelemetry-genai-conventions-agent-tracing),
[Uptrace guide](https://uptrace.dev/blog/opentelemetry-ai-systems)):

- **OTel GenAI semantic conventions** — span attributes for model name, token counts,
  tool calls; each tool call / LLM invocation / retrieval step is a child span.
- **OpenInference** — span kinds (`AGENT`, `TOOL`, `LLM`, `RETRIEVER`) with the longest
  track record; works with any OTel backend.

**Implication:** our ingestion schema should be trivially mappable from OTel/OpenInference
spans, so existing instrumentation (LangChain, LlamaIndex, OpenAI/Anthropic SDKs, MCP
gateways) can emit lineage events without new agent-side code. A trace exporter or
collector processor can translate spans -> lineage events.

## 3. Governance signal: agent registries & MCP gateways

Enterprise demand is well documented
([DataRobot: agent governance at scale](https://www.datarobot.com/blog/ai-agent-governance-at-scale-agent-workforce/),
[Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/what-is-agent-id-platform),
[MCP gateway governance](https://composio.dev/blog/mcp-gateway-governance),
[arXiv registry survey](https://arxiv.org/html/2508.03095v2)):

- Agents are a **new class of privileged identity**; teams need visibility into agents,
  prompts, tools, MCP servers, data sources, permissions and runtime behavior.
- MCP servers are the bridge to enterprise systems and often lack consistent visibility;
  gateways provide catalogs, access control and audit trails.
- Least-privilege for agents requires knowing *declared* access vs *actually used* access.

**Implication:** lineage must have **two layers**:

1. **Declared (design-time)** — the registry says agent A *may* use tool T, LLM M,
   resource R, and can be invoked by user group G.
2. **Observed (runtime)** — lineage events prove agent A *actually* called T/M/R in run X
   on behalf of group G, with counts and timestamps.

The delta between the two is the product's killer feature: unused permissions
(tighten them) and undeclared usage (policy violation / drift).

## 4. Approaches considered

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Extend OpenLineage itself** (custom facets on Job/Run) | Reuse Marquez, ecosystem | Object model is dataset-centric; user groups/LLMs/tools are unnatural as Datasets; UI semantics wrong | Rejected — borrow the pattern, not the schema |
| **B. Pure OTel trace store** (Langfuse/Arize-style) | Rich runtime data, standard SDKs | Traces are per-run trees, not an aggregated access graph; no declared-access layer | Rejected as core, adopted as *ingest source* |
| **C. Graph DB first (Neo4j)** | Native graph queries | Heavy ops footprint for v1; relational + recursive CTE is enough at this scale | Deferred — keep storage swappable |
| **D. Own event spec + property graph on SQL (chosen)** | Small core, facet-extensible, both layers, easy OTel mapping, SQLite->Postgres path | We own the spec | **Chosen** |

## 5. Chosen architecture

```
 Emitters                      Backend (Python/FastAPI)             UI (React/TS)
┌──────────────┐   events    ┌──────────────────────────┐   REST  ┌─────────────┐
│ Agent SDKs / │ ──────────► │ POST /api/v1/lineage/events│ ◄───── │ React Flow  │
│ OTel exporter│             │  ingest -> upsert graph   │        │ LR lineage  │
│ MCP gateway  │             ├──────────────────────────┤        │ graph +     │
└──────────────┘             │ Registry CRUD (declared)  │        │ detail panel│
┌──────────────┐   declare   │ nodes / edges / runs      │        └─────────────┘
│ Platform     │ ──────────► ├──────────────────────────┤
│ registry/IaC │             │ GET /lineage/graph (BFS)  │
└──────────────┘             │ SQLite (SQLAlchemy) → PG  │
                             └──────────────────────────┘
```

- **Entities (nodes):** `user_group`, `agent`, `tool`, `llm`, `resource`.
  Sub-agents are agents connected by `DELEGATES_TO`.
- **Edges:** `INVOKES` (group→agent), `DELEGATES_TO` (agent→agent),
  `USES_TOOL` (agent→tool), `CALLS_LLM` (agent→llm), `ACCESSES` (agent/tool→resource).
  Every edge carries `origin: declared|observed`, `call_count`, `last_observed_at`.
- **Runs + raw events** stored for audit; ingestion upserts nodes/edges idempotently.
- **UI:** React Flow + dagre left-to-right layout (the modern equivalent of the
  Marquez lineage view, which is React-based).

## 6. Roadmap after v1

- OTel collector processor translating GenAI/OpenInference spans -> lineage events.
- Declared-vs-observed drift report and least-privilege recommendations.
- Postgres + Neo4j storage adapters; authn/z on the API; multi-tenant namespaces.
- Time-travel (graph as of date), run drill-down timeline, cost/token facets.

*Content from cited sources was paraphrased for compliance with licensing restrictions.*
