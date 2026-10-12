import { defineEndpoint } from "@loorel/define";
import model from "./model.config.ts";

export default defineEndpoint({
  model,
  engine: {
    type: "vllm",
    reasoningParser: "qwen3", // keep Qwen3's <think>…</think> out of the reply text
    env: { MAX_MODEL_LEN: 8192 },
  },
  gpu: { pools: ["ADA_24"], count: 1 },
  workers: { min: 0, max: 2 },
});
