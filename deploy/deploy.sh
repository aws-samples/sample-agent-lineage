#!/usr/bin/env bash
# Deploy Agent Lineage to AWS: ECR image -> CloudFormation -> S3 frontend -> CF invalidation.
#
# Usage:
#   ./deploy/deploy.sh <region>                                   # creates its own VPC
#   ./deploy/deploy.sh <region> <vpc-id> <subnet-a,subnet-b>      # reuses your VPC
#
# Requires: aws cli (credentials configured), docker, node/npm, openssl.
set -euo pipefail

REGION="${1:-us-east-1}"
# Positional args win; env vars EXISTING_VPC_ID / EXISTING_SUBNET_IDS as fallback.
EXISTING_VPC_ID="${2:-${EXISTING_VPC_ID:-}}"
EXISTING_SUBNET_IDS="${3:-${EXISTING_SUBNET_IDS:-}}"
STACK="agent-lineage"
REPO="agent-lineage-api"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
TAG="$(date +%Y%m%d%H%M%S)"
IMAGE_URI="${ECR}/${REPO}:${TAG}"

echo "==> Account ${ACCOUNT} / ${REGION} / stack ${STACK}"

echo "==> Ensuring ECR repository"
aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null

echo "==> Building and pushing backend image ${IMAGE_URI}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR"
docker build --platform linux/amd64 -t "$IMAGE_URI" "$ROOT/backend"
docker push "$IMAGE_URI"

# Reuse the existing origin-verify secret on updates so CF and ALB stay in sync.
SECRET=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecret'].ParameterValue" \
  --output text 2>/dev/null || true)
if [ -z "$SECRET" ] || [ "$SECRET" = "None" ]; then
  SECRET=$(openssl rand -hex 24)
fi

# Deployment-unique ExternalId for cross-account AssumeRole (confused-deputy
# guard). Generated once, reused on updates so spoke trust policies stay valid.
EXTERNAL_ID=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='SyncExternalId'].ParameterValue" \
  --output text 2>/dev/null || true)
if [ -z "$EXTERNAL_ID" ] || [ "$EXTERNAL_ID" = "None" ]; then
  EXTERNAL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
fi

# Ingestion service credential: SSM SecureString, created once and never
# echoed. The task definition injects it via ECS Secrets/ValueFrom.
INGEST_PARAM="/agent-lineage/ingest-api-key"
if ! aws ssm get-parameter --name "$INGEST_PARAM" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Creating SSM SecureString ${INGEST_PARAM}"
  aws ssm put-parameter --name "$INGEST_PARAM" --type SecureString \
    --value "$(openssl rand -hex 24)" --region "$REGION" >/dev/null
fi

# CloudFront origin-facing managed prefix list: locks the ALB security group
# so only CloudFront edge nodes can reach it (ID differs per region).
CF_PREFIX_LIST=$(aws ec2 describe-managed-prefix-lists --region "$REGION" \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query "PrefixLists[0].PrefixListId" --output text)
if [ -z "$CF_PREFIX_LIST" ] || [ "$CF_PREFIX_LIST" = "None" ]; then
  echo "ERROR: could not resolve the CloudFront origin-facing prefix list in ${REGION}" >&2
  exit 1
fi
echo "==> CloudFront origin-facing prefix list: ${CF_PREFIX_LIST}"

# Network mode: reuse an existing VPC (avoids the per-region VPC quota) or create one.
# On an UPDATE, reuse the network the stack was originally deployed with.
# `cloudformation deploy --parameter-overrides` resets any parameter it is
# not given back to the template default (""), which would flip the
# CreateNetwork condition and try to replace the live VPC. So if the caller
# passed nothing, read the stored values from the stack instead.
if [ -z "$EXISTING_VPC_ID" ]; then
  STORED_VPC=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Parameters[?ParameterKey=='ExistingVpcId'].ParameterValue" \
    --output text 2>/dev/null || true)
  STORED_SUBNETS=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Parameters[?ParameterKey=='ExistingSubnetIds'].ParameterValue" \
    --output text 2>/dev/null || true)
  if [ -n "$STORED_VPC" ] && [ "$STORED_VPC" != "None" ]; then
    EXISTING_VPC_ID="$STORED_VPC"
    EXISTING_SUBNET_IDS="$STORED_SUBNETS"
    echo "==> Network: reusing the stack's existing VPC ${EXISTING_VPC_ID} (from stack parameters)"
  fi
fi

EXTRA_PARAMS=()
if [ -n "$EXISTING_VPC_ID" ]; then
  if [ -z "$EXISTING_SUBNET_IDS" ] || [ "$EXISTING_SUBNET_IDS" = "None" ]; then
    echo "ERROR: two public subnet IDs (comma-separated) are required with an existing VPC" >&2
    echo "Usage: ./deploy/deploy.sh $REGION $EXISTING_VPC_ID subnet-aaa,subnet-bbb" >&2
    exit 1
  fi
  EXTRA_PARAMS+=("ExistingVpcId=${EXISTING_VPC_ID}" "ExistingSubnetIds=${EXISTING_SUBNET_IDS}")
  echo "==> Network: REUSING existing VPC ${EXISTING_VPC_ID} (subnets: ${EXISTING_SUBNET_IDS})"
else
  echo "==> Network: creating a NEW VPC (pass vpc-id + subnets to reuse an existing one)"
fi

# A stack stuck in a failed create state cannot be updated — remove it first.
STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NONE")
if [ "$STATUS" = "ROLLBACK_COMPLETE" ] || [ "$STATUS" = "CREATE_FAILED" ] || [ "$STATUS" = "ROLLBACK_FAILED" ]; then
  echo "==> Stack is in ${STATUS}; deleting the failed stack before redeploying"
  aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"
fi

echo "==> Deploying CloudFormation stack"
aws cloudformation deploy \
  --stack-name "$STACK" \
  --region "$REGION" \
  --template-file "$ROOT/deploy/template.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "ImageUri=${IMAGE_URI}" "OriginVerifySecret=${SECRET}" \
    "SyncExternalId=${EXTERNAL_ID}" \
    "CloudFrontPrefixListId=${CF_PREFIX_LIST}" ${EXTRA_PARAMS[@]+"${EXTRA_PARAMS[@]}"}

outputs() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET=$(outputs FrontendBucket)
DIST_ID=$(outputs DistributionId)
APP_URL=$(outputs AppUrl)
POOL_ID=$(outputs UserPoolId)

echo "==> Building and uploading frontend"
(cd "$ROOT/frontend" && npm run build)
aws s3 sync "$ROOT/frontend/dist" "s3://${BUCKET}" --delete --region "$REGION"

echo "==> Invalidating CloudFront cache"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo ""
echo "Deployed: ${APP_URL}"
echo ""
echo "Cross-account spoke setup: retrieve this deployment's ExternalId with:"
echo "  aws cloudformation describe-stacks --stack-name ${STACK} --region ${REGION} \\"
echo "    --query \"Stacks[0].Parameters[?ParameterKey=='SyncExternalId'].ParameterValue\" --output text"
echo ""
echo "OTel translator setup: set its INGEST_KEY env var from SSM:"
echo "  aws ssm get-parameter --name ${INGEST_PARAM} --with-decryption \\"
echo "    --query Parameter.Value --output text --region ${REGION}"
echo ""
echo "Create your first user (email is the username):"
echo "  aws cognito-idp admin-create-user --user-pool-id ${POOL_ID} \\"
echo "    --username you@example.com \\"
echo "    --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \\"
echo "    --region ${REGION}"
