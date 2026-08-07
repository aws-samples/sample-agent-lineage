"""Shared AWS session handling for sync connectors.

Credentials come from either a named local profile or an assumable role ARN
(read-only). The account ID is discovered via STS; nodes are namespaced as
"{account_id}/{region}" so multiple accounts/regions coexist in one graph.

Cross-account AssumeRole calls carry an ExternalId (confused-deputy guard).
The deployment-unique value comes from the SYNC_EXTERNAL_ID env var (generated
by deploy.sh); callers may override per request. Spoke role trust policies must
require the same value via an sts:ExternalId condition.
"""
import os
from typing import Optional

import boto3

DEFAULT_EXTERNAL_ID = os.environ.get("SYNC_EXTERNAL_ID", "")


def make_session(
    region: str,
    profile: Optional[str] = None,
    role_arn: Optional[str] = None,
    external_id: Optional[str] = None,
) -> boto3.Session:
    session = (
        boto3.Session(profile_name=profile, region_name=region)
        if profile
        else boto3.Session(region_name=region)
    )
    if role_arn:
        params = {"RoleArn": role_arn, "RoleSessionName": "agent-lineage-sync"}
        eid = external_id or DEFAULT_EXTERNAL_ID
        if eid:
            params["ExternalId"] = eid
        creds = session.client("sts").assume_role(**params)["Credentials"]
        session = boto3.Session(
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
            region_name=region,
        )
    return session


def account_id(session: boto3.Session) -> str:
    return session.client("sts").get_caller_identity()["Account"]


def paginate(client, operation: str, result_key: str, **kwargs):
    """Iterate all pages of a list operation, tolerating older botocore models."""
    if not hasattr(client, operation):
        raise NotImplementedError(
            f"{operation} not available in installed botocore; upgrade boto3"
        )
    if client.can_paginate(operation):
        for page in client.get_paginator(operation).paginate(**kwargs):
            yield from page.get(result_key, [])
    else:
        token = None
        while True:
            params = dict(kwargs)
            if token:
                params["nextToken"] = token
            resp = getattr(client, operation)(**params)
            yield from resp.get(result_key, [])
            token = resp.get("nextToken")
            if not token:
                break
