import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { EndpointDef } from "./define.ts";
import type { RemoteEndpoint } from "./runpod-api.ts";
import { sync } from "./sync.ts";
import { type FakeRunpod, fakeRunpod } from "./testing/fake-runpod.ts";
import {
  CONFIG,
  DEFAULTS,
  endpointFile,
  LOOREL,
  makeRepo,
  makeRepoWithFiles,
  qwen,
  QWEN,
  REPO_ROOT,
} from "./testing/repo.ts";

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
  test("the repository's own loorel.config.ts and endpoints/ are valid", async () => {
    const runpod = fakeRunpod();
    const { code, output } = await run(REPO_ROOT, runpod, "--plan");
    expect(output).toContain("+ create qwen3-8b");
    expect(code).toBe(0);
  });

  test("a new model is shown as create and nothing is written", async () => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("**1 to create, 0 to update, 0 unchanged");
    expect(output).toContain('+     env.OPENAI_SERVED_MODEL_NAME_OVERRIDE: "qwen3-8b"');
    expect(writes(runpod)).toEqual([]);
  });

  test("an endpoint that matches its definition has no changes", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const { code, output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("0 to create, 0 to update, 1 unchanged");
  });

  test("only the fields that differ are listed, and secrets on Runpod are hidden", async () => {
    const remote = syncedQwen({
      workers: { min: 0, max: 1, idleTimeout: 5 },
      env: { ...syncedQwen().env, MAX_MODEL_LEN: "4096", HF_TOKEN: "hf_secret" },
    });
    const runpod = fakeRunpod([remote]);
    const { code, output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
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
    const { output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
    expect(output).toContain("1 unchanged");
  });

  test("an endpoint whose directory was removed is reported but not deleted", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const root = await makeRepo({}, { "qwen3-8b": { id: "ep-qwen" } });
    const { code, output } = await run(root, runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain(
      "- qwen3-8b (ep-qwen): endpoints/qwen3-8b/ removed; not deleted unless apply runs with --prune",
    );
  });

  test("two Runpod endpoints with the same name stop the plan", async () => {
    const runpod = fakeRunpod([syncedQwen(), syncedQwen({ id: "ep-dup" })]);
    const { code, output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain("2 endpoints on Runpod share this name (ep-qwen, ep-dup)");
  });

  test.each([
    [
      "an unknown GPU pool",
      qwen((e) => {
        e.gpu = { pools: ["ADA_99" as "ADA_24"], count: 1 };
      }),
      'unknown GPU pool "ADA_99"',
    ],
    [
      "an excluded type outside the pools",
      qwen((e) => {
        e.gpu = { pools: ["ADA_24"], count: 1, excludedTypes: ["NVIDIA A100 80GB PCIe"] };
      }),
      'excludedTypes "NVIDIA A100 80GB PCIe" is not a GPU type in the selected pools',
    ],
    [
      "a secret value in the config",
      qwen((e) => {
        e.model.vllm = { HF_TOKEN: "hf_x" };
      }),
      "endpoints/qwen3-8b/endpoint.config.ts:\n  model.vllm.HF_TOKEN: secret values must not be written in the config",
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
  ])("%s is rejected", async (_, endpoint, message) => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepo({ "qwen3-8b": endpoint }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(writes(runpod)).toEqual([]);
  });

  test("one model can run on two endpoints, imported from the other directory", async () => {
    const runpod = fakeRunpod();
    const root = await makeRepoWithFiles({
      "loorel.config.ts": CONFIG,
      "endpoints/qwen3-8b/model.config.ts": `export default ${JSON.stringify(QWEN.model)};\n`,
      "endpoints/qwen3-8b/endpoint.config.ts": `import { defineEndpoint } from ${LOOREL};
import model from "./model.config.ts";
export default defineEndpoint({ model, gpu: { pools: ["ADA_24"], count: 1 }, workers: { min: 0, max: 2 } });
`,
      "endpoints/qwen3-8b-a100/endpoint.config.ts": `import { defineEndpoint } from ${LOOREL};
import model from "../qwen3-8b/model.config.ts";
export default defineEndpoint({ model, gpu: { pools: ["AMPERE_80"] }, workers: { min: 0, max: 2 }, idleTimeout: 60 });
`,
    });
    const { code, output } = await run(root, runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("**2 to create");
    expect(output).toContain("+ create qwen3-8b-a100");
    expect(output).toContain('+     workers: {"min":0,"max":2,"idleTimeout":60}');
    // Both serve the same model name, so apps call them the same way.
    expect(output.match(/OPENAI_SERVED_MODEL_NAME_OVERRIDE: "qwen3-8b"/g)).toHaveLength(2);
  });

  test("directories starting with _ hold shared code and are not endpoints", async () => {
    const root = await makeRepoWithFiles({
      "loorel.config.ts": CONFIG,
      "endpoints/_shared/qwen.ts": `export default ${JSON.stringify(QWEN.model)};\n`,
      "endpoints/qwen3-8b/endpoint.config.ts": `import { defineEndpoint } from ${LOOREL};
import model from "../_shared/qwen.ts";
export default defineEndpoint({ ...${JSON.stringify(QWEN)}, model });
`,
      "endpoints/README.md": "plain files are ignored\n",
    });
    const { code, output } = await run(root, fakeRunpod([syncedQwen()]), "--plan");
    expect(code).toBe(0);
    expect(output).toContain("0 to create, 0 to update, 1 unchanged");
  });

  test("an env var set to undefined is left out", async () => {
    const root = await makeRepoWithFiles({
      "loorel.config.ts": CONFIG,
      "endpoints/qwen3-8b/endpoint.config.ts": `export default {
  ...${JSON.stringify(QWEN)},
  model: { ...${JSON.stringify(QWEN.model)}, vllm: { MAX_MODEL_LEN: 8192, DTYPE: undefined } },
};
`,
    });
    const { code, output } = await run(root, fakeRunpod([syncedQwen()]), "--plan");
    expect(code).toBe(0);
    expect(output).toContain("1 unchanged");
  });

  test.each([
    ["a missing loorel.config.ts", {}, "loorel.config.ts not found"],
    [
      "a config without a default export",
      { "loorel.config.ts": "export const x = 1;\n" },
      "loorel.config.ts: it has no default export",
    ],
    [
      "a config that throws",
      {
        "loorel.config.ts": CONFIG,
        "endpoints/qwen3-8b/endpoint.config.ts": 'throw new Error("boom");\n',
      },
      "endpoints/qwen3-8b/endpoint.config.ts: boom",
    ],
    [
      "a directory without endpoint.config.ts",
      {
        "loorel.config.ts": CONFIG,
        "endpoints/qwen3-8b/endpont.config.ts": "export default {};\n",
      },
      "endpoints/qwen3-8b: endpoint.config.ts not found",
    ],
    [
      "a directory name that cannot be an endpoint name",
      { "loorel.config.ts": CONFIG, "endpoints/Qwen_8B/endpoint.config.ts": endpointFile(QWEN) },
      "endpoints/Qwen_8B: names are lowercase a-z, 0-9 and - (the directory name is the endpoint name)",
    ],
    [
      "an unknown field in loorel.config.ts",
      {
        "loorel.config.ts": `export default { defaults: ${JSON.stringify(DEFAULTS)}, endpoints: [] };\n`,
      },
      "loorel.config.ts:\n  endpoints:",
    ],
  ])("%s is a config error", async (_, files, message) => {
    const runpod = fakeRunpod();
    const { code, output } = await run(await makeRepoWithFiles(files), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(runpod.requests).toEqual([]);
  });

  test("Runpod errors are reported without a stack trace", async () => {
    const runpod = fakeRunpod();
    const lines: string[] = [];
    const root = await makeRepo({ "qwen3-8b": QWEN });
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
    const root = await makeRepo({ "qwen3-8b": QWEN });
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
    const root = await makeRepo({ "qwen3-8b": QWEN });
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
    const { code, output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain("- nothing to change");
    expect(writes(runpod)).toEqual([]);
  });

  test("an endpoint whose directory was removed stays, and stays recorded, without --prune", async () => {
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
    const root = await makeRepo({ aaa: QWEN, "qwen3-8b": QWEN });
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
      const { code, output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, ...argv);
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
    const { code, output } = await run(await makeRepo({ "qwen3-8b": GATED }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain(`+     env.HF_TOKEN: "${REF}"`);
    expect(secretLists(runpod)).toHaveLength(1);
  });

  test("apply sends the reference, and the next plan has no changes", async () => {
    const runpod = fakeRunpod([], { secrets: ["hf-token"] });
    const root = await makeRepo({ "qwen3-8b": GATED });
    expect((await run(root, runpod, "--apply")).code).toBe(0);
    expect(runpod.endpoints[0]?.env?.HF_TOKEN).toBe(REF);
    expect((await run(root, runpod, "--plan")).output).toContain("1 unchanged");
  });

  test("a secret that does not exist on Runpod stops the plan", async () => {
    const runpod = fakeRunpod([], { secrets: ["other"] });
    const { code, output } = await run(await makeRepo({ "qwen3-8b": GATED }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain('Runpod secret "hf-token" does not exist');
  });

  test("a key that may not list secrets gets a warning instead of an error", async () => {
    const runpod = fakeRunpod([], { secrets: "forbidden" });
    const { code, output } = await run(await makeRepo({ "qwen3-8b": GATED }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("cannot list Runpod secrets");
  });

  test("models without secrets do not list them", async () => {
    const runpod = fakeRunpod([], { secrets: "forbidden" });
    const { code } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(secretLists(runpod)).toEqual([]);
  });

  test("a raw secret value on Runpod is replaced by the reference and stays hidden", async () => {
    const remote = syncedQwen({ env: { ...syncedQwen().env, HF_TOKEN: "hf_secret" } });
    const runpod = fakeRunpod([remote], { secrets: ["hf-token"] });
    const { output } = await run(await makeRepo({ "qwen3-8b": GATED }), runpod, "--plan");
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
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b": endpoint }),
      fakeRunpod(),
      "--plan",
    );
    expect(code).toBe(1);
    expect(output).toContain(message);
  });

  test("an env var set in both vllm and secrets is rejected", async () => {
    const endpoint = qwen((e) => {
      e.model.secrets = { MAX_MODEL_LEN: "hf-token" };
    });
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b": endpoint }),
      fakeRunpod(),
      "--plan",
    );
    expect(code).toBe(1);
    expect(output).toContain("an env var is set in both vllm and secrets");
  });
});

describe("decision models", () => {
  const CLEF_IMAGE = "example/clef-worker:v1.0.0";
  const clef = (edit: (e: EndpointDef) => void = () => {}) =>
    qwen((e) => {
      e.model = { name: "clef", source: "Cloudflare/clef", api: "decision" };
      e.image = CLEF_IMAGE;
      edit(e);
    });

  test("a decision model runs the endpoint's own worker image", async () => {
    const { code, output } = await run(await makeRepo({ clef: clef() }), fakeRunpod(), "--plan");
    expect(code).toBe(0);
    expect(output).toContain(`+     image: "${CLEF_IMAGE}"`);
    expect(output).toContain('+     env.MODEL_NAME: "Cloudflare/clef"');
  });

  test("a decision model without an image is rejected", async () => {
    const endpoint = clef((e) => {
      delete e.image;
    });
    const { code, output } = await run(await makeRepo({ clef: endpoint }), fakeRunpod(), "--plan");
    expect(code).toBe(1);
    expect(output).toContain("a decision model needs a worker image");
  });

  test("a decision model needs a queue endpoint", async () => {
    const root = await makeRepoWithFiles({
      "loorel.config.ts": `export default { defaults: ${JSON.stringify({ ...DEFAULTS, type: "LOAD_BALANCER" })} };\n`,
      "endpoints/clef/endpoint.config.ts": endpointFile(clef()),
    });
    const { code, output } = await run(root, fakeRunpod(), "--plan");
    expect(code).toBe(1);
    expect(output).toContain("a decision model needs type QUEUE");
  });
});

describe("GPU types, data centers, network volumes and CUDA", () => {
  const VOLUMES = [
    { id: "vol-ro", name: "weights-ro", dataCenter: "EU-RO-1" },
    { id: "vol-ro2", name: "weights-ro-2", dataCenter: "EU-RO-1" },
    { id: "vol-tx", name: "weights-tx", dataCenter: "US-TX-3" },
  ];
  const placed = (edit: (e: EndpointDef) => void) =>
    qwen((e) => {
      e.dataCenters = ["EU-RO-1"];
      e.networkVolumes = ["vol-ro"];
      edit(e);
    });

  test("gpu.types becomes the pools that hold them, with every other type excluded", async () => {
    const runpod = fakeRunpod();
    const endpoint = qwen((e) => {
      e.gpu = { types: ["NVIDIA GeForce RTX 4090"] };
    });
    const { code, output } = await run(await makeRepo({ "qwen3-8b": endpoint }), runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain(
      '+     gpu: {"pools":["ADA_24"],"excludedTypes":["NVIDIA L4"],"count":1}',
    );
    const body = writes(runpod)[0]?.body as { gpu: Record<string, unknown> };
    // `types` is resolved before sending; Runpod only knows pools and excludedTypes.
    expect(body.gpu).toStrictEqual({ pools: ["ADA_24"], excludedTypes: ["NVIDIA L4"], count: 1 });
    expect(
      (await run(await makeRepo({ "qwen3-8b": endpoint }), runpod, "--plan")).output,
    ).toContain("1 unchanged");
  });

  test.each([
    [{ types: ["NVIDIA H900"] }, 'unknown GPU type "NVIDIA H900"'],
    [
      { types: ["NVIDIA GeForce RTX 3070"] },
      'GPU type "NVIDIA GeForce RTX 3070" is not offered on Serverless',
    ],
    [{ types: ["NVIDIA L4"], pools: ["ADA_24"] }, "set exactly one of gpu.pools and gpu.types"],
    [
      { types: ["NVIDIA L4"], excludedTypes: ["NVIDIA GeForce RTX 4090"] },
      "gpu.excludedTypes goes with gpu.pools",
    ],
    [{ pools: ["ADA_24"], minCudaVersion: "12" }, 'CUDA versions are "major.minor"'],
  ])("gpu %j is rejected", async (gpu, message) => {
    const runpod = fakeRunpod();
    const endpoint = qwen((e) => {
      e.gpu = gpu as EndpointDef["gpu"];
    });
    const { code, output } = await run(await makeRepo({ "qwen3-8b": endpoint }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(writes(runpod)).toEqual([]);
  });

  test("data centers and network volumes are sent, and the next plan has no changes", async () => {
    const runpod = fakeRunpod([], { volumes: VOLUMES });
    const root = await makeRepo({ "qwen3-8b": placed(() => {}) });
    const { code, output } = await run(root, runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain('+     dataCenterIds: ["EU-RO-1"]');
    expect(output).toContain('+     networkVolumes: ["vol-ro"]');
    expect(writes(runpod)[0]?.body).toMatchObject({
      dataCenterIds: ["EU-RO-1"],
      networkVolumes: ["vol-ro"],
    });
    expect((await run(root, runpod, "--plan")).output).toContain("1 unchanged");
  });

  test.each([
    [
      "an unknown data center",
      placed((e) => {
        e.dataCenters = ["MARS-1"];
        delete e.networkVolumes;
      }),
      'unknown data center "MARS-1" (known: EU-RO-1, US-TX-3)',
    ],
    [
      "a volume that does not exist",
      placed((e) => {
        e.networkVolumes = ["vol-x"];
      }),
      'network volume "vol-x" does not exist (volumes: vol-ro (weights-ro, EU-RO-1)',
    ],
    [
      "a volume outside the data centers",
      placed((e) => {
        e.networkVolumes = ["vol-tx"];
      }),
      'network volume "vol-tx" is in US-TX-3, which is not in dataCenters',
    ],
    [
      "two volumes in one data center",
      placed((e) => {
        e.networkVolumes = ["vol-ro", "vol-ro2"];
      }),
      "two network volumes are in EU-RO-1; use one per data center",
    ],
  ])("%s stops the plan", async (_, endpoint, message) => {
    const runpod = fakeRunpod([], { volumes: VOLUMES });
    const { code, output } = await run(await makeRepo({ "qwen3-8b": endpoint }), runpod, "--plan");
    expect(code).toBe(1);
    expect(output).toContain(message);
  });

  test("without dataCenters, the data centers Runpod reports are left alone", async () => {
    const runpod = fakeRunpod([syncedQwen({ dataCenterIds: ["US-TX-3", "EU-RO-1"] })]);
    const { code, output } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
    expect(code).toBe(0);
    expect(output).toContain("1 unchanged");
  });

  test("changing dataCenters sends only the new list", async () => {
    const runpod = fakeRunpod([syncedQwen({ dataCenterIds: ["US-TX-3"] })]);
    const endpoint = qwen((e) => {
      e.dataCenters = ["EU-RO-1"];
    });
    const { code, output } = await run(await makeRepo({ "qwen3-8b": endpoint }), runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain('!     dataCenterIds: ["US-TX-3"] -> ["EU-RO-1"]');
    expect(writes(runpod)[0]?.body).toEqual({ dataCenterIds: ["EU-RO-1"] });
  });

  test("a key that may not list volumes gets a warning instead of an error", async () => {
    const runpod = fakeRunpod([], { volumes: "forbidden" });
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b": placed(() => {}) }),
      runpod,
      "--plan",
    );
    expect(code).toBe(0);
    expect(output).toContain("cannot list network volumes");
  });

  test("endpoints without placement do not list data centers or volumes", async () => {
    const runpod = fakeRunpod();
    await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--plan");
    const paths = runpod.requests.map((r) => r.path);
    expect(paths).not.toContain("/v2/catalog/datacenters");
    expect(paths).not.toContain("/v2/network-volumes");
  });

  test("a CUDA floor from defaults is set with a gpu PATCH that keeps the pools", async () => {
    const runpod = fakeRunpod([syncedQwen()]);
    const root = await makeRepoWithFiles({
      "loorel.config.ts": `export default { defaults: ${JSON.stringify({ ...DEFAULTS, minCudaVersion: "12.8" })} };\n`,
      "endpoints/qwen3-8b/endpoint.config.ts": endpointFile(QWEN),
    });
    const { code, output } = await run(root, runpod, "--apply");
    expect(code).toBe(0);
    expect(output).toContain('!     gpu.minCudaVersion: (none) -> "12.8"');
    expect(writes(runpod)).toEqual([
      {
        method: "PATCH",
        path: "/v2/serverless/ep-qwen",
        body: { gpu: { minCudaVersion: "12.8" } },
      },
    ]);
    expect(runpod.endpoints[0]?.gpu?.pools).toEqual(["ADA_24"]);
  });

  test("removing the CUDA floor clears it with an empty string", async () => {
    const runpod = fakeRunpod([
      syncedQwen({ gpu: { ...syncedQwen().gpu!, minCudaVersion: "12.8" } }),
    ]);
    const { code } = await run(await makeRepo({ "qwen3-8b": QWEN }), runpod, "--apply");
    expect(code).toBe(0);
    expect(writes(runpod)[0]?.body).toEqual({ gpu: { minCudaVersion: "" } });
  });

  test("endpoint env overrides the model's vllm env", async () => {
    const endpoint = qwen((e) => {
      e.env = { MAX_MODEL_LEN: 4096, TENSOR_PARALLEL_SIZE: 2 };
    });
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b": endpoint }),
      fakeRunpod(),
      "--plan",
    );
    expect(code).toBe(0);
    expect(output).toContain('+     env.MAX_MODEL_LEN: "4096"');
    expect(output).toContain('+     env.TENSOR_PARALLEL_SIZE: "2"');
  });

  test("an env var set in both endpoint env and the model's secrets is rejected", async () => {
    const endpoint = qwen((e) => {
      e.model.secrets = { HF_TOKEN: "hf-token" };
      e.env = { HF_TOKEN: "x" };
    });
    const { code, output } = await run(
      await makeRepo({ "qwen3-8b": endpoint }),
      fakeRunpod(),
      "--plan",
    );
    expect(code).toBe(1);
    expect(output).toContain("HF_TOKEN");
  });
});
