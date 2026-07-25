"""Sync AgentCore Evaluations (batch evaluations) into per-agent evaluation rows.

Uses the bedrock-agentcore data-plane API:
  list_batch_evaluations -> get_batch_evaluation (detail)
Agent association is inferred from the evaluation's CloudWatch data source
(serviceNames / logGroupNames containing the agent runtime name).
Online configs write per-invocation results to CloudWatch
(outputConfig.cloudWatchConfig.logGroupName); the sync tails that log group and
attaches the latest result scores to the evaluation record.
"""
import json
from datetime import datetime, timedelta, timezone

import boto3
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from .base import paginate

import os

# Match the observability window (30 days) so results survive idle periods.
RESULTS_WINDOW_HOURS = int(os.environ.get("AGENT_LINEAGE_EVAL_RESULTS_WINDOW_HOURS", "720"))
RESULTS_MAX_EVENTS = 500


def _extract_scores(
    record: dict, path: str = "", inherited_label: str = ""
) -> list[tuple[str, float]]:
    """Walk a result record for numeric score fields; format is tolerant since
    the online-eval output schema is not published. Pairs each score with the
    nearest evaluator/metric name (inherited from enclosing objects), else the
    key path."""
    found: list[tuple[str, float]] = []
    if not isinstance(record, dict):
        return found
    label = str(
        record.get("evaluatorId")
        or record.get("evaluatorName")
        or record.get("metricName")
        or record.get("name")
        # OTel-style flattened keys, e.g. "gen_ai.evaluation.name".
        or next(
            (v for k, v in record.items()
             if isinstance(v, str) and ("evaluation.name" in k.lower() or "evaluator" in k.lower())),
            "",
        )
        or inherited_label
        or ""
    )
    for k, v in record.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool) and "score" in k.lower():
            found.append((label or (f"{path}.{k}" if path else k), float(v)))
        elif isinstance(v, dict):
            found.extend(_extract_scores(v, f"{path}.{k}" if path else k, label))
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    found.extend(_extract_scores(item, f"{path}.{k}" if path else k, label))
    return found


def _fetch_online_results(session: boto3.Session, log_group: str) -> dict:
    """Tail the online-eval results log group; return a summary facet."""
    logs = session.client("logs")
    start_ms = int(
        (datetime.now(timezone.utc) - timedelta(hours=RESULTS_WINDOW_HOURS)).timestamp() * 1000
    )
    results: list[dict] = []
    scanned = 0
    sample_keys: set[str] = set()
    token = None
    while scanned < RESULTS_MAX_EVENTS:
        params = {"logGroupName": log_group, "startTime": start_ms, "limit": 500}
        if token:
            params["nextToken"] = token
        try:
            resp = logs.filter_log_events(**params)
        except Exception as e:  # missing group / permission — report, don't fail sync
            return {"results_error": f"{type(e).__name__}: {e}"[:160]}
        for le in resp.get("events", []):
            scanned += 1
            try:
                record = json.loads(le.get("message", ""))
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                sample_keys.update(list(record.keys())[:8])
            for evaluator, score in _extract_scores(record):
                results.append({
                    "time": datetime.fromtimestamp(
                        le.get("timestamp", 0) / 1000, tz=timezone.utc
                    ).isoformat(),
                    "evaluator": evaluator,
                    "score": round(score, 4),
                })
        token = resp.get("nextToken")
        if not token:
            break
    if not results:
        # Distinguish "nothing in the window" from "records didn't parse".
        summary: dict = {"recent_results_count": 0, "results_scanned": scanned}
        if scanned > 0:
            summary["unparsed_record_keys"] = sorted(sample_keys)[:12]
        return summary
    results.sort(key=lambda r: r["time"])
    scores = [r["score"] for r in results]
    return {
        "recent_results_count": len(results),
        "avg_score": round(sum(scores) / len(scores), 4),
        "last_result": results[-1],
        # Full recent series (newest last) for the evaluations explorer.
        "recent_results": results[-50:],
        "results_window_hours": RESULTS_WINDOW_HOURS,
    }


def _status(raw: str, completed: int, failed: int) -> str:
    if raw in ("IN_PROGRESS", "STARTING", "RUNNING"):
        return "RUNNING"
    if completed or failed:
        return "PASSED" if failed == 0 else "FAILED"
    return raw or "UNKNOWN"


def _upsert_eval(
    db: Session, agent_id: str, name: str, eval_type: str,
    status: str, score, facets: dict, executed_at,
) -> None:
    existing = db.scalar(
        select(models.Evaluation).where(
            models.Evaluation.agent_id == agent_id,
            models.Evaluation.name == name,
        )
    )
    if existing:
        existing.status = status
        existing.score = score
        existing.facets = facets
        existing.executed_at = executed_at or existing.executed_at
    else:
        db.add(models.Evaluation(
            agent_id=agent_id, name=name, eval_type=eval_type,
            status=status, score=score, facets=facets, executed_at=executed_at,
        ))


