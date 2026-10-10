import { describe, expect, test } from "vite-plus/test";
import { createLoorelClient } from "./client.ts";

// The shape of loorel.gen.ts and endpoints.json.
const endpoints = {
  "qwen3-8b": { api: "openai", model: "qwen3-8b" },
  "risk-check": { api: "decision", model: "clef" },
} as const;
const ids = { "qwen3-8b": { id: "ep-qwen" }, "risk-check": { id: "ep-clef" } };

function recordingFetch() {
  const urls: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    urls.push(input instanceof Request ? input.url : input.toString());
    return new Response(
      JSON.stringify({
        id: "j",
        status: "COMPLETED",
        output: { model: "clef", answers: { urgent: { type: "noul", noul: 0.5 } } },
      }),
    );
  };
  return { urls, fetch: fetch as typeof globalThis.fetch };
}

const urgent = { urgent: { type: "noul", instructions: "Urgent?" } } as const;

describe("createLoorelClient", () => {
  test("decider() calls the endpoint ID from endpoints.json with the model from loorel.gen.ts", async () => {
    const { urls, fetch } = recordingFetch();
    const client = createLoorelClient({ endpoints, ids, apiKey: "rp-key", fetch });
    const result = await client.decider("risk-check")({ state: "x", questions: urgent });
    expect(result.answers.urgent.noul).toBe(0.5);
    expect(urls).toEqual(["https://api.runpod.ai/v2/ep-clef/runsync"]);
  });

  test("the gateway option routes through Cloudflare AI Gateway", async () => {
    const { urls, fetch } = recordingFetch();
    const client = createLoorelClient({
      endpoints,
      ids,
      apiKey: "rp-key",
      gateway: { accountId: "acct", gatewayId: "runpod", token: "cf-token" },
      fetch,
    });
    await client.decider("risk-check")({ state: "x", questions: urgent });
    expect(urls).toEqual([
      "https://gateway.ai.cloudflare.com/v1/acct/runpod/custom-runpod/v2/ep-clef/runsync",
    ]);
    expect(client.model("qwen3-8b").modelId).toBe("qwen3-8b");
  });

  test("model() returns an AI SDK model for an OpenAI-compatible endpoint", () => {
    const client = createLoorelClient({ endpoints, ids, apiKey: "rp-key" });
    const model = client.model("qwen3-8b");
    expect(model.modelId).toBe("qwen3-8b");
  });

  test("each call style accepts only endpoints of its API", () => {
    const client = createLoorelClient({ endpoints, ids, apiKey: "rp-key" });
    // @ts-expect-error risk-check serves a decision model, not chat.
    expect(() => client.model("risk-check")).toThrow("risk-check uses the decision API");
    // @ts-expect-error qwen3-8b serves chat, not decisions.
    expect(() => client.decider("qwen3-8b")).toThrow("qwen3-8b uses the openai API");
  });

  test("an endpoint without an ID asks for apply first", () => {
    const client = createLoorelClient({ endpoints, ids: {}, apiKey: "rp-key" });
    expect(() => client.model("qwen3-8b")).toThrow("qwen3-8b has no ID in endpoints.json");
  });
});
