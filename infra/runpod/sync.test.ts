import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

const readIds = async (root: string) =>
  JSON.parse(await readFile(path.join(root, "endpoints.json"), "utf8")) as unknown;

/** Makes Runpod reject the creation of one endpoint, as it does for an invalid spec. */
function rejectCreate(runpod: FakeRunpod, name: string): FakeRunpod {
  const inner = runpod.fetch;
  runpod.fetch = async (input, init) => {
    const body = init?.body ? (JSON.parse(init.body as string) as { name?: string }) : {};
    if (init?.method === "POST" && body.name === name) {
      return new Response(JSON.stringify({ title: "Unprocessable", status: 422, detail: "bad" }), {
        status: 422,
      });
    }
    return inner(input, init);
  };
  return runpod;
}

describe("sync --apply", () => {
  test("a new model is created, recorded, and the next plan has no changes", async () => {
    const runpod = fakeRunpod();
    const root = await makeRepo({ "qwen3-8b.yaml": QWEN });
    const { code, output } = await run(root, runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain("- qwen3-8b: created (ep1)");
    expect(writes(runpod)).toEqual([
      expect.objectContaining({ method: "POST", path: "/v2/serverless" }),
    ]);
    expect(await readIds(root)).toEqual({ "qwen3-8b": { id: "ep1" } });

    const again = await run(root, runpod, "--plan");
    expect(again.output).toContain("0 to create, 0 to update, 1 unchanged");
  });

  test("an update sends only the changed fields", async () => {
    const runpod = fakeRunpod([syncedQwen({ workers: { min: 0, max: 1, idleTimeout: 5 } })]);
    const root = await makeRepo({ "qwen3-8b.yaml": QWEN });
    const { code, output } = await run(root, runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain("- qwen3-8b: updated (ep-qwen)");
    expect(writes(runpod)).toEqual([
      {
        method: "PATCH",
        path: "/v2/serverless/ep-qwen",
        body: { workers: { min: 0, max: 2, idleTimeout: 5 } },
      },
    ]);
    expect(runpod.endpoints).toEqual([syncedQwen()]);
    expect(await readIds(root)).toEqual({ "qwen3-8b": { id: "ep-qwen" } });
  });

  test("no changes means no writes to Runpod", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b.yaml": QWEN }),
      runpod,
      "--apply",
    );
    expect(code).toBe(0);
    expect(output).toContain("- nothing to change");
    expect(writes(runpod)).toEqual([]);
  });

  test("an endpoint whose YAML was removed stays, and stays recorded, without --prune", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const root = await makeRepo({}, { "qwen3-8b": { id: "ep-qwen" } });
    const { code } = await run(root, runpod, "--apply");
    expect(code).toBe(0);
    expect(writes(runpod)).toEqual([]);
    expect(await readIds(root)).toEqual({ "qwen3-8b": { id: "ep-qwen" } });
  });

  test("--prune deletes it and removes it from endpoints.json", async () => {
    const other = syncedQwen({ id: "ep-manual", name: "manual" });
    const runpod = fakeRunpod([syncedQwen(), other]);
    const root = await makeRepo({}, { "qwen3-8b": { id: "ep-qwen" }, gone: { id: "ep-gone" } });
    const { code, output } = await run(root, runpod, "--apply", "--prune");
    expect(code).toBe(0);
    expect(output).toContain("- delete qwen3-8b (ep-qwen)");
    expect(output).toContain("- qwen3-8b: deleted (ep-qwen)");
    // Endpoints that endpoints.json does not list are never deleted.
    expect(runpod.endpoints).toEqual([other]);
    expect(await readIds(root)).toEqual({});
  });

  test("the first error stops the run and endpoints.json keeps what exists", async () => {
    const runpod = rejectCreate(
      fakeRunpod([syncedQwen({ workers: { min: 0, max: 1, idleTimeout: 5 } })]),
      "aaa",
    );
    const root = await makeRepo({
      "aaa.yaml": QWEN.replace("qwen3-8b", "aaa"),
      "qwen3-8b.yaml": QWEN,
    });
    const { code, output } = await run(root, runpod, "--apply", "--out", "apply.md");
    expect(code).toBe(1);
    expect(output).toContain("- aaa: failed: POST /serverless -> 422 Unprocessable: bad");
    expect(output).toContain("- qwen3-8b: skipped");
    expect(writes(runpod)).toEqual([]); // the rejected POST never reached the fake
    expect(await readIds(root)).toEqual({ "qwen3-8b": { id: "ep-qwen" } });
    expect(await readFile(path.join(root, "apply.md"), "utf8")).toContain("### Runpod apply");
  });

  test.each([[["--plan", "--apply"]], [["--plan", "--prune"]], [[]], [["--aply"]]])(
    "%j is a usage error",
    async (argv) => {
      const runpod = fakeRunpod();
      const { code, output } = await run(
        await makeRepo({ "qwen3-8b.yaml": QWEN }),
        runpod,
        ...argv,
      );
      expect(code).toBe(2);
      expect(output).toContain("usage:");
      expect(runpod.requests).toEqual([]);
    },
  );
});