def _match_agent(agents: dict[str, str], haystack: str) -> str | None:
    agent_id = next(
        (aid for name, aid in agents.items() if name and name in haystack), None
    )
    if agent_id is None and len(agents) == 1:
        # Single-agent account: attribute to that agent.
        agent_id = next(iter(agents.values()))
    return agent_id


def sync(db: Session, session: boto3.Session, namespace: str) -> dict:
    client = session.client("bedrock-agentcore")
    control = session.client("bedrock-agentcore-control")
    agents = {
        n.name: n.id
        for n in db.scalars(
            select(models.Node).where(
                models.Node.namespace == namespace, models.Node.node_type == "agent"
            )
        )
    }
    synced = 0
    online = 0
    unmatched = 0

    # Online evaluation configs (continuous evals on live traffic).
    for oc in paginate(
        control, "list_online_evaluation_configs", "onlineEvaluationConfigs"
    ):
        oc_id = oc.get("onlineEvaluationConfigId", "")
        detail = oc
        try:
            detail = control.get_online_evaluation_config(onlineEvaluationConfigId=oc_id)
        except Exception:
            pass
        ds = ((detail.get("dataSourceConfig") or {}).get("cloudWatchLogs") or {})
        haystack = " ".join(
            list(ds.get("serviceNames") or []) + list(ds.get("logGroupNames") or [])
        )
        agent_id = _match_agent(agents, haystack)
        if agent_id is None:
            unmatched += 1
            continue
        # Online configs are continuous monitors, not executions: report the
        # config state (ENABLED/DISABLED/...) rather than a fake "RUNNING",
        # plus the latest per-invocation results tailed from CloudWatch.
        exec_status = str(detail.get("executionStatus") or detail.get("status") or "UNKNOWN")
        results_facet: dict = {}
        log_group = (
            ((detail.get("outputConfig") or {}).get("cloudWatchConfig") or {})
            .get("logGroupName", "")
        )
        if log_group:
            results_facet = _fetch_online_results(session, log_group)
        avg = results_facet.get("avg_score")
        _upsert_eval(
            db, agent_id,
            name=oc.get("onlineEvaluationConfigName") or oc_id,
            eval_type="online",
            status=exec_status,
            score=avg if isinstance(avg, (int, float)) and 0 <= avg <= 1 else None,
            facets={
                "arn": oc.get("onlineEvaluationConfigArn", ""),
                "evaluators": [
                    e.get("evaluatorId", "") if isinstance(e, dict) else str(e)
                    for e in (detail.get("evaluators") or [])
                ],
                "execution_status": exec_status,
                "failure_reason": detail.get("failureReason", ""),
                "results_log_group": log_group,
                **results_facet,
                "source": "aws:bedrock-agentcore-control:list_online_evaluation_configs",
            },
            executed_at=oc.get("updatedAt") or oc.get("createdAt"),
        )
        online += 1

    for be in paginate(client, "list_batch_evaluations", "batchEvaluations"):
        be_id = be.get("batchEvaluationId", "")
        detail = be
        try:
            detail = client.get_batch_evaluation(batchEvaluationId=be_id)
        except Exception:
            pass

        ds = ((detail.get("dataSourceConfig") or {}).get("cloudWatchLogs") or {})
        haystack = " ".join(
            list(ds.get("serviceNames") or []) + list(ds.get("logGroupNames") or [])
        )
        agent_id = _match_agent(agents, haystack)
        if agent_id is None:
            unmatched += 1
            continue

        results = detail.get("evaluationResults") or {}
        completed = int(results.get("numberOfSessionsCompleted") or 0)
        failed = int(results.get("numberOfSessionsFailed") or 0)
        total = int(results.get("totalNumberOfSessions") or 0)
        summaries = results.get("evaluatorSummaries") or []
        # Score = evaluated-minus-failed ratio across evaluator summaries when present.
        evaluated = sum(int(s.get("totalEvaluated") or 0) for s in summaries)
        s_failed = sum(int(s.get("totalFailed") or 0) for s in summaries)
        score = round((evaluated - s_failed) / evaluated, 3) if evaluated else None

        _upsert_eval(
            db, agent_id,
            name=be.get("batchEvaluationName") or be_id,
            eval_type="batch",
            status=_status(str(be.get("status", "")), completed, failed),
            score=score,
            facets={
                "arn": be.get("batchEvaluationArn", ""),
                "evaluators": [
                    e.get("evaluatorId", "") for e in (detail.get("evaluators") or [])
                ],
                "sessions": {"total": total, "completed": completed, "failed": failed},
                "source": "aws:bedrock-agentcore:list_batch_evaluations",
            },
            executed_at=be.get("updatedAt") or be.get("createdAt"),
        )
        synced += 1

    db.commit()
    return {
        "batch_evaluations": synced,
        "online_eval_configs": online,
        "unmatched_to_agent": unmatched,
    }
