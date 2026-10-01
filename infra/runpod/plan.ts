// Compares models/*.yaml with the endpoints on Runpod and renders the result.
import { isDeepStrictEqual } from "node:util";
import { type EndpointSpec, SECRET_KEY } from "./config.ts";
import type { GpuType, RemoteEndpoint } from "./runpod-api.ts";

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export type Action =
  | { kind: "create"; name: string; spec: EndpointSpec }
  | { kind: "update"; name: string; id: string; changes: Change[]; patch: Record<string, unknown> }
  | { kind: "noop"; name: string; id: string }
  // Listed in endpoints.json and still on Runpod, but its YAML was removed.
  | { kind: "orphan"; name: string; id: string };

export interface Plan {
  actions: Action[];
  warnings: string[];
}

/** endpoints.json: model name -> endpoint ID. */
export type EndpointIds = Record<string, { id: string }>;

export class PlanError extends Error {}

export function makePlan(
  specs: EndpointSpec[],
  remote: RemoteEndpoint[],
  known: EndpointIds,
  gpuTypes: GpuType[],
): Plan {
  const errors = specs.flatMap((s) => checkGpu(s, gpuTypes));
  const byName = Map.groupBy(remote, (r) => r.name);
  for (const s of specs) {
    const same = byName.get(s.name) ?? [];
    if (same.length > 1) {
      errors.push(
        `${s.name}: ${same.length} endpoints on Runpod share this name (${same.map((r) => r.id).join(", ")})`,
      );
    }
    const type = same[0]?.type;
    if (type && type !== s.type) {
      errors.push(`${s.name}: type cannot change (${type} -> ${s.type}); delete and recreate it`);
    }
  }
  if (errors.length > 0) throw new PlanError(errors.join("\n"));

  const actions: Action[] = specs.map((spec) => {
    const r = byName.get(spec.name)?.[0];
    if (!r) return { kind: "create", name: spec.name, spec };
    const { changes, patch } = diff(spec, r);
    return changes.length === 0
      ? { kind: "noop", name: spec.name, id: r.id }
      : { kind: "update", name: spec.name, id: r.id, changes, patch };
  });

  const wanted = new Set(specs.map((s) => s.name));
  for (const [name, { id }] of Object.entries(known).sort(([a], [b]) => a.localeCompare(b))) {
    if (!wanted.has(name) && remote.some((r) => r.id === id))
      actions.push({ kind: "orphan", name, id });
  }

  const warnings = specs
    .filter((s) => s.workers.min > 0)
    .map((s) => `${s.name}: workers.min=${s.workers.min} keeps GPUs running and billed while idle`);
  return { actions, warnings };
}

function checkGpu(spec: EndpointSpec, gpuTypes: GpuType[]): string[] {
  const pools = new Set(gpuTypes.flatMap((g) => (g.pool ? [g.pool] : [])));
  const errors = spec.gpu.pools
    .filter((p) => !pools.has(p))
    .map((p) => `${spec.name}: unknown GPU pool "${p}" (known: ${[...pools].sort().join(", ")})`);
  if (errors.length > 0) return errors;

  const inPools = gpuTypes
    .filter((g) => g.pool && spec.gpu.pools.includes(g.pool))
    .map((g) => g.id);
  for (const t of spec.gpu.excludedTypes) {
    if (!inPools.includes(t))
      errors.push(`${spec.name}: excludedTypes "${t}" is not a GPU type in the selected pools`);
  }
  if (inPools.every((t) => spec.gpu.excludedTypes.includes(t))) {
    errors.push(`${spec.name}: excludedTypes removes every GPU type in the selected pools`);
  }
  return errors;
}

const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort();

