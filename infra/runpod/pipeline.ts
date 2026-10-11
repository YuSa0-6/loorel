// Ephemeral create -> health reachability -> one SDK smoke -> cleanup.
// Never applies persistent config, adopts an existing endpoint, or updates endpoints.json.
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bounded } from "../../packages/client/src/abort.ts";
import { loadEndpoints } from "../../packages/define/src/config.ts";
import {
  createRunpodApi,
  type RunpodApi,
  RunpodError,
} from "../../packages/define/src/runpod-api.ts";
import { runInferenceSmoke, type SmokeResult } from "../../packages/client/src/smoke.ts";

interface Failure {
  code: string;
  httpStatus?: number;
}

export interface PipelineResult {
  schemaVersion: 1;
  ok: boolean;
  runName: string;
  model?: string;
  endpointId?: string;
  phase: "configuration" | "preflight" | "creation" | "health" | "inference" | "complete";
  elapsedMs: number;
  /** A POST may have succeeded server-side without a trustworthy response ID. */
  creationUnconfirmed: boolean;
  health: { status: "not_checked" | "endpoint_reachable"; attempts: number };
  smoke?: SmokeResult;
  cleanup: { status: "not_needed" | "pending" | "succeeded" | "failed"; error?: Failure };
  error?: Failure;
  artifactError?: { code: "output_file_error" };
}

export interface PipelineOptions {
  argv: string[];
  root: string;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

class PipelineError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const argOptions = {
  live: { type: "boolean", default: false },
  model: { type: "string" },
  out: { type: "string" },
  "health-timeout-ms": { type: "string" },
  "inference-timeout-ms": { type: "string" },
  "request-timeout-ms": { type: "string" },
  "poll-ms": { type: "string" },
} as const;

function milliseconds(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum)
    throw new PipelineError("configuration_error");
  return Number(value);
}

function failure(error: unknown, fallback: string): Failure {
  if (error instanceof PipelineError) return { code: error.code };
  return {
    code: fallback,
    ...(error instanceof RunpodError ? { httpStatus: error.status } : {}),
  };
}

async function deleteOrAlreadyGone(api: ReturnType<typeof createRunpodApi>, id: string) {
  try {
    await api.deleteEndpoint(id);
  } catch (error) {
    if (!(error instanceof RunpodError && error.status === 404)) throw error;
  }
}

type ApiFor = (signal: AbortSignal) => RunpodApi;

async function waitForHealth(
  id: string,
  result: PipelineResult,
  apiFor: ApiFor,
  requestTimeoutMs: number,
  healthTimeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
) {
  await bounded(
    async (healthSignal) => {
      for (;;) {
        result.health.attempts++;
        try {
          const health = await bounded(
            (s) => apiFor(s).getEndpointHealth(id),
            requestTimeoutMs,
            healthSignal,
          );
          if (
            !Number.isSafeInteger(health?.workers?.running) ||
            health.workers.running < 0 ||
            (health.workers.ready !== undefined &&
              (!Number.isSafeInteger(health.workers.ready) || health.workers.ready < 0))
          ) {
            throw new PipelineError("invalid_health_response");
          }
          result.health.status = "endpoint_reachable";
          return;
        } catch (error) {
          healthSignal.throwIfAborted();
          if (
            error instanceof PipelineError ||
            (error instanceof RunpodError &&
              error.status !== 404 &&
              error.status !== 429 &&
              error.status < 500)
          ) {
            throw error;
          }
        }
        await delay(pollMs, undefined, { signal: healthSignal });
      }
    },
    healthTimeoutMs,
    signal,
  ).catch((error: unknown) => {
    if (signal?.aborted) throw new PipelineError("cancelled");
    if (error instanceof DOMException && error.name === "AbortError")
      throw new PipelineError("health_timeout");
    throw error;
  });
}

async function cleanupOwnedEndpoint(
  id: string,
  apiFor: ApiFor,
  requestTimeoutMs: number,
  pollMs: number,
): Promise<PipelineResult["cleanup"]> {
  try {
    await bounded((s) => deleteOrAlreadyGone(apiFor(s), id), requestTimeoutMs);
    // A successful DELETE is only an acknowledgement. Confirm the resource is gone.
    await bounded(async (verificationSignal) => {
      for (;;) {
        try {
          await bounded((s) => apiFor(s).getEndpoint(id), requestTimeoutMs, verificationSignal);
        } catch (error) {
          if (error instanceof RunpodError && error.status === 404) return;
          if (!(error instanceof RunpodError) || (error.status !== 429 && error.status < 500))
            throw error;
        }
        await delay(pollMs, undefined, { signal: verificationSignal });
      }
    }, requestTimeoutMs);
    return { status: "succeeded" };
  } catch (error) {
    return { status: "failed", error: failure(error, "cleanup_error") };
  }
}

