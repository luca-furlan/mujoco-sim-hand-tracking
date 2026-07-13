#!/usr/bin/env bash
# Avvio stack G1 su Jetson/Linux (equivalente a START.ps1)
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .venv/bin/python ]]; then
  echo "Manca .venv — esegui prima: ./SETUP_JETSON.sh" >&2
  exit 1
fi

unset HTTP_ONLY 2>/dev/null || true

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -t -i:8443 -i:8000 2>/dev/null || true)"
  if [[ -n "${PIDS}" ]]; then
    kill ${PIDS} 2>/dev/null || true
    sleep 1
  fi
fi

mkdir -p logs
IP_WIFI="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 || echo '?')"

echo ""
echo "G1 VR sim — HTTPS :8443"
echo "  Locale:  https://127.0.0.1:8443/"
echo "  Quest:   https://${IP_WIFI}:8443/"
echo ""

exec .venv/bin/python server.py 2>&1 | tee -a logs/server.log
