// One bounded inference request against an existing endpoint. No resource CRUD.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { APICallError, generateText } from "ai";
import { createLoorelModel, InferenceConfigError, type LoorelModelOptions } from "./ai.ts";

export const SMOKE_OUTPUT = "LOOREL_OK";
const DEFAULT_TIMEOUT_MS = 120_000;

interface SmokeFailure {
  code: string;
  message: string;
  httpStatus?: number;
}

export type SmokeResult = {
  schemaVersion: 1;
  ok: boolean;
  model: string;
  elapsedMs: number;
} & (
  | {
      ok: true;
      text: typeof SMOKE_OUTPUT;
      finishReason: "stop";
      usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
      };
    }
  | { ok: false; error: SmokeFailure }
);

/** Uses the real SDK, with an injectable HTTP transport for cost-free tests. */
export async function runInferenceSmoke(
  options: LoorelModelOptions & { timeoutMs?: number },
): Promise<SmokeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new InferenceConfigError("timeoutMs must be an integer from 1 to 600000");
  }
  const model = createLoorelModel(options);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fail = (error: SmokeFailure): SmokeResult => ({
    schemaVersion: 1,
    ok: false,
    model: options.model,
    elapsedMs: Date.now() - started,
    error,
  });

  try {
    const result = await generateText({
      model,
      prompt: `Reply with exactly ${SMOKE_OUTPUT}. Do not explain or add punctuation.\n/no_think`,
      temperature: 0,
      maxOutputTokens: 32,
      // SDK defaults retry some failures. A smoke check must not multiply paid requests.
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    if (!result.text.trim()) {
      return fail({ code: "empty_output", message: "The endpoint returned no text." });
    }
    if (result.finishReason !== "stop") {
      return fail({ code: "incomplete_output", message: "Generation did not finish normally." });
    }
    if (result.text.trim() !== SMOKE_OUTPUT) {
      return fail({ code: "unexpected_output", message: "The output did not match LOOREL_OK." });
    }
    return {
      schemaVersion: 1,
      ok: true,
      model: options.model,
      elapsedMs: Date.now() - started,
      text: SMOKE_OUTPUT,
      finishReason: "stop",
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
        totalTokens: result.usage.totalTokens ?? null,
      },
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return fail({ code: "timeout", message: "Inference exceeded the configured timeout." });
    }
    if (APICallError.isInstance(error) && error.statusCode && error.statusCode >= 400) {
      return fail({
        code: "http_error",
        message: "The endpoint returned an HTTP error.",
        httpStatus: error.statusCode,
      });
    }
    // SDK errors may contain credentials, request bodies or upstream responses.
    // Keep logs machine-readable and omit those untrusted details entirely.
    return fail({ code: "request_error", message: "Inference or response validation failed." });
  } finally {
    clearTimeout(timer);
  }
}

export interface SmokeOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** Exit 0 = verified, 1 = inference/output failure, 2 = configuration/output-file error. */
export async function smoke({ argv, env, fetch: fetchFn, log = console.log }: SmokeOptions) {
  let result: SmokeResult | { schemaVersion: 1; ok: false; error: SmokeFailure };
  let code: number;
  let out: string | undefined;
  const argOptions = {
    model: { type: "string" },
    "endpoint-id": { type: "string" },
    "base-url": { type: "string" },
    "timeout-ms": { type: "string" },
    out: { type: "string" },
  } as const;
  try {
    // Resolve the artifact path even if strict parsing subsequently rejects
    // another argument. A failed invocation must not leave a stale success file.
    const parsedOut = parseArgs({
      args: argv,
      options: argOptions,
      strict: false,
      allowPositionals: true,
    }).values.out;
    out = typeof parsedOut === "string" ? parsedOut : undefined;
    const { values } = parseArgs({
      args: argv,
      options: argOptions,
    });
    out = values.out;
    const timeout = values["timeout-ms"];
    if (timeout !== undefined && !/^[1-9]\d*$/.test(timeout)) {
      throw new InferenceConfigError("--timeout-ms must be a positive integer");
    }
    const explicitRoute = values["endpoint-id"] !== undefined || values["base-url"] !== undefined;
    result = await runInferenceSmoke({
      model: values.model ?? env.LOOREL_MODEL ?? "",
      endpointId: values["endpoint-id"] ?? (explicitRoute ? undefined : env.RUNPOD_ENDPOINT_ID),
      baseURL: values["base-url"] ?? (explicitRoute ? undefined : env.RUNPOD_BASE_URL),
      apiKey: env.RUNPOD_API_KEY ?? "",
      gatewayToken: env.CF_AIG_TOKEN,
      timeoutMs: timeout === undefined ? undefined : Number(timeout),
      fetch: fetchFn,
    });
    code = result.ok ? 0 : 1;
  } catch (error) {
    result = {
      schemaVersion: 1,
      ok: false,
      error: {
        code: "configuration_error",
        message:
          error instanceof InferenceConfigError
            ? error.message
            : "Invalid arguments. Use --model, --endpoint-id or --base-url, --timeout-ms, --out.",
      },
    };
    code = 2;
  }

  const json = JSON.stringify(result);
  if (out !== undefined) {
    try {
      await writeFile(out, `${json}\n`);
    } catch {
      log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "output_file_error" } }));
      return 2;
    }
  }
  log(json);
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await smoke({ argv: process.argv.slice(2), env: process.env });
}
