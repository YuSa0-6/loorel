// The decision API (System One): the request format of decision models such as Jev,
// Cloudflare Clef and Perplexity Decider. A state and typed questions go in; a probability
// for every allowed answer comes out. No text is generated.
//
// A Loorel decision endpoint is a Runpod queue endpoint whose worker takes
// { input: <DecisionRequest + model> } on /runsync and returns the DecisionResponse as output.
import { InferenceConfigError } from "./ai.ts";

/** Question text, criteria and options may be plain text or structured data. */
export type Instructions = string | Record<string, unknown> | readonly unknown[];

/** Yes or no. The answer is the probability of yes. */
export interface NoulQuestion {
  type: "noul";
  instructions?: Instructions;
  /** What yes and no mean, when the question alone is not enough. */
  criteria?: { true?: Instructions | null; false?: Instructions | null };
}

/** One option out of a set. The answer has a probability for every option. */
export interface ChoiceQuestion {
  type: "choice";
  instructions?: Instructions;
  /** Option name -> description. null leaves the option undescribed (for example "other"). */
  criteria: Record<string, Instructions | null>;
}

/** A level on an ordered rubric, lowest first. The answer is the expected level. */
export interface ScoreQuestion {
  type: "score";
  instructions?: Instructions;
  criteria: readonly Instructions[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, DecisionQuestion>;

export interface DecisionRequest<Q extends Questions = Questions> {
  /** What every question is about: text, an object or an array. */
  state: string | Record<string, unknown> | readonly unknown[];
  questions: Q;
  /** Base64 PNG, JPEG or WebP, for models that read images. */
  images?: readonly string[];
}

export type DecisionAnswer<Q extends DecisionQuestion> = Q extends { type: "noul" }
  ? { type: "noul"; noul: number }
  : Q extends { type: "choice"; criteria: infer C }
    ? {
        type: "choice";
        /** The most likely option. */
        choice: keyof C & string;
        confidence: number;
        probabilities: Record<keyof C & string, number>;
      }
    : {
        type: "score";
        /** Probability-weighted level index. It can fall between levels. */
        score: number;
        confidence: number;
        legend: Record<string, unknown>;
        probabilities: Record<string, number>;
      };

export interface DecisionResponse<Q extends Questions = Questions> {
  model: string;
  answers: { [K in keyof Q]: DecisionAnswer<Q[K]> };
  usage?: { input_tokens: number; output_tokens: number };
}

export interface LoorelDeciderOptions {
  /** Model name from defineModel. */
  model: string;
  apiKey: string;
  /** Use exactly one of endpointId (direct Runpod) and baseURL (explicit route up to /v2/<id>). */
  endpointId?: string;
  baseURL?: string;
  /** Required only for the authenticated Cloudflare AI Gateway route. */
  gatewayToken?: string;
  /** Time for one decision, queue time included. 1 to 600000 ms, default 120000. */
  timeoutMs?: number;
  /** Wait between status checks when /runsync returns before the job finishes. Default 1000. */
  pollMs?: number;
  fetch?: typeof fetch;
}

export type DecisionErrorCode = "http_error" | "job_failed" | "timeout" | "invalid_response";

export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly httpStatus?: number;
  constructor(message: string, code: DecisionErrorCode, httpStatus?: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// Decision models accept up to 64 questions per request (Jev, Clef).
const MAX_QUESTIONS = 64;
const ID = /^[a-zA-Z0-9_-]+$/;

function resolveBaseURL(options: LoorelDeciderOptions): { base: string; gateway: boolean } {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(options.model)) {
    throw new InferenceConfigError("model must be the lowercase model name");
  }
  if (!options.apiKey || /\s/.test(options.apiKey)) {
    throw new InferenceConfigError("RUNPOD_API_KEY is missing or invalid");
  }
  if (Boolean(options.endpointId) === Boolean(options.baseURL)) {
    throw new InferenceConfigError("set exactly one of endpointId and baseURL");
  }
  if (options.endpointId && !ID.test(options.endpointId)) {
    throw new InferenceConfigError("endpointId is invalid");
  }
  const base = (options.baseURL ?? `https://api.runpod.ai/v2/${options.endpointId}`).replace(
    /\/+$/,
    "",
  );
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new InferenceConfigError("baseURL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new InferenceConfigError("baseURL must be HTTPS without credentials, query or hash");
  }
  const direct = url.hostname === "api.runpod.ai" && /^\/v2\/[a-zA-Z0-9_-]+$/.test(url.pathname);
  const gateway =
    url.hostname === "gateway.ai.cloudflare.com" &&
    /^\/v1\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/custom-runpod\/v2\/[a-zA-Z0-9_-]+$/.test(url.pathname);
  if (url.port || (!direct && !gateway)) {
    throw new InferenceConfigError(
      "baseURL must be a Runpod or custom-runpod Gateway /v2/<id> route",
    );
  }
  if (gateway && (!options.gatewayToken || /\s/.test(options.gatewayToken))) {
    throw new InferenceConfigError("CF_AIG_TOKEN is missing or invalid");
  }
  return { base, gateway };
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Checks that the worker answered every question with the right kind of answer. */
function checkResponse<Q extends Questions>(questions: Q, output: unknown): DecisionResponse<Q> {
  const fail = (why: string) =>
    new DecisionError(
      `the worker returned an invalid decision response: ${why}`,
      "invalid_response",
    );
  if (!isObject(output) || !isObject(output.answers)) throw fail("no answers");
  for (const [name, q] of Object.entries(questions)) {
    const a = output.answers[name];
    if (!isObject(a) || a.type !== q.type) throw fail(`answer ${name} is missing or not ${q.type}`);
    const ok =
      q.type === "noul"
        ? typeof a.noul === "number"
        : q.type === "choice"
          ? typeof a.choice === "string" && a.choice in q.criteria && isObject(a.probabilities)
          : typeof a.score === "number" && isObject(a.probabilities);
    if (!ok) throw fail(`answer ${name} does not match its question`);
  }
  return output as unknown as DecisionResponse<Q>;
}

interface Job {
  id?: string;
  status?: string;
  output?: unknown;
}

/**
 * Creates a function that asks an existing Loorel decision endpoint. The answer types follow
 * the questions: a choice answer is one of that question's option names.
 */
export function createLoorelDecider(options: LoorelDeciderOptions) {
  const { base, gateway } = resolveBaseURL(options);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new InferenceConfigError("timeoutMs must be an integer from 1 to 600000");
  }
  if (!Number.isInteger(pollMs) || pollMs < 0) {
    throw new InferenceConfigError("pollMs must be a non-negative integer");
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
    // Never send a Gateway token to the direct Runpod route.
    ...(gateway ? { "cf-aig-authorization": `Bearer ${options.gatewayToken}` } : {}),
  };

  return async function decide<const Q extends Questions>(
    request: DecisionRequest<Q>,
  ): Promise<DecisionResponse<Q>> {
    const count = Object.keys(request.questions).length;
    if (count < 1 || count > MAX_QUESTIONS) {
      throw new InferenceConfigError(`questions must have 1 to ${MAX_QUESTIONS} entries`);
    }
    const signal = AbortSignal.timeout(timeoutMs);
    const call = async (path: string, body?: unknown): Promise<Job> => {
      let res: Response;
      try {
        // Auth headers must not follow redirects to another destination.
        res = await (options.fetch ?? fetch)(`${base}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new DecisionError(`no answer within ${timeoutMs} ms`, "timeout");
        throw e;
      }
      // The body is not echoed: it can contain the request and the provider's details.
      if (!res.ok)
        throw new DecisionError(`${path} -> HTTP ${res.status}`, "http_error", res.status);
      return (await res.json()) as Job;
    };

    const { images, ...rest } = request;
    let job = await call("/runsync", {
      input: { model: options.model, ...rest, ...(images ? { images } : {}) },
    });
    while ((job.status === "IN_QUEUE" || job.status === "IN_PROGRESS") && job.id) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (signal.aborted) throw new DecisionError(`no answer within ${timeoutMs} ms`, "timeout");
      job = await call(`/status/${encodeURIComponent(job.id)}`);
    }
    if (job.status !== "COMPLETED") {
      throw new DecisionError(`the job ended with status ${job.status ?? "unknown"}`, "job_failed");
    }
    return checkResponse(request.questions, job.output);
  };
}
