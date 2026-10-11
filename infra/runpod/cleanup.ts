// A second chance to clean up a run interrupted by GitHub Actions cancellation.
// An ID is eligible only when it was saved by the pipeline and Runpod confirms its name.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bounded } from "../../packages/client/src/abort.ts";
import { createRunpodApi, RunpodError } from "../../packages/define/src/runpod-api.ts";
import { finishResult } from "./artifact.ts";

interface Artifact {
  schemaVersion: number;
  runName?: string;
  endpointId?: string;
  creationUnconfirmed?: boolean;
  cleanup?: { status?: string };
}

export interface CleanupResult {
  schemaVersion: 1;
  ok: boolean;
  status: "no_resource" | "already_verified" | "absent" | "deleted" | "unconfirmed" | "failed";
  runName?: string;
  endpointId?: string;
  error?: { code: string; httpStatus?: number };
}

const RUN_NAME = /^loorel-smoke-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENDPOINT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** Never discovers an endpoint by name or deletes one with a mismatched name. */
// fallow-ignore-next-line complexity
export async function recoverCleanup(
  artifact: unknown,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<CleanupResult> {
  const raw = artifact as Artifact | null;
  const result: CleanupResult = { schemaVersion: 1, ok: false, status: "failed" };
  if (raw?.schemaVersion !== 1 || typeof raw.runName !== "string" || !RUN_NAME.test(raw.runName)) {
    result.error = { code: "invalid_artifact" };
    return result;
  }
  result.runName = raw.runName;
  if (!raw.endpointId) {
    if (raw.creationUnconfirmed) {
      result.status = "unconfirmed";
      result.error = { code: "creation_unconfirmed" };
    } else {
      result.ok = true;
      result.status = "no_resource";
    }
    return result;
  }
  if (
    !ENDPOINT_ID.test(raw.endpointId) ||
    (apiKey.length > 0 && raw.endpointId.includes(apiKey)) ||
    raw.creationUnconfirmed !== false ||
    !["pending", "failed", "succeeded"].includes(raw.cleanup?.status ?? "")
  ) {
    result.error = { code: "invalid_artifact" };
    return result;
  }
  result.endpointId = raw.endpointId;
  if (raw.cleanup?.status === "succeeded") {
    result.ok = true;
    result.status = "already_verified";
    return result;
  }
  if (!apiKey || /\s/.test(apiKey)) {
    result.error = { code: "missing_api_key" };
    return result;
  }

  const apiFor = (signal: AbortSignal) =>
    createRunpodApi(
      apiKey,
      (input, init) => fetchFn(input, { ...init, signal, redirect: "error" }),
      { retryReads: false },
    );
  const get = () => bounded((signal) => apiFor(signal).getEndpoint(raw.endpointId!), 20_000);
  try {
    let endpoint;
    try {
      endpoint = await get();
    } catch (error) {
      if (error instanceof RunpodError && error.status === 404) {
        result.ok = true;
        result.status = "absent";
        return result;
      }
      throw error;
    }
    if (endpoint.name !== raw.runName) {
      result.error = { code: "name_mismatch" };
      return result;
    }
    try {
      await bounded((signal) => apiFor(signal).deleteEndpoint(raw.endpointId!), 20_000);
    } catch (error) {
      if (!(error instanceof RunpodError && error.status === 404)) throw error;
    }
    // fallow-ignore-next-line complexity
    await bounded(async (signal) => {
      for (;;) {
        try {
          const current = await bounded(
            (requestSignal) => apiFor(requestSignal).getEndpoint(raw.endpointId!),
            20_000,
            signal,
          );
          if (current.name !== raw.runName) throw new Error("name_mismatch");
        } catch (error) {
          if (error instanceof RunpodError && error.status === 404) return;
          if (error instanceof Error && error.message === "name_mismatch") throw error;
          if (!(error instanceof RunpodError) || (error.status !== 429 && error.status < 500))
            throw error;
        }
        await delay(1_000, undefined, { signal });
      }
    }, 30_000);
    result.ok = true;
    result.status = "deleted";
  } catch (error) {
    result.error =
      error instanceof RunpodError
        ? { code: "cleanup_http_error", httpStatus: error.status }
        : {
            code:
              error instanceof Error && error.message === "name_mismatch"
                ? "name_mismatch"
                : "cleanup_unavailable",
          };
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result: CleanupResult;
  try {
    const artifact = JSON.parse(await readFile(path.join("artifacts", "e2e.json"), "utf8"));
    result = await recoverCleanup(artifact, process.env.RUNPOD_API_KEY ?? "");
  } catch {
    result = {
      schemaVersion: 1,
      ok: false,
      status: "failed",
      error: { code: "artifact_unavailable" },
    };
  }
  await finishResult("cleanup.json", result);
}
