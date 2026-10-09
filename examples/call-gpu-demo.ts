// Calls the gpu-demo endpoint. Run: RUNPOD_API_KEY=... RUNPOD_ENDPOINT_ID=... node examples/call-gpu-demo.ts
import { invoke } from "../src/invoke.ts";
import gpuDemo from "./endpoints/gpu-demo.ts";

const result = await invoke(
  gpuDemo,
  { size: 1024 }, // { size: "1024" } is a type error; { size: 0 } fails validation before sending
  {
    endpointId: process.env.RUNPOD_ENDPOINT_ID ?? "",
    apiKey: process.env.RUNPOD_API_KEY ?? "",
  },
);
// result: { size: number; mean: number; gpu: string }
console.log(`${result.gpu}: mean of ${result.size}x${result.size} = ${result.mean}`);
