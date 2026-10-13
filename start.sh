#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
  runtime=".venv/bin/python"
else
  printf '请先准备本地环境：\npython3 -m venv .venv\n.venv/bin/python -m pip install -r requirements.txt\n'
  exit 1
fi
if [ ! -f dist/index.html ]; then
  printf '请先运行 npm ci && npm run build\n'
  exit 1
fi
exec "$runtime" backend/server.py
