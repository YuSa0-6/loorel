import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createLoorelModel, InferenceConfigError } from "../../src/ai.ts";
import { runInferenceSmoke, smoke, SMOKE_OUTPUT } from "./smoke.ts";

const KEY = "test-runpod-secret";
const GATEWAY_TOKEN = "test-gateway-secret";
const GATEWAY =
  "https://gateway.ai.cloudflare.com/v1/account/runpod/custom-runpod/v2/ep-qwen/openai/v1";
const CONFIG = { model: "qwen3-8b", endpointId: "ep-qwen", apiKey: KEY };

function completion(text: string | null = SMOKE_OUTPUT, finishReason = "stop") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: CONFIG.model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  };
}

function transport(response: () => Response = () => Response.json(completion())) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    return Promise.resolve(response());
  };
  return { fetch: fetchFn, requests };
}

async function cli(
  mock: ReturnType<typeof transport>,
  argv = ["--model", CONFIG.model, "--endpoint-id", CONFIG.endpointId],
  env: Record<string, string | undefined> = { RUNPOD_API_KEY: KEY },
) {
  const lines: string[] = [];
  const code = await smoke({ argv, env, fetch: mock.fetch, log: (line) => lines.push(line) });
  expect(lines).toHaveLength(1);
  return { code, json: JSON.parse(lines[0]!) as Record<string, unknown>, output: lines[0]! };
}

afterEach(() => vi.useRealTimers());

describe("Runpod SDK inference smoke", () => {
  test("uses the actual SDK and verifies the served model, path, auth and bounded request", async () => {
    const mock = transport(() => Response.json(completion(`  ${SMOKE_OUTPUT}\n`)));
    const { code, json, output } = await cli(mock);
    expect(code).toBe(0);
    expect(json).toMatchObject({
      schemaVersion: 1,
      ok: true,
      model: CONFIG.model,
      text: SMOKE_OUTPUT,
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.url).toBe("https://api.runpod.ai/v2/ep-qwen/openai/v1/chat/completions");
    expect(request.init?.method).toBe("POST");
    expect(request.init?.redirect).toBe("error");
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.has("cf-aig-authorization")).toBe(false);
    expect(JSON.parse(request.init?.body as string)).toMatchObject({
      model: CONFIG.model,
      temperature: 0,
      max_tokens: 32,
      messages: [{ role: "user", content: expect.stringContaining(SMOKE_OUTPUT) }],
    });
    expect(output).not.toContain(KEY);
  });

  test("supports an explicit Gateway route and keeps both authorization headers separate", async () => {
    const mock = transport();
    const { code, output } = await cli(
      mock,
      ["--model", CONFIG.model, "--base-url", `${GATEWAY}/`],
      {
        RUNPOD_API_KEY: KEY,
        CF_AIG_TOKEN: GATEWAY_TOKEN,
        // An explicit route overrides a previously configured environment route.
        RUNPOD_ENDPOINT_ID: "old-endpoint",
      },
    );
    expect(code).toBe(0);
    expect(mock.requests[0]?.url).toBe(`${GATEWAY}/chat/completions`);
    const headers = new Headers(mock.requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("cf-aig-authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(output).not.toContain(GATEWAY_TOKEN);
  });

  test("supports pipeline environment inputs and omits Gateway auth for direct Runpod", async () => {
    const mock = transport();
    const { code } = await cli(mock, [], {
      LOOREL_MODEL: CONFIG.model,
      RUNPOD_ENDPOINT_ID: CONFIG.endpointId,
      RUNPOD_API_KEY: KEY,
      CF_AIG_TOKEN: GATEWAY_TOKEN,
    });
    expect(code).toBe(0);
    expect(new Headers(mock.requests[0]?.init?.headers).has("cf-aig-authorization")).toBe(false);
  });

  test("an explicit endpoint overrides an environment Gateway route", async () => {
    const mock = transport();
    const { code } = await cli(mock, undefined, { RUNPOD_API_KEY: KEY, RUNPOD_BASE_URL: GATEWAY });
    expect(code).toBe(0);
    expect(mock.requests[0]?.url).toContain("https://api.runpod.ai/v2/ep-qwen/");
  });

  test.each([401, 429, 503])(
    "HTTP %i fails once without retrying or logging upstream data",
    async (status) => {
      const mock = transport(() => Response.json({ error: { message: KEY } }, { status }));
      const { code, json, output } = await cli(mock);
      expect(code).toBe(1);
      expect(json).toMatchObject({ ok: false, error: { code: "http_error", httpStatus: status } });
      expect(mock.requests).toHaveLength(1);
      expect(output).not.toContain(KEY);
    },
  );

  test.each(["", " \n ", null])("empty text %j fails output verification", async (text) => {
    const { code, json } = await cli(transport(() => Response.json(completion(text))));
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false, error: { code: "empty_output" } });
  });

  test("a successful HTTP response with the wrong text still fails", async () => {
    const { code, json, output } = await cli(transport(() => Response.json(completion(KEY))));
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false, error: { code: "unexpected_output" } });
    expect(output).not.toContain(KEY);
  });

  test("truncated generation cannot pass even if its text matches", async () => {
    const { code, json } = await cli(
      transport(() => Response.json(completion(SMOKE_OUTPUT, "length"))),
    );
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false, error: { code: "incomplete_output" } });
  });

  test.each(["not JSON", JSON.stringify({ error: KEY })])(
    "malformed response fails safely: %s",
    async (body) => {
      const mock = transport(
        () => new Response(body, { headers: { "content-type": "application/json" } }),
      );
      const { code, json, output } = await cli(mock);
      expect(code).toBe(1);
      expect(json).toMatchObject({ ok: false, error: { code: "request_error" } });
      expect(output).not.toContain(KEY);
      expect(mock.requests).toHaveLength(1);
    },
  );

  test("network errors never expose the SDK exception message", async () => {
    const result = await runInferenceSmoke({
      ...CONFIG,
      fetch: () => Promise.reject(new Error(`request Authorization: Bearer ${KEY}`)),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "request_error" } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test("redirect responses fail without following another destination", async () => {
    const mock = transport(() => Response.redirect(`https://example.com/${KEY}`, 302));
    const { code, json, output } = await cli(mock);
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.init?.redirect).toBe("error");
    expect(output).not.toContain(KEY);
  });

  test("timeout aborts the one request and returns a machine-readable failure", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = runInferenceSmoke({
      ...CONFIG,
      timeoutMs: 50,
      fetch: (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            {
              once: true,
            },
          );
        });
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ ok: false, elapsedMs: 50, error: { code: "timeout" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("missing usage stays null rather than inventing token counts", async () => {
    const body = { ...completion(), usage: undefined };
    const result = await runInferenceSmoke({
      ...CONFIG,
      fetch: transport(() => Response.json(body)).fetch,
    });
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    });
  });

  test("--out writes the same JSON artifact on success and inference failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loorel-smoke-"));
    try {
      for (const text of [SMOKE_OUTPUT, "incorrect"]) {
        const out = path.join(dir, "smoke.json");
        const result = await cli(
          transport(() => Response.json(completion(text))),
          ["--model", CONFIG.model, "--endpoint-id", CONFIG.endpointId, "--out", out],
        );
        expect(await readFile(out, "utf8")).toBe(`${result.output}\n`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unwritable artifact path fails without exposing the path", async () => {
    const { code, json, output } = await cli(transport(), [
      "--model",
      CONFIG.model,
      "--endpoint-id",
      CONFIG.endpointId,
      "--out",
      `${KEY}/missing/result.json`,
    ]);
    expect(code).toBe(2);
    expect(json).toMatchObject({ ok: false, error: { code: "output_file_error" } });
    expect(output).not.toContain(KEY);
  });

  test("configuration and argument errors overwrite a stale successful artifact", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loorel-smoke-config-"));
    try {
      const out = path.join(dir, "smoke.json");
      for (const extraArgs of [[], ["--unknown", KEY]]) {
        await writeFile(out, JSON.stringify({ schemaVersion: 1, ok: true }));
        const mock = transport();
        const result = await cli(
          mock,
          ["--model", CONFIG.model, "--endpoint-id", CONFIG.endpointId, "--out", out, ...extraArgs],
          {},
        );
        expect(result.code).toBe(2);
        expect(result.json).toMatchObject({ ok: false, error: { code: "configuration_error" } });
        expect(await readFile(out, "utf8")).toBe(`${result.output}\n`);
        expect(mock.requests).toHaveLength(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the Node TypeScript CLI entrypoint returns JSON and process exit 2 for bad config", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./smoke.ts", import.meta.url)),
        "--model",
        CONFIG.model,
        "--endpoint-id",
        CONFIG.endpointId,
      ],
      { env: {}, encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "configuration_error" },
    });
  });
});

