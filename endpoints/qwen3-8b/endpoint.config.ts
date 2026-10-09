import { defineEndpoint } from "loorel";
import model from "./model.config.ts";

export default defineEndpoint({
  model,
  gpu: { pools: ["ADA_24"], count: 1 },
  workers: { min: 0, max: 2 },
});
