// Calls a queue endpoint declared with defineEndpoint, checking both sides with its schemas.
import * as v from "valibot";
import type { EndpointDef, EndpointInput, EndpointOutput } from "../infra/runpod/define.ts";

export interface InvokeOptions {
  endpointId: string;
  apiKey: string;
  /** Defaults to https://api.runpod.ai/v2. A Gateway URL ending in /v2 also works. */
  baseURL?: string;
  /** Wait between status checks while the job is queued or running. Default 1000 ms. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export class InvokeError extends Error {}

const Job = v.object({
  id: v.string(),
  status: v.picklist(["IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]),
  output: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
});

/** Runs one job and returns its output, typed and validated by the endpoint's output schema. */
export async function invoke<E extends EndpointDef<any, any>>(
  endpoint: E,
  input: EndpointInput<E>,
  options: InvokeOptions,
): Promise<EndpointOutput<E>> {
  if (endpoint.spec.type !== "QUEUE") {
    throw new InvokeError(`${endpoint.name} is not a queue endpoint`);
  }
  const sent = v.safeParse(endpoint.input, input);
  if (!sent.success) {
    throw new InvokeError(`${endpoint.name}: invalid input: ${v.summarize(sent.issues)}`);
  }

  const fetchFn = options.fetch ?? fetch;
  const base = `${(options.baseURL ?? "https://api.runpod.ai/v2").replace(/\/+$/, "")}/${encodeURIComponent(options.endpointId)}`;
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
  };
  const request = async (url: string, init: RequestInit) => {
    const res = await fetchFn(url, { ...init, headers, signal: options.signal });
    if (!res.ok) throw new InvokeError(`${endpoint.name}: HTTP ${res.status}`);
    const job = v.safeParse(Job, await res.json());
    if (!job.success) throw new InvokeError(`${endpoint.name}: unexpected job response`);
    return job.output;
  };

  let job = await request(`${base}/runsync`, {
    method: "POST",
    body: JSON.stringify({ input: sent.output }),
  });
  while (job.status === "IN_QUEUE" || job.status === "IN_PROGRESS") {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 1000));
    options.signal?.throwIfAborted();
    job = await request(`${base}/status/${encodeURIComponent(job.id)}`, { method: "GET" });
  }
  if (job.status !== "COMPLETED") {
    throw new InvokeError(`${endpoint.name}: job ${job.id} ${job.status}`);
  }

  const received = v.safeParse(endpoint.output, job.output);
  if (!received.success) {
    throw new InvokeError(`${endpoint.name}: invalid output: ${v.summarize(received.issues)}`);
  }
  return received.output;
}
