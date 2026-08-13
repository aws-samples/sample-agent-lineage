#!/usr/bin/env python3
"""Extract IAM policy documents from a CloudFormation template for validation
with IAM Access Analyzer (CI gate).

Outputs, for every AWS::IAM::Role in the template:
  identity-<Resource>-<PolicyName>.json   (inline policy documents)
  trust-<Resource>.json                   (AssumeRolePolicyDocument)

CloudFormation intrinsics are resolved to syntactically valid placeholders so
Access Analyzer can parse ARNs; the real values only differ in region/account,
which does not affect policy-structure findings.

Usage: extract_iam_policies.py <template.yaml> <output-dir>
"""
import json
import pathlib
import re
import sys

import yaml

REGION = "us-east-1"
ACCOUNT = "123456789012"

# GetAtt <Resource>.Arn -> placeholder ARN by resource type.
ARN_BY_TYPE = {
    "AWS::Cognito::UserPool": f"arn:aws:cognito-idp:{REGION}:{ACCOUNT}:userpool/{REGION}_Placeholder",
    "AWS::S3::Bucket": f"arn:aws:s3:::placeholder-bucket",
    "AWS::IAM::Role": f"arn:aws:iam::{ACCOUNT}:role/placeholder-role",
}


class CfnLoader(yaml.SafeLoader):
    pass


def _sub(value: str) -> str:
    value = value.replace("${AWS::Region}", REGION)
    value = value.replace("${AWS::AccountId}", ACCOUNT)
    value = value.replace("${AWS::Partition}", "aws")
    return re.sub(r"\$\{[^}]+\}", "placeholder", value)


def _make_constructors(resources_holder: dict):
    def sub(loader, node):
        val = node.value if isinstance(node.value, str) else str(node.value)
        return _sub(val)

    def getatt(loader, node):
        target = node.value if isinstance(node.value, str) else ".".join(node.value)
        res_name = target.split(".")[0]
        res_type = resources_holder.get(res_name, "")
        return ARN_BY_TYPE.get(res_type, f"arn:aws:iam::{ACCOUNT}:role/placeholder")

    def generic(loader, node):
        return "placeholder"

    CfnLoader.add_constructor("!Sub", sub)
    CfnLoader.add_constructor("!GetAtt", getatt)
    for tag in ("!Ref", "!If", "!Equals", "!Select", "!Split", "!GetAZs", "!Join"):
        CfnLoader.add_constructor(tag, generic)


def main() -> int:
    template_path, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    # First pass (types only) so GetAtt can resolve resource types.
    types: dict[str, str] = {}
    _make_constructors(types)
    with open(template_path) as f:
        doc = yaml.load(f, Loader=CfnLoader)
    for name, res in doc.get("Resources", {}).items():
        types[name] = res.get("Type", "")
    # Second pass with types available.
    with open(template_path) as f:
        doc = yaml.load(f, Loader=CfnLoader)

    count = 0
    for name, res in doc.get("Resources", {}).items():
        if res.get("Type") != "AWS::IAM::Role":
            continue
        props = res.get("Properties", {})
        trust = props.get("AssumeRolePolicyDocument")
        if trust:
            (out_dir / f"trust-{name}.json").write_text(json.dumps(trust, indent=2))
            count += 1
        for pol in props.get("Policies", []) or []:
            fname = f"identity-{name}-{pol['PolicyName']}.json"
            (out_dir / fname).write_text(json.dumps(pol["PolicyDocument"], indent=2))
            count += 1

    print(f"extracted {count} policy documents to {out_dir}")
    return 0 if count else 1


if __name__ == "__main__":
    sys.exit(main())
