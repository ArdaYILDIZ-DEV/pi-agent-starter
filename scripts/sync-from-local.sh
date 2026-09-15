#!/usr/bin/env bash
# sync-from-local.sh: Safely synchronizes shared agent configuration from ~/.pi/agent to pi-agent-starter.
# Excludes private tokens, API keys, session logs, and local-only skills.

set -euo pipefail

SOURCE_DIR="${HOME}/.pi/agent"
TARGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: Source directory $SOURCE_DIR does not exist." >&2
  exit 1
fi

echo "Synchronizing shared components from $SOURCE_DIR to $TARGET_DIR..."

# 1. Agents, autohooks, prompts, themes
cp -r "${SOURCE_DIR}/agents/"* "${TARGET_DIR}/agents/"
cp -r "${SOURCE_DIR}/autohooks/"* "${TARGET_DIR}/autohooks/"
cp -r "${SOURCE_DIR}/prompts/"* "${TARGET_DIR}/prompts/"
cp -r "${SOURCE_DIR}/themes/"* "${TARGET_DIR}/themes/"

# 2. System prompts and personas
cp "${SOURCE_DIR}/SYSTEM.md" "${TARGET_DIR}/SYSTEM.md"
cp "${SOURCE_DIR}/"*Deep*.md "${TARGET_DIR}/" 2>/dev/null || true
cp "${SOURCE_DIR}/Kaida"*.md "${TARGET_DIR}/" 2>/dev/null || true

# 3. Extensions (standalone TypeScript files)
cp "${SOURCE_DIR}/extensions/"*.ts "${TARGET_DIR}/extensions/"

# 4. Tools & npm package manifest
cp "${SOURCE_DIR}/tools.json" "${TARGET_DIR}/tools.json"
cp "${SOURCE_DIR}/npm/package.json" "${TARGET_DIR}/npm/package.json"

# 5. Git submodules update
git -C "$TARGET_DIR" submodule update --remote --merge || true

echo "Synchronization complete. Private tokens, credentials, and local paths were omitted."
