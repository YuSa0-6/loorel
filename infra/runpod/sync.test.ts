import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import type { Defaults, EndpointDef } from "./define.ts";
import type { RemoteEndpoint } from "./runpod-api.ts";
import { sync } from "./sync.ts";
import { type FakeRunpod, fakeRunpod } from "./testing/fake-runpod.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFINE_URL = pathToFileURL(path.join(REPO_ROOT, "infra/runpod/define.ts")).href;

const DEFAULTS: Defaults = {
  image: "runpod/worker-v1-vllm:v1.0.0",
  type: "QUEUE",
  disk: 50,
  flashboot: "FLASHBOOT",
  timeout: 600000,
  idleTimeout: 5,
  scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
  env: { GPU_MEMORY_UTILIZATION: "0.90" },
};

/** A fresh copy of the qwen3-8b endpoint, changed by `edit` (which may break it on purpose). */
function qwen(edit: (e: EndpointDef & Record<string, unknown>) => void = () => {}): EndpointDef {
  const e: EndpointDef = {
    model: { name: "qwen3-8b", source: "Qwen/Qwen3-8B", vllm: { MAX_MODEL_LEN: 8192 } },
    gpu: { pools: ["ADA_24"], count: 1 },
    workers: { min: 0, max: 2 },
  };
  edit(e as EndpointDef & Record<string, unknown>);
  return e;
}
const QWEN = qwen();
const GATED = qwen((e) => {
  e.model.secrets = { HF_TOKEN: "hf-token" };
});

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

/** A repository whose loorel.config.ts declares `endpoints`. */
async function makeRepo(endpoints: unknown[], endpointsJson?: unknown): Promise<string> {
  const config = JSON.stringify({ defaults: DEFAULTS, endpoints }, null, 2);
  return makeRepoWithConfig(
    `import { defineConfig } from ${JSON.stringify(DEFINE_URL)};\n` +
      `export default defineConfig(${config});\n`,
    endpointsJson,
  );
}

