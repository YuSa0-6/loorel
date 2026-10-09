// The TypeScript form of models/qwen3-8b.yaml.
import { defineModel } from "../../infra/runpod/define.ts";

export default defineModel({
  name: "qwen3-8b",
  gpu: { pools: ["ADA_24"], count: 1 },
  workers: { min: 0, max: 2 },
  vllm: {
    MODEL_NAME: "Qwen/Qwen3-8B",
    MAX_MODEL_LEN: 8192,
  },
});