function diff(
  spec: EndpointSpec,
  r: RemoteEndpoint,
): { changes: Change[]; patch: Record<string, unknown> } {
  const changes: Change[] = [];
  const patch: Record<string, unknown> = {};
  const compare = (field: string, from: unknown, to: unknown): boolean => {
    if (isDeepStrictEqual(from, to)) return false;
    changes.push({ field, from, to });
    return true;
  };

  if (compare("image", r.image, spec.image)) patch.image = spec.image;
  if (compare("disk", r.disk, spec.disk)) patch.disk = spec.disk;

  // PATCH replaces env as a whole, so any key change sends the full map.
  const remoteEnv = r.env ?? {};
  const keys = [...new Set([...Object.keys(remoteEnv), ...Object.keys(spec.env)])].sort();
  if (keys.map((k) => compare(`env.${k}`, remoteEnv[k], spec.env[k])).some(Boolean))
    patch.env = spec.env;

  // pools and excludedTypes are one selection: sending pools alone clears the exclusions.
  const poolsChanged = compare("gpu.pools", sorted(r.gpu?.pools), sorted(spec.gpu.pools));
  const excludedChanged = compare(
    "gpu.excludedTypes",
    sorted(r.gpu?.excludedTypes),
    sorted(spec.gpu.excludedTypes),
  );
  const countChanged = compare("gpu.count", r.gpu?.count ?? 1, spec.gpu.count);
  if (poolsChanged || excludedChanged) patch.gpu = spec.gpu;
  else if (countChanged) patch.gpu = { count: spec.gpu.count };

  const workerChanges = (["min", "max", "idleTimeout"] as const).map((k) =>
    compare(`workers.${k}`, r.workers?.[k], spec.workers[k]),
  );
  if (workerChanges.some(Boolean)) patch.workers = spec.workers;

  const remoteScaling = Object.fromEntries(
    Object.keys(spec.scaling).map((k) => [k, (r.scaling as Record<string, unknown>)?.[k]]),
  );
  if (compare("scaling", remoteScaling, spec.scaling)) patch.scaling = spec.scaling;
  if (compare("timeout", r.timeout, spec.timeout)) patch.timeout = spec.timeout;
  if (compare("flashboot", r.flashboot, spec.flashboot)) patch.flashboot = spec.flashboot;

  return { changes, patch };
}

function show(field: string, value: unknown): string {
  if (value === undefined) return "(none)";
  if (field.startsWith("env.") && SECRET_KEY.test(field)) return "(hidden)";
  return JSON.stringify(value);
}

/** Markdown for the PR comment and the job log. */
export function renderPlan(plan: Plan, { prune }: { prune: boolean }): string {
  const count = (kind: Action["kind"]) => plan.actions.filter((a) => a.kind === kind).length;
  const lines: string[] = [];
  for (const a of plan.actions) {
    switch (a.kind) {
      case "create": {
        lines.push(`+ create ${a.name}`);
        const { name: _, ...fields } = a.spec;
        for (const [k, v] of Object.entries(fields)) {
          if (k === "env")
            for (const [ek, ev] of Object.entries(v))
              lines.push(`+     env.${ek}: ${show(`env.${ek}`, ev)}`);
          else lines.push(`+     ${k}: ${show(k, v)}`);
        }
        break;
      }
      case "update":
        lines.push(`! update ${a.name} (${a.id})`);
        for (const c of a.changes)
          lines.push(`!     ${c.field}: ${show(c.field, c.from)} -> ${show(c.field, c.to)}`);
        break;
      case "noop":
        lines.push(`  ${a.name} (${a.id}): no changes`);
        break;
      case "orphan":
        lines.push(
          prune
            ? `- delete ${a.name} (${a.id})`
            : `- ${a.name} (${a.id}): YAML removed; not deleted unless apply runs with --prune`,
        );
        break;
    }
  }

  const summary = [
    `${count("create")} to create`,
    `${count("update")} to update`,
    `${count("noop")} unchanged`,
    `${count("orphan")} ${prune ? "to delete" : "without YAML"}`,
  ].join(", ");
  const out = ["### Runpod plan", "", `**${summary}**`, ""];
  if (lines.length > 0) out.push("```diff", ...lines, "```", "");
  for (const w of plan.warnings) out.push(`> [!WARNING]`, `> ${w}`, "");
  return out.join("\n");
}
