// Fail-closed preflight for the manual, paid E2E workflow. Never prints an API response.
import { fileURLToPath } from "node:url";
import { finishResult } from "./artifact.ts";

const BILLING_URL = "https://api.runpod.io/v2/billing";
const MONTHLY_LIMIT_JPY = 1_000;
const RUN_RESERVE_JPY = 500;

export interface BudgetResult {
  schemaVersion: 1;
  ok: boolean;
  periodStartJst: string;
  queriedFromUtc: string;
  limitJpy: number;
  reserveJpy: number;
  usdJpyRate?: number;
  billedUsd?: number;
  billedJpyCeiling?: number;
  error?: { code: string; httpStatus?: number };
}

export interface BudgetOptions {
  apiKey: string;
  usdJpyRate: string;
  now?: Date;
  fetch?: typeof fetch;
}

class BudgetError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  constructor(code: string, httpStatus?: number) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** The preceding UTC day is included to avoid omitting the first hours of a JST month. */
function period(now: Date) {
  const jst = new Date(now.getTime() + 9 * 60 * 60_000);
  const jstStartUtc = new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - 9 * 60 * 60_000,
  );
  const queryStart = new Date(
    Date.UTC(jstStartUtc.getUTCFullYear(), jstStartUtc.getUTCMonth(), jstStartUtc.getUTCDate()),
  );
  return { jstStartUtc, queryStart };
}

/** Reads aggregate v2 billing and reserves half the monthly budget for this run. */
// fallow-ignore-next-line complexity
export async function assessBudget({
  apiKey,
  usdJpyRate,
  now = new Date(),
  fetch: fetchFn = fetch,
}: BudgetOptions): Promise<BudgetResult> {
  const { jstStartUtc, queryStart } = period(now);
  const result: BudgetResult = {
    schemaVersion: 1,
    ok: false,
    periodStartJst: new Date(jstStartUtc.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10),
    queriedFromUtc: queryStart.toISOString(),
    limitJpy: MONTHLY_LIMIT_JPY,
    reserveJpy: RUN_RESERVE_JPY,
  };
  try {
    if (!apiKey || /\s/.test(apiKey)) throw new BudgetError("missing_api_key");
    if (!/^(?:[1-9]\d{0,2}|1000)(?:\.\d{1,2})?$/.test(usdJpyRate))
      throw new BudgetError("invalid_exchange_rate");
    const rate = Number(usdJpyRate);
    // A deliberately conservative floor. The operator may choose a higher bound.
    if (rate < 200 || rate > 1_000) throw new BudgetError("invalid_exchange_rate");
    result.usdJpyRate = rate;

    const url = new URL(BILLING_URL);
    url.searchParams.set("startTime", queryStart.toISOString());
    url.searchParams.set("endTime", now.toISOString());
    url.searchParams.set("bucketSize", "day");
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) throw new BudgetError("billing_http_error", response.status);
    const billing = (await response.json()) as {
      metadata?: {
        query?: { startTime?: unknown; endTime?: unknown };
        totals?: { totalAmount?: unknown };
      };
    };
    const query = billing?.metadata?.query;
    const amount = billing?.metadata?.totals?.totalAmount;
    const returnedStart = Date.parse(String(query?.startTime));
    const returnedEnd = Date.parse(String(query?.endTime));
    if (
      !Number.isFinite(returnedStart) ||
      returnedStart > queryStart.getTime() ||
      !Number.isFinite(returnedEnd) ||
      returnedEnd < now.getTime() ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0
    )
      throw new BudgetError("invalid_billing_response");
    result.billedUsd = amount;
    result.billedJpyCeiling = Math.ceil(amount * rate);
    if (result.billedJpyCeiling + RUN_RESERVE_JPY > MONTHLY_LIMIT_JPY)
      throw new BudgetError("monthly_budget_guard");
    result.ok = true;
  } catch (error) {
    result.error =
      error instanceof BudgetError
        ? { code: error.code, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) }
        : { code: "billing_unavailable" };
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await assessBudget({
    apiKey: process.env.RUNPOD_API_KEY ?? "",
    usdJpyRate: process.env.USD_JPY_RATE ?? "",
  });
  await finishResult("budget.json", result);
}