describe("secrets", () => {
  const GATED = `${QWEN}secrets:\n  HF_TOKEN: hf-token\n`;
  const REF = "{{ RUNPOD_SECRET_hf-token }}";
  const secretLists = (runpod: FakeRunpod) =>
    runpod.requests.filter((r) => r.path === "/v2/account/secrets");

  test("a secret is referenced by name and the reference is shown in the plan", async () => {
    const runpod = fakeRunpod([], { secrets: ["hf-token"] });
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b.yaml": GATED }),
      runpod,
      "--plan",
    );
    expect(code).toBe(0);
    expect(output).toContain(`+     env.HF_TOKEN: "${REF}"`);
    expect(secretLists(runpod)).toHaveLength(1);
  });

  test("apply sends the reference, and the next plan has no changes", async () => {
    const runpod = fakeRunpod([], { secrets: ["hf-token"] });
    const root = await makeRepo({ "qwen3-8b.yaml": GATED });
    expect((await run(root, runpod, "--apply")).code).toBe(0);
    expect(runpod.endpoints[0]?.env?.HF_TOKEN).toBe(REF);
    expect((await run(root, runpod, "--plan")).output).toContain("1 unchanged");
  });

  test("a secret that does not exist on Runpod stops the plan", async () => {
    const runpod = fakeRunpod([], { secrets: ["other"] });
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b.yaml": GATED }),
      runpod,
      "--plan",
    );
    expect(code).toBe(1);
    expect(output).toContain('Runpod secret "hf-token" does not exist');
  });

  test("a key that may not list secrets gets a warning instead of an error", async () => {
    const runpod = fakeRunpod([], { secrets: "forbidden" });
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b.yaml": GATED }),
      runpod,
      "--plan",
    );
    expect(code).toBe(0);
    expect(output).toContain("cannot list Runpod secrets");
  });

  test("models without secrets do not list them", async () => {
    const runpod = fakeRunpod([], { secrets: "forbidden" });
    const { code } = await run(await makeRepo({ "qwen3-8b.yaml": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(secretLists(runpod)).toEqual([]);
  });

  test("a raw secret value on Runpod is replaced by the reference and stays hidden", async () => {
    const remote = syncedQwen({ env: { ...syncedQwen().env, HF_TOKEN: "hf_secret" } });
    const runpod = fakeRunpod([remote], { secrets: ["hf-token"] });
    const { output } = await run(await makeRepo({ "qwen3-8b.yaml": GATED }), runpod, "--plan");
    expect(output).toContain(`!     env.HF_TOKEN: (hidden) -> "${REF}"`);
    expect(output).not.toContain("hf_secret");
  });

  test.each([
    ["the reserved RUNPOD prefix", "RUNPOD_TOKEN", "the RUNPOD prefix is reserved"],
    ["a name with spaces", "hf token", "Runpod secret names use"],
  ])("%s is rejected", async (_, name, message) => {
    const yaml = `${QWEN}secrets:\n  HF_TOKEN: "${name}"\n`;
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b.yaml": yaml }),
      fakeRunpod(),
      "--plan",
    );
    expect(code).toBe(1);
    expect(output).toContain(message);
  });

  test("an env var set in both vllm and secrets is rejected", async () => {
    const yaml = `${QWEN}secrets:\n  MAX_MODEL_LEN: hf-token\n`;
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b.yaml": yaml }),
      fakeRunpod(),
      "--plan",
    );
    expect(code).toBe(1);
    expect(output).toContain("an env var is set in both vllm and secrets");
  });
});
