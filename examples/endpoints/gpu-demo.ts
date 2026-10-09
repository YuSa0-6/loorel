// The Runpod Flash quickstart (multiply two random matrices on a GPU) as a typed endpoint.
// The worker code lives in the image; this file declares the hardware and the job's JSON.
import * as v from "valibot";
import { defineEndpoint } from "../../infra/runpod/define.ts";

export default defineEndpoint({
  name: "gpu-demo",
  // Placeholder: a worker image whose handler reads { size } and returns the fields below.
  image: "ghcr.io/example/gpu-demo:0.1.0",
  gpu: { pools: ["ADA_24", "AMPERE_24"] },
  workers: { min: 0, max: 3 },
  input: v.object({
    size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192)),
  }),
  output: v.object({
    size: v.number(),
    mean: v.number(),
    gpu: v.string(),
  }),
});
