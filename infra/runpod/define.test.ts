import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { parse } from "yaml";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { invoke, InvokeError } from "../../src/invoke.ts";
import { ConfigError, Defaults, loadSpecs, modelToSpec } from "./config.ts";
import { defineEndpoint, defineModel, type EndpointInput, type EndpointOutput } from "./define.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const demo = defineEndpoint({
  name: "gpu-demo",
  image: "ghcr.io/example/gpu-demo:0.1.0",
  gpu: { pools: ["ADA_24"] },
  workers: { min: 0, max: 3 },
  secrets: { HF_TOKEN: "hf-token" },
  input: v.object({ size: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
  output: v.object({ mean: v.number(), gpu: v.string() }),
});

describe("defineModel", () => {
  test("gives the same spec as the YAML model", async () => {
    const [fromYaml] = await loadSpecs(REPO_ROOT);
    const model = defineModel({
      name: "qwen3-8b",
      gpu: { pools: ["ADA_24"], count: 1 },
      workers: { min: 0, max: 2 },
      vllm: { MODEL_NAME: "Qwen/Qwen3-8B", MAX_MODEL_LEN: 8192 },
    });
    const defaults = v.parse(
      Defaults,
      parse(await readFile(path.join(REPO_ROOT, "infra/runpod/defaults.yaml"), "utf8")),
    );
    expect(modelToSpec(defaults, model)).toEqual(fromYaml);
  });

  test("rejects what the YAML schema rejects", () => {
    expect(() =>
      defineModel({
        name: "Bad_Name",
        gpu: { pools: ["ADA_24"] },
        workers: { min: 3, max: 1 },
        vllm: { MODEL_NAME: "x", HF_TOKEN: "hf_secret" },
      }),
    ).toThrow(ConfigError);
  });
});

describe("defineEndpoint", () => {
  test("fills defaults and turns secrets into references", () => {
    expect(demo.spec).toEqual({
      name: "gpu-demo",
      type: "QUEUE",
      image: "ghcr.io/example/gpu-demo:0.1.0",
      disk: 20,
      env: { HF_TOKEN: "{{ RUNPOD_SECRET_hf-token }}" },
      gpu: { pools: ["ADA_24"], excludedTypes: [], count: 1 },
      workers: { min: 0, max: 3, idleTimeout: 5 },
      scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
      timeout: 600000,
      flashboot: "FLASHBOOT",
    });
  });

  test("types the job input and output from the schemas", () => {
    expectTypeOf<EndpointInput<typeof demo>>().toEqualTypeOf<{ size: number }>();
    expectTypeOf<EndpointOutput<typeof demo>>().toEqualTypeOf<{ mean: number; gpu: string }>();
  });

  test("rejects an image without a tag", () => {
    expect(() =>
      defineEndpoint({
        ...demo.spec,
        image: "ghcr.io/example/gpu-demo",
        secrets: {},
        input: v.any(),
        output: v.any(),
      }),
    ).toThrow(/explicit tag/);
  });
});

function fakeJobs(responses: unknown[]) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({
      url: input as string, // invoke always passes a string URL
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json(responses.shift());
  };
  return { fetch: fetchFn, requests };
}

const OPTIONS = { endpointId: "ep1", apiKey: "test-key", pollIntervalMs: 0 };

describe("invoke", () => {
  test("waits for the job and returns the checked output", async () => {
    const t = fakeJobs([
      { id: "job1", status: "IN_PROGRESS" },
      { id: "job1", status: "COMPLETED", output: { mean: 0.5, gpu: "RTX 4090" } },
    ]);
    const out = await invoke(demo, { size: 1024 }, { ...OPTIONS, fetch: t.fetch });
    expect(out).toEqual({ mean: 0.5, gpu: "RTX 4090" });
    expect(t.requests).toEqual([
      {
        url: "https://api.runpod.ai/v2/ep1/runsync",
        method: "POST",
        body: { input: { size: 1024 } },
      },
      { url: "https://api.runpod.ai/v2/ep1/status/job1", method: "GET", body: undefined },
    ]);
  });

  test("checks the input before sending", async () => {
    const t = fakeJobs([]);
    await expect(invoke(demo, { size: 0 }, { ...OPTIONS, fetch: t.fetch })).rejects.toThrow(
      /invalid input/,
    );
    expect(t.requests).toEqual([]);
  });

  test("rejects output that does not match the schema", async () => {
    const t = fakeJobs([{ id: "job1", status: "COMPLETED", output: { mean: "high" } }]);
    await expect(invoke(demo, { size: 1 }, { ...OPTIONS, fetch: t.fetch })).rejects.toThrow(
      InvokeError,
    );
  });

  test("reports a failed job", async () => {
    const t = fakeJobs([{ id: "job1", status: "FAILED", error: "CUDA OOM" }]);
    await expect(invoke(demo, { size: 1 }, { ...OPTIONS, fetch: t.fetch })).rejects.toThrow(
      "gpu-demo: job job1 FAILED",
    );
  });
});
