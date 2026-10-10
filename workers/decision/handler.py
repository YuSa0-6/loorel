"""Runpod handler for decision models.

A Loorel decision endpoint receives { "input": { model, state, questions, images? } } on
/runsync (see @loorel/client). This handler forwards the request to Ollama's System One
endpoint and returns its response ({ model, answers, usage }) as the job output.
Returning { "error": ... } makes Runpod mark the job FAILED.
"""

import json
import os
import urllib.error
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/v1/systemone")
# Decision models answer within a forward pass, but a cold model load can take minutes.
TIMEOUT_SECONDS = int(os.environ.get("DECISION_TIMEOUT_SECONDS", "600"))


def build_request(job_input, model):
    """The body for Ollama. `model` is the Ollama model name (MODEL_NAME), not the caller's."""
    if not isinstance(job_input, dict):
        raise ValueError("input must be an object")
    if "state" not in job_input:
        raise ValueError("input.state is required")
    questions = job_input.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("input.questions must be a non-empty object")
    body = {"model": model, "state": job_input["state"], "questions": questions}
    images = job_input.get("images")
    if images:
        body["images"] = images
    return body


def decide(job_input, model, url=OLLAMA_URL, opener=urllib.request.urlopen):
    request = urllib.request.Request(
        url,
        data=json.dumps(build_request(job_input, model)).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with opener(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def handler(job, decide_fn=decide):
    try:
        return decide_fn(job.get("input"), os.environ["MODEL_NAME"])
    except ValueError as e:
        return {"error": str(e)}
    except urllib.error.HTTPError as e:
        detail = e.read()[:500].decode(errors="replace")
        return {"error": f"ollama returned HTTP {e.code}: {detail}"}
    except urllib.error.URLError as e:
        return {"error": f"ollama is not reachable: {e.reason}"}


if __name__ == "__main__":
    import runpod

    runpod.serverless.start({"handler": handler})
