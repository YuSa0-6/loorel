import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import type { RemoteEndpoint } from "./runpod-api.ts";
import { sync } from "./sync.ts";
import { type FakeRunpod, fakeRunpod } from "./testing/fake-runpod.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULTS = `
image: runpod/worker-v1-vllm:v1.0.0
type: QUEUE
disk: 50
flashboot: FLASHBOOT
timeout: 600000
idleTimeout: 5
scaling: { type: QUEUE_DELAY, queueDelay: 4 }
env:
  GPU_MEMORY_UTILIZATION: "0.90"
`;

const QWEN = `
name: qwen3-8b
gpu: { pools: [ADA_24], count: 1 }
workers: { min: 0, max: 2 }
vllm:
  MODEL_NAME: Qwen/Qwen3-8B
  MAX_MODEL_LEN: "8192"
`;

/** What Runpod holds after QWEN was synced with DEFAULTS. */
function syncedQwen(overrides: Partial<RemoteEndpoint> = {}): RemoteEndpoint {
  return {
    id: "ep-qwen",
    name: "qwen3-8b",
    type: "QUEUE",
    image: "runpod/worker-v1-vllm:v1.0.0",
    disk: 50,
    env: {
      GPU_MEMORY_UTILIZATION: "0.90",
      MODEL_NAME: "Qwen/Qwen3-8B",
      MAX_MODEL_LEN: "8192",
      OPENAI_SERVED_MODEL_NAME_OVERRIDE: "qwen3-8b",
    },
    gpu: { pools: ["ADA_24"], excludedTypes: [], count: 1 },
    workers: { min: 0, max: 2, idleTimeout: 5 },
    scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
    timeout: 600000,
    flashboot: "FLASHBOOT",
    ...overrides,
  };
}

async function makeRepo(models: Record<string, string>, endpointsJson?: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loorel-"));
  await mkdir(path.join(root, "infra/runpod"), { recursive: true });
  await mkdir(path.join(root, "models"));
  await writeFile(path.join(root, "infra/runpod/defaults.yaml"), DEFAULTS);
  for (const [file, body] of Object.entries(models))
    await writeFile(path.join(root, "models", file), body);
  if (endpointsJson)
    await writeFile(path.join(root, "endpoints.json"), JSON.stringify(endpointsJson));
  return root;
}

async function run(root: string, runpod: FakeRunpod, ...argv: string[]) {
  const lines: string[] = [];
  const code = await sync({
    argv,
    root,
    env: { RUNPOD_API_KEY: "test-key" },
    fetch: runpod.fetch,
    log: (l) => lines.push(l),
  });
  return { code, output: lines.join("\n") };
}

const writes = (runpod: FakeRunpod) => runpod.requests.filter((r) => r.method !== "GET");

describe("sync --plan", () => {
  test("the repository's own models/ and defaults are valid", async () => {
    const runpod = fakeRunpod();
    const { code, output } = await run(REPO_ROOT, runpod, "--plan");
    expect(output).toContain("+ create qwen3-8b");
    expect(code).toBe(0);
  });

  test("a new model is shown as create and nothing is written", async () => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepo({ "qwen3-8b.yaml": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("**1 to create, 0 to update, 0 unchanged");
    expect(output).toContain('+     env.OPENAI_SERVED_MODEL_NAME_OVERRIDE: "qwen3-8b"');
    expect(writes(runpod)).toEqual([]);
  });

  test("an endpoint that matches its YAML has no changes", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const { code, output } = await run(await makeRepo({ "qwen3-8b.yaml": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("0 to create, 0 to update, 1 unchanged");
  });

  test("only the fields that differ are listed, and secrets on Runpod are hidden", async () => {
    const remote = syncedQwen({
      workers: { min: 0, max: 1, idleTimeout: 5 },
      env: { ...syncedQwen().env, MAX_MODEL_LEN: "4096", HF_TOKEN: "hf_secret" },
    });
    const runpod = fakeRunpod([remote]);
    const { code, output } = await run(await makeRepo({ "qwen3-8b.yaml": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("! update qwen3-8b (ep-qwen)");
    expect(output).toContain('!     env.MAX_MODEL_LEN: "4096" -> "8192"');
    expect(output).toContain("!     env.HF_TOKEN: (hidden) -> (none)");
    expect(output).toContain("!     workers.max: 1 -> 2");
    expect(output).not.toContain("hf_secret");
    expect(output).not.toContain("image");
    expect(writes(runpod)).toEqual([]);
  });

  test("endpoints on other pages of the list are found", async () => {
    const others = [1, 2, 3].map((i) => syncedQwen({ id: `other${i}`, name: `other-${i}` }));
    const runpod = fakeRunpod([...others, syncedQwen()], { pageSize: 2 });
    const { output } = await run(await makeRepo({ "qwen3-8b.yaml": QWEN }), runpod, "--plan");
    expect(output).toContain("1 unchanged");
  });

  test("an endpoint whose YAML was removed is reported but not deleted", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const root = await makeRepo({}, { "qwen3-8b": { id: "ep-qwen" } });
    const { code, output } = await run(root, runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain(
      "- qwen3-8b (ep-qwen): YAML removed; not deleted unless apply runs with --prune",
    );
  });

  test("two Runpod endpoints with the same name stop the plan", async () => {
    const runpod = fakeRunpod([syncedQwen(), syncedQwen({ id: "ep-dup" })]);
    const { code, output } = await run(await makeRepo({ "qwen3-8b.yaml": QWEN }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain("2 endpoints on Runpod share this name (ep-qwen, ep-dup)");
  });

  test.each([
    ["an unknown GPU pool", QWEN.replace("ADA_24", "ADA_99"), 'unknown GPU pool "ADA_99"'],
    [
      "an excluded type outside the pools",
      QWEN.replace("count: 1", 'count: 1, excludedTypes: ["NVIDIA A100 80GB PCIe"]'),
      'excludedTypes "NVIDIA A100 80GB PCIe" is not a GPU type in the selected pools',
    ],
    ["a secret in YAML", `${QWEN}  HF_TOKEN: hf_x\n`, "secrets must not be written in YAML"],
    [
      "a missing MODEL_NAME",
      QWEN.replace("MODEL_NAME: Qwen/Qwen3-8B", ""),
      "vllm.MODEL_NAME is required",
    ],
    ["min above max", QWEN.replace("min: 0", "min: 3"), "workers.min must be <= workers.max"],
    ["a typo in a field name", QWEN.replace("workers:", "worker:"), "worker"],
  ])("%s is rejected", async (_, yaml, message) => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepo({ "qwen3-8b.yaml": yaml }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
  });

  test("a file name that differs from name is rejected", async () => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepo({ "qwen.yaml": QWEN }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain("models/qwen.yaml: file name must be qwen3-8b.yaml");
  });

  test("Runpod errors are reported without a stack trace", async () => {
    const runpod = fakeRunpod();
    const lines: string[] = [];
    const root = await makeRepo({ "qwen3-8b.yaml": QWEN });
    const code = await sync({
      argv: ["--plan"],
      root,
      env: { RUNPOD_API_KEY: "wrong" },
      fetch: runpod.fetch,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("401 Unauthorized: missing bearer token");
  });
});
