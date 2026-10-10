import { describe, expect, test } from "vite-plus/test";
import { InferenceConfigError } from "./ai.ts";
import { createLoorelDecider, DecisionError, type LoorelDeciderOptions } from "./decision.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  redirect?: RequestRedirect;
}

/** Answers each request with the next queued response and records what was sent. */
function fakeFetch(...responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      redirect: init?.redirect,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const QUESTIONS = {
  urgent: { type: "noul", instructions: "Is this support request urgent?" },
  team: {
    type: "choice",
    instructions: "Which team should handle this request?",
    criteria: { billing: "Payments and refunds", technical: "Outages and errors", other: null },
  },
  severity: { type: "score", criteria: ["Cosmetic", "Inconvenient", "Unusable"] },
} as const;

const OUTPUT = {
  model: "clef",
  answers: {
    urgent: { type: "noul", noul: 0.97 },
    team: {
      type: "choice",
      choice: "technical",
      confidence: 0.9,
      probabilities: { billing: 0.04, technical: 0.94, other: 0.02 },
    },
    severity: {
      type: "score",
      score: 1.8,
      confidence: 0.8,
      legend: { "0": "Cosmetic", "1": "Inconvenient", "2": "Unusable" },
      probabilities: { "0": 0.01, "1": 0.19, "2": 0.8 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 3 },
};

const BASE: LoorelDeciderOptions = { model: "clef", apiKey: "rp-key", endpointId: "ep-clef" };
const STATE = "Checkout has been failing for every customer for the last hour.";

describe("createLoorelDecider", () => {
  test("sends the request to /runsync and returns typed answers", async () => {
    const { calls, fetch } = fakeFetch({
      body: { id: "job1", status: "COMPLETED", output: OUTPUT },
    });
    const decide = createLoorelDecider({ ...BASE, fetch });
    const result = await decide({ state: STATE, questions: QUESTIONS });

    expect(calls).toEqual([
      {
        url: "https://api.runpod.ai/v2/ep-clef/runsync",
        method: "POST",
        headers: { authorization: "Bearer rp-key", "content-type": "application/json" },
        body: { input: { model: "clef", state: STATE, questions: QUESTIONS } },
        redirect: "error",
      },
    ]);
    expect(result.answers.urgent.noul).toBe(0.97);
    expect(result.answers.severity.score).toBe(1.8);
    // A choice answer is typed as one of that question's option names.
    const team: "billing" | "technical" | "other" = result.answers.team.choice;
    expect(team).toBe("technical");
    // @ts-expect-error "sales" is not an option of the team question.
    expect(result.answers.team.choice === "sales").toBe(false);
    // @ts-expect-error there is no question called "topic".
    expect(result.answers.topic).toBeUndefined();
  });

  test("polls /status until a queued job completes", async () => {
    const { calls, fetch } = fakeFetch(
      { body: { id: "job1", status: "IN_QUEUE" } },
      { body: { id: "job1", status: "IN_PROGRESS" } },
      { body: { id: "job1", status: "COMPLETED", output: OUTPUT } },
    );
    const decide = createLoorelDecider({ ...BASE, fetch, pollMs: 0 });
    const result = await decide({ state: STATE, questions: QUESTIONS });
    expect(result.model).toBe("clef");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.runpod.ai/v2/ep-clef/runsync",
      "GET https://api.runpod.ai/v2/ep-clef/status/job1",
      "GET https://api.runpod.ai/v2/ep-clef/status/job1",
    ]);
  });

  test("keeps polling with the /runsync job ID when a status response has no id", async () => {
    const { calls, fetch } = fakeFetch(
      { body: { id: "job1", status: "IN_QUEUE" } },
      { body: { status: "IN_PROGRESS" } },
      { body: { status: "COMPLETED", output: OUTPUT } },
    );
    const decide = createLoorelDecider({ ...BASE, fetch, pollMs: 0 });
    const result = await decide({ state: STATE, questions: QUESTIONS });
    expect(result.model).toBe("clef");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.runpod.ai/v2/ep-clef/runsync",
      "https://api.runpod.ai/v2/ep-clef/status/job1",
      "https://api.runpod.ai/v2/ep-clef/status/job1",
    ]);
  });

  test("images are sent only when given", async () => {
    const { calls, fetch } = fakeFetch({ body: { id: "j", status: "COMPLETED", output: OUTPUT } });
    await createLoorelDecider({ ...BASE, fetch })({
      state: STATE,
      questions: QUESTIONS,
      images: ["iVBORw0KGgo="],
    });
    expect(calls[0]?.body).toMatchObject({ input: { images: ["iVBORw0KGgo="] } });
  });

  test("the Gateway route sends the Gateway token", async () => {
    const { calls, fetch } = fakeFetch({ body: { id: "j", status: "COMPLETED", output: OUTPUT } });
    const decide = createLoorelDecider({
      model: "clef",
      apiKey: "rp-key",
      baseURL: "https://gateway.ai.cloudflare.com/v1/acct/runpod/custom-runpod/v2/ep-clef",
      gatewayToken: "cf-token",
      fetch,
    });
    await decide({ state: STATE, questions: QUESTIONS });
    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/runpod/custom-runpod/v2/ep-clef/runsync",
    );
    expect(calls[0]?.headers["cf-aig-authorization"]).toBe("Bearer cf-token");
  });

  test.each([
    ["an HTTP error", { status: 401, body: { error: "secret detail" } }, "http_error"],
    ["a failed job", { body: { id: "j", status: "FAILED", error: "boom" } }, "job_failed"],
    [
      "an answer of the wrong type",
      {
        body: {
          id: "j",
          status: "COMPLETED",
          output: {
            ...OUTPUT,
            answers: { ...OUTPUT.answers, urgent: { type: "score", score: 1 } },
          },
        },
      },
      "invalid_response",
    ],
    [
      "a choice that is not an option",
      {
        body: {
          id: "j",
          status: "COMPLETED",
          output: {
            ...OUTPUT,
            answers: { ...OUTPUT.answers, team: { ...OUTPUT.answers.team, choice: "sales" } },
          },
        },
      },
      "invalid_response",
    ],
  ])("%s is a DecisionError", async (_, response, code) => {
    const { fetch } = fakeFetch(response);
    const error = await createLoorelDecider({ ...BASE, fetch })({
      state: STATE,
      questions: QUESTIONS,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).code).toBe(code);
    expect((error as Error).message).not.toContain("secret detail");
  });

  test("a job that never finishes times out", async () => {
    const queued = Array.from({ length: 50 }, () => ({ body: { id: "j", status: "IN_QUEUE" } }));
    const { fetch } = fakeFetch(...queued);
    const decide = createLoorelDecider({ ...BASE, fetch, timeoutMs: 20, pollMs: 5 });
    const error = await decide({ state: STATE, questions: QUESTIONS }).catch((e: unknown) => e);
    expect((error as DecisionError).code).toBe("timeout");
  });

  test.each([
    [{ ...BASE, model: "Clef" }, "model must be the lowercase model name"],
    [{ ...BASE, endpointId: undefined }, "set exactly one of endpointId and baseURL"],
    [{ ...BASE, endpointId: undefined, baseURL: "https://evil.example/v2/x" }, "baseURL must be"],
    [
      {
        ...BASE,
        endpointId: undefined,
        baseURL: "https://gateway.ai.cloudflare.com/v1/a/runpod/custom-runpod/v2/ep",
      },
      "CF_AIG_TOKEN is missing",
    ],
    [{ ...BASE, timeoutMs: 0 }, "timeoutMs must be"],
  ])("invalid options are rejected before any request (%#)", (options, message) => {
    expect(() => createLoorelDecider(options)).toThrow(InferenceConfigError);
    expect(() => createLoorelDecider(options)).toThrow(message);
  });

  test("a request without questions is rejected before any request", async () => {
    const { calls, fetch } = fakeFetch();
    await expect(
      createLoorelDecider({ ...BASE, fetch })({ state: STATE, questions: {} }),
    ).rejects.toThrow("questions must have 1 to 64 entries");
    expect(calls).toEqual([]);
  });
});
