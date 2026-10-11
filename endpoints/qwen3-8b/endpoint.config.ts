import { defineEndpoint } from "@loorel/define";
import model from "./model.config.ts";

export default defineEndpoint({
  model,
  engine: {
    type: "vllm",
    env: { MAX_MODEL_LEN: 8192 },
  },
  gpu: { pools: ["ADA_24"], count: 1 },
  workers: { min: 0, max: 2 },
});
