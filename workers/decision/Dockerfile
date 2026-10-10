# Runpod Serverless worker for decision models (the System One API of Jev, Cloudflare Clef and
# others). Ollama serves the model; handler.py takes { input } jobs from /runsync and forwards
# them to Ollama's /v1/systemone. Decision models need Ollama 0.35.1 or later.
FROM ollama/ollama:0.40.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /worker
COPY requirements.txt .
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r requirements.txt
COPY handler.py start.sh ./
RUN chmod +x start.sh

ENTRYPOINT ["/worker/start.sh"]
