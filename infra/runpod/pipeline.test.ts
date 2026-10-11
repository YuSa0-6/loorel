import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { pipeline, type PipelineResult } from "./pipeline.ts";
import { loadEndpoints } from "../../packages/define/src/config.ts";
import { SMOKE_OUTPUT } from "../../packages/client/src/smoke.ts";
import { fakeRunpod } from "../../packages/define/src/testing/fake-runpod.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = "test-key";
const SECRET = "untrusted-secret-response";
const inputURL = (input: RequestInfo | URL) =>
  input instanceof Request ? input.url : String(input);
const directories: string[] = [];
const completion = (text = SMOKE_OUTPUT) =>
  Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "qwen3-8b",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  });

async function artifact() {
  const directory = await mkdtemp(path.join(tmpdir(), "loorel-pipeline-"));
  directories.push(directory);
  return path.join(directory, "result.json");
}

function transport({
  inference = () => Promise.resolve(completion()),
  control,
}: {
  inference?: typeof fetch;
  control?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined>;
} = {}) {
  const fake = fakeRunpod();
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, init });
    if (url.endsWith("/chat/completions")) return inference(input, init);
    return (await control?.(input, init)) ?? fake.fetch(input, init);
  };
  return { fake, requests, fetch: fetchFn };
}