async function makeRepoWithConfig(source: string | null, endpointsJson?: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "loorel-"));
  await mkdir(root, { recursive: true });
  if (source !== null) await writeFile(path.join(root, "loorel.config.ts"), source);
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
  test("the repository's own loorel.config.ts and models/ are valid", async () => {
    const runpod = fakeRunpod();
    const { code, output } = await run(REPO_ROOT, runpod, "--plan");
    expect(output).toContain("+ create qwen3-8b");
    expect(code).toBe(0);
  });

  test("a new model is shown as create and nothing is written", async () => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepo([QWEN]), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("**1 to create, 0 to update, 0 unchanged");
    expect(output).toContain('+     env.OPENAI_SERVED_MODEL_NAME_OVERRIDE: "qwen3-8b"');
    expect(writes(runpod)).toEqual([]);
  });

  test("an endpoint that matches its definition has no changes", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const { code, output } = await run(await makeRepo([QWEN]), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("0 to create, 0 to update, 1 unchanged");
  });

  test("only the fields that differ are listed, and secrets on Runpod are hidden", async () => {
    const remote = syncedQwen({
      workers: { min: 0, max: 1, idleTimeout: 5 },
      env: { ...syncedQwen().env, MAX_MODEL_LEN: "4096", HF_TOKEN: "hf_secret" },
    });
    const runpod = fakeRunpod([remote]);
    const { code, output } = await run(await makeRepo([QWEN]), runpod, "--plan");
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
    const { output } = await run(await makeRepo([QWEN]), runpod, "--plan");
    expect(output).toContain("1 unchanged");
  });

  test("an endpoint removed from the config is reported but not deleted", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const root = await makeRepo([], { "qwen3-8b": { id: "ep-qwen" } });
    const { code, output } = await run(root, runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain(
      "- qwen3-8b (ep-qwen): removed from loorel.config.ts; not deleted unless apply runs with --prune",
    );
  });

  test("two Runpod endpoints with the same name stop the plan", async () => {
    const runpod = fakeRunpod([syncedQwen(), syncedQwen({ id: "ep-dup" })]);
    const { code, output } = await run(await makeRepo([QWEN]), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain("2 endpoints on Runpod share this name (ep-qwen, ep-dup)");
  });

  test.each([
    [
      "an unknown GPU pool",
      qwen((e) => {
        e.gpu.pools = ["ADA_99" as "ADA_24"];
      }),
      'unknown GPU pool "ADA_99"',
    ],
    [
      "an excluded type outside the pools",
      qwen((e) => {
        e.gpu.excludedTypes = ["NVIDIA A100 80GB PCIe"];
      }),
      'excludedTypes "NVIDIA A100 80GB PCIe" is not a GPU type in the selected pools',
    ],
    [
      "a secret value in the config",
      qwen((e) => {
        e.model.vllm = { HF_TOKEN: "hf_x" };
      }),
      "endpoints[0] (qwen3-8b) model.vllm.HF_TOKEN: secret values must not be written in the config",
    ],
    [
      "a missing source",
      qwen((e) => {
        e.model.source = "";
      }),
      "model.source: source is required",
    ],
    [
      "MODEL_NAME written by hand",
      qwen((e) => {
        e.model.vllm = { MODEL_NAME: "Qwen/Qwen3-8B" };
      }),
      "MODEL_NAME is set from the model source",
    ],
    [
      "min above max",
      qwen((e) => {
        e.workers.min = 3;
      }),
      "workers.min must be <= workers.max",
    ],
    [
      "a typo in a field name",
      qwen((e) => {
        e.worker = e.workers;
        delete (e as Partial<EndpointDef>).workers;
      }),
      "worker",
    ],
    [
      "an invalid endpoint name",
      qwen((e) => {
        e.name = "Qwen_8B";
      }),
      "endpoints[0] (Qwen_8B) name: names are lowercase a-z, 0-9 and -",
    ],
  ])("%s is rejected", async (_, endpoint, message) => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepo([endpoint]), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(writes(runpod)).toEqual([]);
  });

  test("one model can run on two endpoints with different names", async () => {
    const runpod = fakeRunpod();
    const big = qwen((e) => {
      e.name = "qwen3-8b-a100";
      e.gpu = { pools: ["AMPERE_80"] };
      e.idleTimeout = 60;
    });
    const { code, output } = await run(await makeRepo([QWEN, big]), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("**2 to create");
    expect(output).toContain("+ create qwen3-8b-a100");
    expect(output).toContain('+     workers: {"min":0,"max":2,"idleTimeout":60}');
    // Both serve the same model name, so apps call them the same way.
    expect(output.match(/OPENAI_SERVED_MODEL_NAME_OVERRIDE: "qwen3-8b"/g)).toHaveLength(2);
  });

  test("two endpoints with the same name are rejected", async () => {
    const { code, output } = await run(await makeRepo([QWEN, qwen()]), fakeRunpod(), "--plan");
    expect(code).toBe(1);
    expect(output).toContain("two endpoints are named qwen3-8b");
  });

  test("an env var set to undefined is left out", async () => {
    const config = `import { defineConfig } from ${JSON.stringify(DEFINE_URL)};
export default defineConfig({
  defaults: ${JSON.stringify(DEFAULTS)},
  endpoints: [{ ...${JSON.stringify(QWEN)}, model: { ...${JSON.stringify(QWEN.model)}, vllm: { MAX_MODEL_LEN: 8192, DTYPE: undefined } } }],
});
`;
    const runpod = fakeRunpod([syncedQwen()]);
    const { code, output } = await run(await makeRepoWithConfig(config), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("1 unchanged");
  });

  test.each([
    ["a missing config", null, "loorel.config.ts not found"],
    ["a config without a default export", "export const x = 1;\n", "it has no default export"],
    ["a config that throws", 'throw new Error("boom");\n', "loorel.config.ts: boom"],
  ])("%s is a config error", async (_, source, message) => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepoWithConfig(source), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(runpod.requests).toEqual([]);
  });

  test("Runpod errors are reported without a stack trace", async () => {
    const runpod = fakeRunpod();
    const lines: string[] = [];
    const root = await makeRepo([QWEN]);
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
    const root = await makeRepo([QWEN]);
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
    const root = await makeRepo([QWEN]);
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
    const { code, output } = await run(await makeRepo([QWEN]), runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain("- nothing to change");
    expect(writes(runpod)).toEqual([]);
  });

  test("an endpoint removed from the config stays, and stays recorded, without --prune", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const root = await makeRepo([], { "qwen3-8b": { id: "ep-qwen" } });
    const { code } = await run(root, runpod, "--apply");
    expect(code).toBe(0);
    expect(writes(runpod)).toEqual([]);
    expect(await readIds(root)).toEqual({ "qwen3-8b": { id: "ep-qwen" } });
  });

  test("--prune deletes it and removes it from endpoints.json", async () => {
    const other = syncedQwen({ id: "ep-manual", name: "manual" });
    const runpod = fakeRunpod([syncedQwen(), other]);
    const root = await makeRepo([], { "qwen3-8b": { id: "ep-qwen" }, gone: { id: "ep-gone" } });
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
    const root = await makeRepo([
      QWEN,
      qwen((e) => {
        e.name = "aaa";
      }),
    ]);
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
      const { code, output } = await run(await makeRepo([QWEN]), runpod, ...argv);
      expect(code).toBe(2);
      expect(output).toContain("usage:");
      expect(runpod.requests).toEqual([]);
    },
  );
});

