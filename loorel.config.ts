// Runpod Serverless endpoints, synced by `pnpm plan` / `pnpm apply`.
// A model (models/*.ts) is what is served; an endpoint is where and how it runs.
import { defineConfig, defineEndpoint } from "loorel/config";
import qwen3_8b from "./models/qwen3-8b.ts";

export default defineConfig({
  // Settings every endpoint starts from. Runpod templates are not used: in REST API v2
  // a template is copied into the endpoint once and never linked again.
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

  endpoints: [
    defineEndpoint({
      model: qwen3_8b,
      gpu: { pools: ["ADA_24"], count: 1 },
      workers: { min: 0, max: 2 },
    }),
  ],
});
