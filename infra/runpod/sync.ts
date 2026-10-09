// Syncs the endpoints in loorel.config.ts to Runpod Serverless.
//
//   node infra/runpod/sync.ts --plan  [--out plan.md]
//   node infra/runpod/sync.ts --apply [--prune] [--out apply.md]
//
// Requires RUNPOD_API_KEY (a Read Only key is enough for --plan).
// --apply writes endpoints.json: endpoint name -> endpoint ID.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadSpecs } from "./config.ts";
import {
  type EndpointIds,
  makePlan,
  type Plan,
  PlanError,
  referencedSecrets,
  renderPlan,
} from "./plan.ts";
import { createRunpodApi, type RunpodApi, RunpodError } from "./runpod-api.ts";

export interface SyncOptions {
  argv: string[];
  root: string;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const ENDPOINTS_FILE = "endpoints.json";
const USAGE = "usage: sync.ts --plan [--out <file>] | --apply [--prune] [--out <file>]";

const parseCli = (args: string[]) =>
  parseArgs({
    args,
    options: {
      plan: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      prune: { type: "boolean", default: false },
      out: { type: "string" },
    },
  }).values;

/** Returns the process exit code. */
export async function sync({
  argv,
  root,
  env,
  fetch: fetchFn,
  log = console.log,
}: SyncOptions): Promise<number> {
  let values: ReturnType<typeof parseCli>;
  try {
    values = parseCli(argv);
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    log(USAGE);
    return 2;
  }
  if (values.plan === values.apply || (values.prune && !values.apply)) {
    log(USAGE);
    return 2;
  }
  const apiKey = env.RUNPOD_API_KEY;
  if (!apiKey) {
    log("error: RUNPOD_API_KEY is not set");
    return 2;
  }

  const out: string[] = [];
  const emit = (text: string) => {
    log(text);
    out.push(text);
  };
  const save = async () => {
    if (values.out) await writeFile(path.resolve(root, values.out), out.join("\n"));
  };

  try {
    const specs = await loadSpecs(root);
    const api = createRunpodApi(apiKey, fetchFn);
    const [remote, gpuTypes, known, secrets] = await Promise.all([
      api.listEndpoints(),
      api.listGpuTypes(),
      readEndpointIds(root),
      referencedSecrets(specs).length > 0 ? listSecretNames(api) : [],
    ]);
    const plan = makePlan(specs, remote, known, gpuTypes, secrets);
    emit(renderPlan(plan, { prune: values.prune }));
    if (values.plan) {
      await save();
      return 0;
    }

    const live = new Set(remote.map((r) => r.id));
    const result = await apply(plan, api, values.prune);
    // Keep IDs of orphans that still exist so a later --prune can find them.
    const ids: EndpointIds = Object.fromEntries(
      Object.entries(known).filter(([, { id }]) => live.has(id) && !result.deleted.has(id)),
    );
    for (const [name, id] of result.applied) ids[name] = { id };
    await writeEndpointIds(root, ids);

    emit(["### Runpod apply", "", ...result.lines.map((l) => `- ${l}`), ""].join("\n"));
    await save();
    return result.failed ? 1 : 0;
  } catch (e) {
    if (e instanceof ConfigError || e instanceof PlanError || e instanceof RunpodError) {
      emit(`error: ${e.message}`);
      await save();
      return 1;
    }
    throw e;
  }
}

interface ApplyResult {
  /** endpoint name -> endpoint ID for every endpoint that exists on Runpod now. */
  applied: Map<string, string>;
  deleted: Set<string>;
  lines: string[];
  failed: boolean;
}

/** Runs the plan one action at a time and stops at the first error. */
async function apply(plan: Plan, api: RunpodApi, prune: boolean): Promise<ApplyResult> {
  const result: ApplyResult = { applied: new Map(), deleted: new Set(), lines: [], failed: false };
  for (const a of plan.actions) {
    if (result.failed) {
      // Endpoints that already exist keep their IDs; nothing else is sent to Runpod.
      if (a.kind === "update" || a.kind === "noop") result.applied.set(a.name, a.id);
      if (a.kind !== "noop" && (a.kind !== "orphan" || prune))
        result.lines.push(`${a.name}: skipped`);
      continue;
    }
    try {
      switch (a.kind) {
        case "create": {
          const { id } = await api.createEndpoint(a.spec);
          result.applied.set(a.name, id);
          result.lines.push(`${a.name}: created (${id})`);
          break;
        }
        case "update":
          await api.updateEndpoint(a.id, a.patch);
          result.applied.set(a.name, a.id);
          result.lines.push(`${a.name}: updated (${a.id})`);
          break;
        case "noop":
          result.applied.set(a.name, a.id);
          break;
        case "orphan":
          if (!prune) break;
          await api.deleteEndpoint(a.id);
          result.deleted.add(a.id);
          result.lines.push(`${a.name}: deleted (${a.id})`);
          break;
      }
    } catch (e) {
      if (!(e instanceof RunpodError)) throw e;
      result.failed = true;
      // An update that failed leaves the endpoint in place, so its ID stays recorded.
      if (a.kind === "update") result.applied.set(a.name, a.id);
      result.lines.push(`${a.name}: failed: ${e.message}`);
    }
  }
  if (result.lines.length === 0) result.lines.push("nothing to change");
  return result;
}

/** null when the key is not allowed to list secrets. */
async function listSecretNames(api: RunpodApi): Promise<string[] | null> {
  try {
    return (await api.listSecrets()).map((s) => s.name);
  } catch (e) {
    if (e instanceof RunpodError && e.status === 403) return null;
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

async function writeEndpointIds(root: string, ids: EndpointIds): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(ids).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path.join(root, ENDPOINTS_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  process.exitCode = await sync({ argv: process.argv.slice(2), root, env: process.env });
}
