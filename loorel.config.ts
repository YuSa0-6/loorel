// Settings every endpoint starts from. Each endpoint is a directory under endpoints/:
//   endpoints/<name>/model.config.ts     what is served (defineModel)
//   endpoints/<name>/endpoint.config.ts  where and how it runs (defineEndpoint)
// Runpod templates are not used: in REST API v2 a template is copied into the
// endpoint once and never linked again, so the repository holds the shared settings.
import { defineConfig } from "loorel";

export default defineConfig({
  defaults: {
    // Pin an exact tag. Releases: https://github.com/runpod-workers/worker-vllm/releases
    image: "runpod/worker-v1-vllm:v2.27.2",
    type: "QUEUE",
    disk: 50, // GB, container disk (the model is downloaded here)
    flashboot: "FLASHBOOT",
    timeout: 600_000, // ms per request
    idleTimeout: 5, // seconds before an idle worker stops
    scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
    // vLLM worker env vars: https://docs.runpod.io/serverless/vllm/environment-variables
    env: {
      GPU_MEMORY_UTILIZATION: "0.90",
      MAX_CONCURRENCY: 30,
    },
  },
});
