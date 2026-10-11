import { describe, expect, test } from "vite-plus/test";
import { recoverCleanup } from "./cleanup.ts";
import { fakeRunpod } from "../../packages/define/src/testing/fake-runpod.ts";

const runName = "loorel-smoke-11111111-2222-4333-8444-555555555555";
const artifact = {
  schemaVersion: 1,
  runName,
  endpointId: "ep1",
  creationUnconfirmed: false,
  cleanup: { status: "pending" },
};
const endpoint = {
  id: "ep1",
  name: runName,
  type: "QUEUE" as const,
  image: "image:tag",
  disk: 50,
  env: {},
  gpu: { pools: ["ADA_24"], count: 1 },
  workers: { min: 0, max: 1 },
  scaling: { type: "QUEUE_DELAY" as const, queueDelay: 4 },
  timeout: 120000,
  flashboot: "OFF" as const,
};

describe("manual E2E recovery cleanup", () => {
  test("deletes only its recorded ID after confirming the name, then verifies absence", async () => {
    const fake = fakeRunpod([endpoint]);
    const result = await recoverCleanup(artifact, "test-key", fake.fetch);
    expect(result).toMatchObject({ ok: true, status: "deleted", endpointId: "ep1" });
    expect(fake.endpoints).toEqual([]);
    expect(fake.requests.map((r) => [r.method, r.path])).toEqual([
      ["GET", "/v2/serverless/ep1"],
      ["DELETE", "/v2/serverless/ep1"],
      ["GET", "/v2/serverless/ep1"],
    ]);
  });

  test("already absent endpoint needs no delete", async () => {
    const fake = fakeRunpod();
    const result = await recoverCleanup(artifact, "test-key", fake.fetch);
    expect(result.status).toBe("absent");
    expect(fake.requests.map((r) => r.method)).toEqual(["GET"]);
  });

  test("name mismatch refuses deletion of an existing resource", async () => {
    const fake = fakeRunpod([{ ...endpoint, name: "someone-else" }]);
    const result = await recoverCleanup(artifact, "test-key", fake.fetch);
    expect(result).toMatchObject({ ok: false, error: { code: "name_mismatch" } });
    expect(fake.endpoints).toHaveLength(1);
    expect(fake.requests.map((r) => r.method)).toEqual(["GET"]);
  });

  test("unknown creation is reported without guessing an ID", async () => {
    const fake = fakeRunpod([endpoint]);
    const result = await recoverCleanup(
      {
        schemaVersion: 1,
        runName,
        creationUnconfirmed: true,
        cleanup: { status: "not_needed" },
      },
      "test-key",
      fake.fetch,
    );
    expect(result).toMatchObject({ ok: false, status: "unconfirmed" });
    expect(fake.requests).toEqual([]);
  });

  test("a successfully verified pipeline artifact performs no network requests", async () => {
    const fake = fakeRunpod();
    const result = await recoverCleanup(
      { ...artifact, cleanup: { status: "succeeded" } },
      "test-key",
      fake.fetch,
    );
    expect(result).toMatchObject({ ok: true, status: "already_verified" });
    expect(fake.requests).toEqual([]);
  });

  test("invalid or secret-shaped IDs cannot select a deletion target", async () => {
    const fake = fakeRunpod([endpoint]);
    const result = await recoverCleanup(
      { ...artifact, endpointId: "../../ep1" },
      "test-key",
      fake.fetch,
    );
    expect(result.error?.code).toBe("invalid_artifact");
    expect(fake.requests).toEqual([]);
  });
});
