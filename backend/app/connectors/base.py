"""Shared AWS session handling for sync connectors.

Credentials come from either a named local profile or an assumable role ARN
(read-only). The account ID is discovered via STS; nodes are namespaced as
"{account_id}/{region}" so multiple accounts/regions coexist in one graph.
"""
from typing import Optional

import boto3


def make_session(
    region: str,
    profile: Optional[str] = None,
    role_arn: Optional[str] = None,
) -> boto3.Session:
    session = (
        boto3.Session(profile_name=profile, region_name=region)
        if profile
        else boto3.Session(region_name=region)
    )
    if role_arn:
        creds = session.client("sts").assume_role(
            RoleArn=role_arn, RoleSessionName="agent-lineage-sync"
        )["Credentials"]
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
