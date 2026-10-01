// Syncs models/*.yaml to Runpod Serverless endpoints.
//
//   node infra/runpod/sync.ts --plan [--out plan.md]
//
// Requires RUNPOD_API_KEY (a Read Only key is enough for --plan).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadSpecs } from "./config.ts";
import { type EndpointIds, makePlan, PlanError, renderPlan } from "./plan.ts";
import { createRunpodApi, RunpodError } from "./runpod-api.ts";

export interface SyncOptions {
  argv: string[];
  root: string;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const ENDPOINTS_FILE = "endpoints.json";

/** Returns the process exit code. */
export async function sync({
  argv,
  root,
  env,
  fetch: fetchFn,
  log = console.log,
}: SyncOptions): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (!values.plan) {
    log("usage: sync.ts --plan [--out <file>]");
    return 2;
  }
  const apiKey = env.RUNPOD_API_KEY;
  if (!apiKey) {
    log("error: RUNPOD_API_KEY is not set");
    return 2;
  }

  try {
    const specs = await loadSpecs(root);
    const api = createRunpodApi(apiKey, fetchFn);
    const [remote, gpuTypes, known] = await Promise.all([
      api.listEndpoints(),
      api.listGpuTypes(),
      readEndpointIds(root),
    ]);
    const plan = makePlan(specs, remote, known, gpuTypes);
    const markdown = renderPlan(plan, { prune: false });
    log(markdown);
    if (values.out) await writeFile(path.resolve(root, values.out), markdown);
    return 0;
  } catch (e) {
    if (e instanceof ConfigError || e instanceof PlanError || e instanceof RunpodError) {
      log(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

async function readEndpointIds(root: string): Promise<EndpointIds> {
  try {
    return JSON.parse(await readFile(path.join(root, ENDPOINTS_FILE), "utf8")) as EndpointIds;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  process.exitCode = await sync({ argv: process.argv.slice(2), root, env: process.env });
}