describe("inference configuration", () => {
  test.each([
    { model: "" },
    { model: "Qwen/Qwen3-8B" },
    { apiKey: "" },
    { apiKey: `${KEY}\n` },
    { endpointId: undefined },
    { endpointId: "../other" },
    { baseURL: GATEWAY },
    { endpointId: undefined, baseURL: "not a URL" },
    { endpointId: undefined, baseURL: "https://api.runpod.ai/v2/ep-qwen" },
    { endpointId: undefined, baseURL: "http://api.runpod.ai/v2/ep-qwen/openai/v1" },
    { endpointId: undefined, baseURL: "https://example.com/v2/ep-qwen/openai/v1" },
    { endpointId: undefined, baseURL: `https://${KEY}@api.runpod.ai/v2/ep-qwen/openai/v1` },
    { endpointId: undefined, baseURL: `https://api.runpod.ai/v2/ep-qwen/openai/v1?key=${KEY}` },
    { endpointId: undefined, baseURL: GATEWAY },
  ])("rejects invalid model, credentials or destination before any request: %j", (overrides) => {
    const mock = transport();
    expect(() => createLoorelModel({ ...CONFIG, ...overrides, fetch: mock.fetch })).toThrow(
      InferenceConfigError,
    );
    expect(mock.requests).toHaveLength(0);
  });

  test.each([0, -1, 1.5, 600_001, Number.NaN])(
    "rejects invalid timeout %s before calling",
    async (timeoutMs) => {
      const mock = transport();
      await expect(runInferenceSmoke({ ...CONFIG, timeoutMs, fetch: mock.fetch })).rejects.toThrow(
        InferenceConfigError,
      );
      expect(mock.requests).toHaveLength(0);
    },
  );

  test.each([
    { argv: ["--unknown", KEY] },
    { argv: ["--timeout-ms", "1e3"] },
    { argv: ["--timeout-ms", "0"] },
  ])("CLI errors are JSON and omit untrusted arguments: %j", async ({ argv }) => {
    const mock = transport();
    const { code, json, output } = await cli(mock, argv);
    expect(code).toBe(2);
    expect(json).toMatchObject({ ok: false, error: { code: "configuration_error" } });
    expect(output).not.toContain(KEY);
    expect(mock.requests).toHaveLength(0);
  });

  test("missing credentials fail before network access", async () => {
    const mock = transport();
    const { code, json } = await cli(mock, undefined, {});
    expect(code).toBe(2);
    expect(json).toMatchObject({ ok: false, error: { code: "configuration_error" } });
    expect(mock.requests).toHaveLength(0);
  });
});
