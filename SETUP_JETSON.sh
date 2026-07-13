#!/usr/bin/env bash
# Jetson / Linux setup (equivalente a SETUP.ps1 su Windows)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v git >/dev/null 2>&1; then
  echo "Installa git e riprova." >&2
  exit 1
fi

PY="${PY:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "python3 non trovato." >&2
  exit 1
fi

if [[ ! -d .venv ]]; then
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt

SCENE="vendor/mujoco_menagerie/unitree_g1/scene.xml"
if [[ ! -f "$SCENE" ]]; then
  git clone --depth 1 --filter=blob:none --sparse \
    https://github.com/google-deepmind/mujoco_menagerie.git vendor/mujoco_menagerie
  (
    cd vendor/mujoco_menagerie
    git sparse-checkout set unitree_g1
  )
fi

# Assicura scene con mani Dex3 (g1_with_hands.xml incluso nello sparse unitree_g1).
if [[ ! -f vendor/mujoco_menagerie/unitree_g1/scene_with_hands.xml ]]; then
  echo "ATTENZIONE: scene_with_hands.xml mancante — copia da g1-teleop o espandi sparse-checkout" >&2
fi

MESH_COUNT="$(find vendor/mujoco_menagerie/unitree_g1/assets -name '*.STL' 2>/dev/null | wc -l || echo 0)"
echo ""
echo "Setup OK. Mesh STL G1: ${MESH_COUNT}"
echo "Avvio: ./START_JETSON.sh"
