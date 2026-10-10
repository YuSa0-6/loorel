#!/usr/bin/env bash
# Starts Ollama, pulls the model, then hands jobs to handler.py.
set -euo pipefail

# Loorel sets MODEL_NAME from defineModel's `source`; for this worker it is an Ollama model.
: "${MODEL_NAME:?set the model source to an Ollama model, for example clef or clef-flash}"

# Keep the weights on the network volume when one is mounted, so later cold starts skip the pull.
if [ -d /runpod-volume ]; then
  export OLLAMA_MODELS="${OLLAMA_MODELS:-/runpod-volume/ollama/models}"
fi
export OLLAMA_HOST=127.0.0.1:11434
# The worker lives only as long as Runpod keeps it, so keep the model loaded the whole time.
export OLLAMA_KEEP_ALIVE=-1

ollama serve &
for _ in $(seq 1 120); do
  curl -fsS "http://${OLLAMA_HOST}/api/version" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://${OLLAMA_HOST}/api/version" >/dev/null

ollama pull "$MODEL_NAME"
exec /venv/bin/python -u /worker/handler.py