describe("secrets", () => {
  const REF = "{{ RUNPOD_SECRET_hf-token }}";
  const secretLists = (runpod: FakeRunpod) =>
    runpod.requests.filter((r) => r.path === "/v2/account/secrets");

  test("a secret is referenced by name and the reference is shown in the plan", async () => {
    const runpod = fakeRunpod([], { secrets: ["hf-token"] });
    const { code, output } = await run(await makeRepo([GATED]), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain(`+     env.HF_TOKEN: "${REF}"`);
    expect(secretLists(runpod)).toHaveLength(1);
  });

  test("apply sends the reference, and the next plan has no changes", async () => {
    const runpod = fakeRunpod([], { secrets: ["hf-token"] });
    const root = await makeRepo([GATED]);
    expect((await run(root, runpod, "--apply")).code).toBe(0);
    expect(runpod.endpoints[0]?.env?.HF_TOKEN).toBe(REF);
    expect((await run(root, runpod, "--plan")).output).toContain("1 unchanged");
  });

  test("a secret that does not exist on Runpod stops the plan", async () => {
    const runpod = fakeRunpod([], { secrets: ["other"] });
    const { code, output } = await run(await makeRepo([GATED]), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain('Runpod secret "hf-token" does not exist');
  });

  test("a key that may not list secrets gets a warning instead of an error", async () => {
    const runpod = fakeRunpod([], { secrets: "forbidden" });
    const { code, output } = await run(await makeRepo([GATED]), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("cannot list Runpod secrets");
  });

  test("models without secrets do not list them", async () => {
    const runpod = fakeRunpod([], { secrets: "forbidden" });
    const { code } = await run(await makeRepo([QWEN]), runpod, "--plan");
    expect(code).toBe(0);
    expect(secretLists(runpod)).toEqual([]);
  });

  test("a raw secret value on Runpod is replaced by the reference and stays hidden", async () => {
    const remote = syncedQwen({ env: { ...syncedQwen().env, HF_TOKEN: "hf_secret" } });
    const runpod = fakeRunpod([remote], { secrets: ["hf-token"] });
    const { output } = await run(await makeRepo([GATED]), runpod, "--plan");
    expect(output).toContain(`!     env.HF_TOKEN: (hidden) -> "${REF}"`);
    expect(output).not.toContain("hf_secret");
  });

  test.each([
    ["the reserved RUNPOD prefix", "RUNPOD_TOKEN", "the RUNPOD prefix is reserved"],
    ["a name with spaces", "hf token", "Runpod secret names use"],
  ])("%s is rejected", async (_, name, message) => {
    const endpoint = qwen((e) => {
      e.model.secrets = { HF_TOKEN: name };
    });
    const { code, output } = await run(await makeRepo([endpoint]), fakeRunpod(), "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
  });

  test("an env var set in both vllm and secrets is rejected", async () => {
    const endpoint = qwen((e) => {
      e.model.secrets = { MAX_MODEL_LEN: "hf-token" };
    });
    const { code, output } = await run(await makeRepo([endpoint]), fakeRunpod(), "--plan");
    expect(code).toBe(1);
    expect(output).toContain("an env var is set in both vllm and secrets");
  });
});
