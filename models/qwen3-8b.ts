import { defineModel } from "loorel/config";

export default defineModel({
  name: "qwen3-8b",
  source: "Qwen/Qwen3-8B",
  vllm: {
    MAX_MODEL_LEN: 8192,
  },
});
