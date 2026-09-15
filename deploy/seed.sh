#!/usr/bin/env bash
# Load (or purge) the demo dataset in a DEPLOYED Agent Lineage stack.
#
# The seeder writes straight to the SQLite database on EFS, which is only
# mounted inside the running Fargate task, so this runs `python -m app.seed`
# there via ECS Exec (no data leaves your account; nothing is exposed).
#
# Usage:
#   ./deploy/seed.sh <region>            # seed the demo dataset
#   ./deploy/seed.sh <region> --purge    # remove it again (namespace 'default')
#
# Requires: aws cli with credentials that may call ecs:ExecuteCommand, and the
# Session Manager plugin (https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
set -euo pipefail

REGION="${1:-us-east-1}"
MODE="${2:-}"
CLUSTER="agent-lineage"
SERVICE="agent-lineage"

if ! command -v session-manager-plugin >/dev/null 2>&1; then
  echo "ERROR: the AWS Session Manager plugin is required for ECS Exec." >&2
  echo "  macOS: brew install --cask session-manager-plugin" >&2
  exit 1
fi

echo "==> Finding the running task in ${CLUSTER}/${SERVICE} (${REGION})"
TASK_ARN=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --region "$REGION" --query "taskArns[0]" --output text)
if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "ERROR: no RUNNING task found. Is the stack deployed and healthy?" >&2
  exit 1
fi

# ECS Exec must be enabled on the task (set by the template; existing tasks
# started before that change need one rolling restart to pick it up).
EXEC_ENABLED=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --region "$REGION" --query "tasks[0].enableExecuteCommand" --output text)
if [ "$EXEC_ENABLED" != "True" ]; then
  echo "==> Task predates ECS Exec; forcing a new deployment so the flag applies"
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --enable-execute-command --force-new-deployment --region "$REGION" >/dev/null
  echo "==> Waiting for the service to stabilise (this can take a few minutes)"
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"
  TASK_ARN=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
    --desired-status RUNNING --region "$REGION" --query "taskArns[0]" --output text)
fi

if [ "$MODE" = "--purge" ]; then
  CMD="python -m app.purge default"
  echo "==> Purging the demo namespace"
else
  CMD="python -m app.seed"
  echo "==> Seeding the demo dataset (12 agents, 3 gateways, 100 runs...)"
fi

aws ecs execute-command --cluster "$CLUSTER" --task "$TASK_ARN" --container api \
  --region "$REGION" --interactive --command "$CMD"

echo ""
echo "Done. Refresh the app — search the catalog for 'support-orchestrator'."