async function run(
  mock: ReturnType<typeof transport>,
  {
    argv = [],
    signal,
    env = { RUNPOD_API_KEY: KEY },
    out,
  }: {
    argv?: string[];
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    out?: string;
  } = {},
) {
  const file = out ?? (await artifact());
  const lines: string[] = [];
  const code = await pipeline({
    argv: ["--live", "--model", "qwen3-8b", "--out", file, ...argv],
    root: ROOT,
    env,
    fetch: mock.fetch,
    signal,
    log: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
  const result = JSON.parse(lines[0]!) as PipelineResult;
  if (!result.artifactError) expect(await readFile(file, "utf8")).toBe(`${lines[0]}\n`);
  expect(lines[0]).not.toContain(KEY);
  expect(lines[0]).not.toContain(SECRET);
  return { code, result, output: lines[0]!, file };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("ephemeral endpoint pipeline", () => {
  test("creates a one-worker scale-to-zero endpoint, gates zero-worker health, smokes once, deletes", async () => {
    const mock = transport();
    const existing = { ...(await loadEndpoints(ROOT))[0]!.spec, id: "existing-endpoint" };
    mock.fake.endpoints.push(existing);
    const { code, result } = await run(mock);
    expect(code).toBe(0);
    expect(result).toMatchObject({
      ok: true,
      phase: "complete",
      endpointId: "ep1",
      creationUnconfirmed: false,
      health: { status: "endpoint_reachable", attempts: 1 },
      smoke: { ok: true, text: SMOKE_OUTPUT },
      cleanup: { status: "succeeded" },
    });
    expect(mock.fake.endpoints).toEqual([existing]);
    const writes = mock.fake.requests.filter((r) => r.method !== "GET");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      method: "POST",
      body: {
        name: result.runName,
        workers: { min: 0, max: 1, idleTimeout: 5 },
        timeout: 120000,
        env: { OPENAI_SERVED_MODEL_NAME_OVERRIDE: "qwen3-8b" },
      },
    });
    expect(writes[1]).toMatchObject({ method: "DELETE", path: "/v2/serverless/ep1" });
    expect(mock.requests.filter((r) => r.url.endsWith("/chat/completions"))).toHaveLength(1);
    expect(mock.requests.every((r) => r.init?.redirect === "error")).toBe(true);
  });

  test("official health shape without a ready counter is reachable", async () => {
    const { code } = await run(
      transport({
        control: async (input) =>
          inputURL(input).endsWith("/health")
            ? Response.json({ workers: { idle: 0, running: 0 } })
            : undefined,
      }),
    );
    expect(code).toBe(0);
  });

  test("no live opt-in creates a failure artifact and makes zero network requests", async () => {
    const mock = transport();
    const out = await artifact();
    const logs: string[] = [];
    const code = await pipeline({
      argv: ["--out", out],
      root: ROOT,
      env: {},
      fetch: mock.fetch,
      log: (line) => logs.push(line),
    });
    expect(code).toBe(2);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      ok: false,
      error: { code: "live_opt_in_required" },
    });
    expect(await readFile(out, "utf8")).toBe(`${logs[0]}\n`);
    expect(mock.requests).toEqual([]);
  });

  test.each([
    ["--unknown", SECRET],
    ["--health-timeout-ms", "0"],
    ["--inference-timeout-ms", "600001"],
    ["--request-timeout-ms", "60001"],
    ["--poll-ms", "nan"],
    ["--model", "missing-model"],
  ])(
    "invalid arguments %j %j replace a stale success artifact without requests",
    async (...argv) => {
      const mock = transport();
      const out = await artifact();
      await writeFile(out, '{"ok":true}\n');
      const { code, result } = await run(mock, { argv, out });
      expect(code).toBe(2);
      expect(result.ok).toBe(false);
      expect(mock.requests).toEqual([]);
    },
  );

  test("a repeated missing-value --out replaces the earlier requested stale artifact", async () => {
    const mock = transport();
    const out = await artifact();
    await writeFile(out, '{"ok":true}\n');
    const { code, result } = await run(mock, { argv: ["--out"], out });
    expect(code).toBe(2);
    expect(result.ok).toBe(false);
    expect(mock.requests).toEqual([]);
  });

  test("artifact storage is checked before any network request", async () => {
    const mock = transport();
    const out = await artifact();
    await writeFile(out, "not a directory");
    const { code, result } = await run(mock, { out: path.join(out, "result.json") });
    expect(code).toBe(2);
    expect(result).toMatchObject({ ok: false, artifactError: { code: "output_file_error" } });
    expect(mock.requests).toEqual([]);
  });

  test("create rejection is not retried, reports unconfirmed creation and deletes nothing", async () => {
    const mock = transport({
      control: async (_input, init) =>
        init?.method === "POST"
          ? Response.json({ detail: `${KEY} ${SECRET}` }, { status: 503 })
          : undefined,
    });
    const { code, result } = await run(mock);
    expect(code).toBe(1);
    expect(result).toMatchObject({
      phase: "creation",
      creationUnconfirmed: true,
      error: { code: "creation_error", httpStatus: 503 },
      cleanup: { status: "not_needed" },
    });
    expect(mock.requests.filter((r) => r.init?.method === "POST")).toHaveLength(1);
    expect(mock.requests.filter((r) => r.init?.method === "DELETE")).toHaveLength(0);
  });

  test.each([undefined, "bad/id", KEY])(
    "untrustworthy POST id %j is never used for inference or cleanup",
    async (id) => {
      const mock = transport({
        control: async (_input, init) =>
          init?.method === "POST"
            ? Response.json({ id, name: JSON.parse(init.body as string).name, detail: SECRET })
            : undefined,
      });
      const { result } = await run(mock);
      expect(result).toMatchObject({
        creationUnconfirmed: true,
        error: { code: "untrusted_creation_response" },
      });
      expect(result.endpointId).toBeUndefined();
      expect(mock.requests.filter((r) => r.init?.method === "DELETE")).toHaveLength(0);
      expect(mock.requests.filter((r) => r.url.endsWith("/health"))).toHaveLength(0);
    },
  );

  test("a successful POST with a mismatched unique name is not proof of ownership", async () => {
    const mock = transport({
      control: async (_input, init) =>
        init?.method === "POST"
          ? Response.json({ id: "unrelated-new-id", name: SECRET })
          : undefined,
    });
    const { result } = await run(mock);
    expect(result.creationUnconfirmed).toBe(true);
    expect(result.error?.code).toBe("untrusted_creation_response");
    expect(result.endpointId).toBeUndefined();
    expect(mock.requests.filter((r) => r.init?.method === "DELETE")).toHaveLength(0);
  });

  test("a POST response naming an existing ID cannot adopt or delete it", async () => {
    const mock = transport({
      control: async (_input, init) =>
        init?.method === "POST"
          ? Response.json({ id: "existing-endpoint", name: JSON.parse(init.body as string).name })
          : undefined,
    });
    mock.fake.endpoints.push({ ...(await loadEndpoints(ROOT))[0]!.spec, id: "existing-endpoint" });
    const { result } = await run(mock);
    expect(result.error?.code).toBe("untrusted_creation_response");
    expect(mock.fake.endpoints).toHaveLength(1);
    expect(mock.requests.filter((r) => r.init?.method === "DELETE")).toHaveLength(0);
  });

  test("propagation 404/429/503 responses poll, then exactly one smoke runs", async () => {
    const statuses = [404, 429, 503];
    const mock = transport({
      control: async (input) =>
        inputURL(input).endsWith("/health") && statuses.length
          ? Response.json({ detail: SECRET }, { status: statuses.shift()! })
          : undefined,
    });
    const { code, result } = await run(mock, { argv: ["--poll-ms", "1"] });
    expect(code).toBe(0);
    expect(result.health.attempts).toBe(4);
  });

  test.each([401, 403])("health HTTP %i fails immediately but cleans up", async (status) => {
    const mock = transport({
      control: async (input) =>
        inputURL(input).endsWith("/health")
          ? Response.json({ detail: SECRET }, { status })
          : undefined,
    });
    const { code, result } = await run(mock);
    expect(code).toBe(1);
    expect(result.error).toMatchObject({ code: "health_error", httpStatus: status });
    expect(result.health.attempts).toBe(1);
    expect(result.cleanup.status).toBe("succeeded");
    expect(result.smoke).toBeUndefined();
  });

  test.each([
    { workers: { running: -1 } },
    { workers: { running: "0" } },
    { workers: { running: 0, ready: SECRET } },
    { error: SECRET },
  ])("malformed health %j fails safely and cleans up", async (body) => {
    const mock = transport({
      control: async (input) =>
        inputURL(input).endsWith("/health") ? Response.json(body) : undefined,
    });
    const { result } = await run(mock);
    expect(result.error?.code).toBe("invalid_health_response");
    expect(result.cleanup.status).toBe("succeeded");
  });

  test("a health transport ignoring abort is bounded by the total deadline", async () => {
    const mock = transport({
      control: (input) =>
        inputURL(input).endsWith("/health") ? new Promise(() => {}) : Promise.resolve(undefined),
    });
    const { result } = await run(mock, { argv: ["--health-timeout-ms", "25"] });
    expect(result.error?.code).toBe("health_timeout");
    expect(result.cleanup.status).toBe("succeeded");
    expect(result.smoke).toBeUndefined();
  });

  test("inference rejection preserves the smoke artifact and cleans up without retry", async () => {
    const mock = transport({
      inference: async () => Response.json({ error: SECRET }, { status: 503 }),
    });
    const { result } = await run(mock);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "http_error" },
      smoke: { ok: false },
      cleanup: { status: "succeeded" },
    });
    expect(mock.requests.filter((r) => r.url.endsWith("/chat/completions"))).toHaveLength(1);
  });

  test("inference ignoring abort times out and still cleans up", async () => {
    const mock = transport({ inference: () => new Promise(() => {}) });
    const { result } = await run(mock, { argv: ["--inference-timeout-ms", "25"] });
    expect(result.error?.code).toBe("timeout");
    expect(result.cleanup.status).toBe("succeeded");
  });

  test("cancelled inference aborts the SDK but uses a fresh cleanup signal", async () => {
    const controller = new AbortController();
    let inferenceSignal: AbortSignal | null | undefined;
    const mock = transport({
      inference: (_input, init) => {
        inferenceSignal = init?.signal;
        controller.abort();
        return new Promise(() => {});
      },
    });
    const { result } = await run(mock, { signal: controller.signal });
    expect(inferenceSignal?.aborted).toBe(true);
    expect(result.error?.code).toBe("cancelled");
    expect(result.cleanup.status).toBe("succeeded");
    expect(mock.requests.find((r) => r.init?.method === "DELETE")?.init?.signal?.aborted).toBe(
      false,
    );
  });

  test("cleanup failure makes even a successful smoke fail and preserves its ID", async () => {
    const mock = transport({
      control: async (_input, init) =>
        init?.method === "DELETE"
          ? Response.json({ detail: `${KEY} ${SECRET}` }, { status: 500 })
          : undefined,
    });
    const { code, result } = await run(mock);
    expect(code).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      endpointId: "ep1",
      smoke: { ok: true },
      cleanup: { status: "failed", error: { code: "cleanup_error", httpStatus: 500 } },
    });
    expect(mock.fake.endpoints).toHaveLength(1);
    expect(mock.requests.filter((r) => r.init?.method === "DELETE")).toHaveLength(1);
  });

  test.each([400, 401, 403, 422, 429])(
    "definitive create HTTP %i rejection is not an unknown creation",
    async (status) => {
      const mock = transport({
        control: async (_input, init) =>
          init?.method === "POST" ? Response.json({ detail: SECRET }, { status }) : undefined,
      });
      const { result } = await run(mock);
      expect(result.creationUnconfirmed).toBe(false);
      expect(result.cleanup.status).toBe("not_needed");
    },
  );

  test("cancellation during cleanup still deletes but cannot report success", async () => {
    const controller = new AbortController();
    const mock = transport({
      control: async (_input, init) => {
        if (init?.method === "DELETE") controller.abort();
        return undefined;
      },
    });
    const { code, result } = await run(mock, { signal: controller.signal });
    expect(code).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("cancelled");
    expect(result.cleanup.status).toBe("succeeded");
    expect(result.smoke?.ok).toBe(true);
  });

  test("create transport ignoring cancellation is bounded, unknown and never guessed for cleanup", async () => {
    const mock = transport({
      control: (_input, init) =>
        init?.method === "POST" ? new Promise(() => {}) : Promise.resolve(undefined),
    });
    const { result } = await run(mock, { argv: ["--request-timeout-ms", "25"] });
    expect(result.creationUnconfirmed).toBe(true);
    expect(result.endpointId).toBeUndefined();
    expect(result.cleanup.status).toBe("not_needed");
    expect(mock.requests.filter((r) => r.init?.method === "DELETE")).toHaveLength(0);
  });

  test("cancellation during create reports uncertainty, not ownership", async () => {
    const controller = new AbortController();
    const mock = transport({
      control: (_input, init) => {
        if (init?.method === "POST") {
          controller.abort();
          return new Promise(() => {});
        }
        return Promise.resolve(undefined);
      },
    });
    const { result } = await run(mock, { signal: controller.signal });
    expect(result.error?.code).toBe("cancelled");
    expect(result.creationUnconfirmed).toBe(true);
    expect(result.cleanup.status).toBe("not_needed");
  });

  test("cancellation during health cleans up before returning", async () => {
    const controller = new AbortController();
    const mock = transport({
      control: (input) => {
        if (inputURL(input).endsWith("/health")) {
          controller.abort();
          return new Promise(() => {});
        }
        return Promise.resolve(undefined);
      },
    });
    const { result } = await run(mock, { signal: controller.signal });
    expect(result.error?.code).toBe("cancelled");
    expect(result.cleanup.status).toBe("succeeded");
    expect(result.smoke).toBeUndefined();
  });

  test("cleanup 404 counts as already absent", async () => {
    const mock = transport({
      control: async (input, init) =>
        init?.method === "DELETE" ||
        (init?.method === "GET" && inputURL(input).endsWith("/serverless/ep1"))
          ? Response.json({ detail: SECRET }, { status: 404 })
          : undefined,
    });
    expect((await run(mock)).code).toBe(0);
  });

  test("a successful DELETE without confirmed absence fails cleanup", async () => {
    const mock = transport({
      control: async (_input, init) =>
        init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
    });
    const { code, result } = await run(mock, {
      argv: ["--request-timeout-ms", "25", "--poll-ms", "1"],
    });
    expect(code).toBe(1);
    expect(result.cleanup.status).toBe("failed");
    expect(mock.fake.endpoints).toHaveLength(1);
  });

  test("cleanup ignoring abort has its own bounded request budget", async () => {
    const mock = transport({
      control: (_input, init) =>
        init?.method === "DELETE" ? new Promise(() => {}) : Promise.resolve(undefined),
    });
    const { result } = await run(mock, { argv: ["--request-timeout-ms", "25"] });
    expect(result.cleanup.status).toBe("failed");
    expect(result.ok).toBe(false);
  });

  test("a pre-cancelled invocation creates nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = transport();
    const { result } = await run(mock, { signal: controller.signal });
    expect(result.error?.code).toBe("cancelled");
    expect(mock.requests).toEqual([]);
  });
});
