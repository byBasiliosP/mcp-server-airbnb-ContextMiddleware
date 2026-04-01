#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${MCP_SERVER_DOCKER_IMAGE:-airbnb-mcp-server:smoke}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Building Docker image: ${IMAGE_TAG}"
docker build -t "${IMAGE_TAG}" "${ROOT_DIR}"

echo "Running MCP protocol smoke tests in container: ${IMAGE_TAG}"
MCP_SERVER_CMD="docker run --rm -i ${IMAGE_TAG} node dist/index.js --ignore-robots-txt" \
  bash "${ROOT_DIR}/scripts/validation-mcp.sh"
