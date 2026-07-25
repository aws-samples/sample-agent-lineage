"""Sync AgentCore Identity: workload identities and credential providers.

Only metadata is stored (names, ARNs, types) — never secret values.

Identity -> owner edges (AUTHENTICATES_AS) are derived two ways:
1. Formal: the agent's `workload_identity_arn` facet captured by runtime_sync
   from get_agent_runtime.workloadIdentityDetails.
2. Fallback: name-prefix match — AgentCore auto-creates identities named
   "<resource-name>-<suffix>" for agents and gateways.
"""
import boto3
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..ingest import upsert_edge, upsert_node
from ..schemas import EntityRef
from .base import paginate


def sync(db: Session, session: boto3.Session, namespace: str) -> dict:
    client = session.client("bedrock-agentcore-control")
    identities = 0
    credentials = 0
    linked = 0

    # Owners we can link to: agents (by ARN facet or name prefix), gateways (prefix).
    owners = list(db.scalars(
        select(models.Node).where(
            models.Node.namespace == namespace,
            models.Node.node_type.in_(["agent", "gateway"]),
        )
    ))
    by_arn = {
        (o.facets or {}).get("workload_identity_arn"): o
        for o in owners
        if (o.facets or {}).get("workload_identity_arn")
    }

    def find_owner(identity_name: str, identity_arn: str):
        if identity_arn in by_arn:
            return by_arn[identity_arn]
        # "<owner-name>-<random-suffix>" -> longest matching owner name prefix.
        candidates = [
            o for o in owners
            if identity_name.startswith(o.name + "-") or identity_name == o.name
        ]
        return max(candidates, key=lambda o: len(o.name)) if candidates else None

    for wi in paginate(client, "list_workload_identities", "workloadIdentities"):
        name = wi.get("name", "unknown")
        arn = wi.get("workloadIdentityArn", "")
        node = upsert_node(db, EntityRef(
            node_type="identity",
            name=name,
            namespace=namespace,
            facets={
                "provider": "AgentCore Identity",
                "arn": arn,
                "source": "aws:bedrock-agentcore-control:list_workload_identities",
            },
        ))
        identities += 1
        owner = find_owner(name, arn)
        if owner is not None:
            db.flush()
            upsert_edge(
                db, owner.id, node.id, "AUTHENTICATES_AS", origin="declared",
                facets={
                    "source": (
                        "get_agent_runtime.workloadIdentityDetails"
                        if arn in by_arn
                        else "name-prefix match (auto-created identity)"
                    ),
                },
            )
            linked += 1

    for op, result_key, cred_type in (
        ("list_oauth2_credential_providers", "credentialProviders", "OAuth2"),
        ("list_api_key_credential_providers", "credentialProviders", "API key"),
    ):
        try:
            for cp in paginate(client, op, result_key):
                upsert_node(db, EntityRef(
                    node_type="credential",
                    name=cp.get("name", "unknown"),
                    namespace=namespace,
                    facets={
                        "vault": "AgentCore Identity credential provider",
                        "type": cred_type,
                        "arn": cp.get("credentialProviderArn", ""),
                        "vendor": cp.get("credentialProviderVendor", ""),
                        "source": f"aws:bedrock-agentcore-control:{op}",
                    },
                ))
                credentials += 1
        except NotImplementedError:
            continue

    db.commit()
    return {"identities": identities, "credentials": credentials, "linked_to_owner": linked}
