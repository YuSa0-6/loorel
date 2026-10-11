import { describe, expect, test } from "vite-plus/test";
import { assessBudget } from "./budget.ts";

const now = new Date("2026-10-10T00:30:00.000Z");
const billing = (totalAmount: number) =>
  Response.json({
    metadata: {
      query: {
        startTime: "2026-09-30T00:00:00.000Z",
        endTime: "2026-10-11T00:00:00.000Z",
      },
      totals: { totalAmount },
    },
  });

describe("manual E2E budget gate", () => {
  test("checks all-resource monthly billing before allowing a reserved run", async () => {
    const requests: URL[] = [];
    const result = await assessBudget({
      apiKey: "test-key",
      usdJpyRate: "200",
      now,
      fetch: async (input, init) => {
        requests.push(
          new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input),
        );
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return billing(2.49);
      },
    });
    expect(result).toMatchObject({
      ok: true,
      periodStartJst: "2026-10-01",
      queriedFromUtc: "2026-09-30T00:00:00.000Z",
      billedUsd: 2.49,
      billedJpyCeiling: 499,
      reserveJpy: 500,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.origin + requests[0]?.pathname).toBe("https://api.runpod.io/v2/billing");
    expect(requests[0]?.searchParams.get("bucketSize")).toBe("day");
    expect(requests[0]?.searchParams.get("startTime")).toBe("2026-09-30T00:00:00.000Z");
  });

  test("fails closed when existing spend plus the reserve exceeds 1000 yen", async () => {
    const result = await assessBudget({
      apiKey: "test-key",
      usdJpyRate: "200",
      now,
      fetch: async () => billing(2.51),
    });
    expect(result).toMatchObject({
      ok: false,
      billedJpyCeiling: 502,
      error: { code: "monthly_budget_guard" },
    });
  });

  test.each(["", "199", "NaN", "1001", "-1"])(
    "rejects non-conservative exchange rate %j without a request",
    async (usdJpyRate) => {
      let calls = 0;
      const result = await assessBudget({
        apiKey: "test-key",
        usdJpyRate,
        now,
        fetch: async () => {
          calls++;
          return billing(0);
        },
      });
      expect(result.error?.code).toBe("invalid_exchange_rate");
      expect(calls).toBe(0);
    },
  );

  test("missing key makes no request", async () => {
    let calls = 0;
    const result = await assessBudget({
      apiKey: "",
      usdJpyRate: "200",
      now,
      fetch: async () => {
        calls++;
        return billing(0);
      },
    });
    expect(result.error?.code).toBe("missing_api_key");
    expect(calls).toBe(0);
  });

  test("HTTP errors and malformed billing do not permit provisioning or expose bodies", async () => {
    const forbidden = await assessBudget({
      apiKey: "test-key",
      usdJpyRate: "200",
      now,
      fetch: async () => Response.json({ detail: "secret response" }, { status: 403 }),
    });
    expect(forbidden.error).toEqual({ code: "billing_http_error", httpStatus: 403 });
    expect(JSON.stringify(forbidden)).not.toContain("secret response");
    const malformed = await assessBudget({
      apiKey: "test-key",
      usdJpyRate: "200",
      now,
      fetch: async () => Response.json({ metadata: { totals: { totalAmount: 0 } } }),
    });
    expect(malformed.error?.code).toBe("invalid_billing_response");
  });
});