/** Exit 0 = smoke and cleanup passed; 1 = lifecycle failure; 2 = config/artifact failure. */
// fallow-ignore-next-line complexity
export async function pipeline({
  argv,
  root,
  env,
  fetch: fetchFn = fetch,
  signal,
  log = console.log,
}: PipelineOptions): Promise<number> {
  const started = Date.now();
  const runName = `loorel-smoke-${randomUUID()}`;
  let out = path.join(root, "artifacts", `${runName}.json`);
  let ownedId: string | undefined;
  let createDispatched = false;
  let requestTimeoutMs = 30_000;
  let pollMs = 2_000;
  let apiKey = "";
  const result: PipelineResult = {
    schemaVersion: 1,
    ok: false,
    runName,
    phase: "configuration",
    elapsedMs: 0,
    creationUnconfirmed: false,
    health: { status: "not_checked", attempts: 0 },
    cleanup: { status: "not_needed" },
  };
  const persist = async () => {
    result.elapsedMs = Date.now() - started;
    try {
      await mkdir(path.dirname(out), { recursive: true });
      const temporary = `${out}.${runName}.tmp`;
      await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
      await rename(temporary, out);
    } catch {
      result.artifactError = { code: "output_file_error" };
      throw new PipelineError("output_file_error");
    }
  };
  const apiFor = (operationSignal: AbortSignal) =>
    createRunpodApi(
      apiKey,
      (input, init) => {
        operationSignal.throwIfAborted();
        if (init?.method === "POST") {
          createDispatched = true;
          result.creationUnconfirmed = true;
        }
        return fetchFn(input, { ...init, signal: operationSignal, redirect: "error" });
      },
      { retryReads: false },
    );

  try {
    // Preserve the last usable output path even if a repeated --out has no value.
    // parseArgs(strict:false) otherwise replaces it with boolean true, leaving stale success.
    for (let index = 0; index < argv.length && argv[index] !== "--"; index++) {
      const argument = argv[index]!;
      const candidate = argument.startsWith("--out=")
        ? argument.slice(6)
        : argument === "--out" && !argv[index + 1]?.startsWith("-")
          ? argv[index + 1]
          : undefined;
      if (candidate) out = path.resolve(root, candidate);
    }
    const { values } = parseArgs({ args: argv, options: argOptions });
    await persist(); // Verify artifact storage before any network request or resource creation.
    if (!values.live) throw new PipelineError("live_opt_in_required");
    apiKey = env.RUNPOD_API_KEY ?? "";
    if (!apiKey || /\s/.test(apiKey)) throw new PipelineError("configuration_error");
    const model = values.model ?? "";
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(model))
      throw new PipelineError("configuration_error");
    result.model = model;
    requestTimeoutMs = milliseconds(values["request-timeout-ms"], 30_000, 60_000);
    const healthTimeoutMs = milliseconds(values["health-timeout-ms"], 120_000, 600_000);
    const inferenceTimeoutMs = milliseconds(values["inference-timeout-ms"], 120_000, 600_000);
    pollMs = milliseconds(values["poll-ms"], 2_000, 30_000);
    const endpoint = (await loadEndpoints(root)).find((e) => e.name === model);
    const spec = endpoint?.spec;
    if (
      !spec ||
      endpoint.api !== "openai" ||
      spec.type !== "QUEUE" ||
      spec.gpu.count !== 1 ||
      spec.gpu.pools.length === 0 ||
      spec.gpu.types !== undefined
    )
      throw new PipelineError("configuration_error");

    result.phase = "preflight";
    await persist();
    const existing = await bounded((s) => apiFor(s).listEndpoints(), requestTimeoutMs, signal);
    const existingIds = new Set(existing.map((e) => e.id));
    if (existing.some((e) => e.name === runName)) throw new PipelineError("run_name_conflict");

    result.phase = "creation";
    // Persist a conservative in-flight marker before dispatch, so a hard kill cannot
    // leave an apparently safe checkpoint. Terminal failures refine it below.
    result.creationUnconfirmed = true;
    await persist();
    const created = await bounded(
      (s) =>
        apiFor(s).createEndpoint({
          ...spec,
          name: runName,
          workers: {
            min: 0,
            max: 1,
            ...(spec.workers.idleTimeout === undefined ? {} : { idleTimeout: 5 }),
          },
          timeout: Math.min(spec.timeout, inferenceTimeoutMs),
        }),
      requestTimeoutMs,
      signal,
    );
    // Only the successful POST's new ID is eligible for cleanup. No adoption by name.
    if (
      typeof created?.id !== "string" ||
      created.name !== runName ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(created.id) ||
      created.id.includes(apiKey) ||
      existingIds.has(created.id)
    ) {
      throw new PipelineError("untrusted_creation_response");
    }
    ownedId = created.id;
    result.endpointId = ownedId;
    result.creationUnconfirmed = false;
    result.cleanup.status = "pending";
    await persist();

    result.phase = "health";
    await waitForHealth(ownedId, result, apiFor, requestTimeoutMs, healthTimeoutMs, pollMs, signal);
    await persist();

    result.phase = "inference";
    await persist();
    result.smoke = await runInferenceSmoke({
      model: endpoint.model,
      endpointId: ownedId,
      apiKey,
      timeoutMs: inferenceTimeoutMs,
      signal,
      fetch: fetchFn,
    });
    if (!result.smoke.ok) throw new PipelineError(result.smoke.error.code);
    result.phase = "complete";
  } catch (error) {
    if (
      result.phase === "creation" &&
      (!createDispatched ||
        (error instanceof RunpodError &&
          [400, 401, 403, 404, 405, 422, 429].includes(error.status)))
    ) {
      result.creationUnconfirmed = false;
    }
    result.error = signal?.aborted
      ? { code: "cancelled" }
      : failure(error, `${result.phase}_error`);
  } finally {
    // Cleanup has its own finite budget and is deliberately independent of cancellation.
    if (ownedId) {
      result.cleanup = await cleanupOwnedEndpoint(ownedId, apiFor, requestTimeoutMs, pollMs);
    }
    if (signal?.aborted && !result.error) result.error = { code: "cancelled" };
    result.ok = !result.error && result.smoke?.ok === true && result.cleanup.status === "succeeded";
    try {
      await persist();
    } catch {
      result.ok = false;
    }
    // Only allowlisted fields and fixed failure codes are logged, never raw errors/bodies/specs.
    log(JSON.stringify(result));
  }
  if (result.artifactError || result.phase === "configuration") return 2;
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    process.exitCode = await pipeline({
      argv: process.argv.slice(2),
      root,
      env: process.env,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
