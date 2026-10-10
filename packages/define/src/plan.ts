// Compares endpoints/*/endpoint.config.ts with the endpoints on Runpod and renders the result.
import { isDeepStrictEqual } from "node:util";
import { type EndpointSpec, SECRET_KEY, SECRET_REF } from "./config.ts";
import type { DataCenter, GpuType, NetworkVolume, RemoteEndpoint } from "./runpod-api.ts";

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export type Action =
  | { kind: "create"; name: string; spec: EndpointSpec }
  | { kind: "update"; name: string; id: string; changes: Change[]; patch: Record<string, unknown> }
  | { kind: "noop"; name: string; id: string }
  // Listed in endpoints.json and still on Runpod, but its directory under endpoints/ was removed.
  | { kind: "orphan"; name: string; id: string };

export interface Plan {
  actions: Action[];
  warnings: string[];
}

/** endpoints.json: endpoint name -> endpoint ID. */
export type EndpointIds = Record<string, { id: string }>;

export class PlanError extends Error {}

/** Runpod secret names referenced from env values, sorted. */
export function referencedSecrets(specs: EndpointSpec[]): string[] {
  const names = specs.flatMap((s) =>
    Object.values(s.env).flatMap((value) => SECRET_REF.exec(value)?.[1] ?? []),
  );
  return [...new Set(names)].sort();
}

/** What the plan checks the specs against. Lists left out are not checked. */
export interface Catalog {
  gpuTypes: GpuType[];
  /** Account secret names, or null when the key may not list them (the plan then warns). */
  secrets?: string[] | null;
  dataCenters?: DataCenter[];
  /** Network volumes, or null when the key may not list them (the plan then warns). */
  volumes?: NetworkVolume[] | null;
}

/** True when any spec picks data centers or network volumes, so the plan needs those lists. */
export const usesPlacement = (specs: EndpointSpec[]) =>
  specs.some((s) => s.dataCenterIds.length > 0 || s.networkVolumes.length > 0);

export function makePlan(
  specs: EndpointSpec[],
  remote: RemoteEndpoint[],
  known: EndpointIds,
  { gpuTypes, secrets = [], dataCenters, volumes }: Catalog,
): Plan {
  const typeErrors: string[] = [];
  specs = specs.map((s) => resolveGpuTypes(s, gpuTypes, typeErrors));
  if (typeErrors.length > 0) throw new PlanError(typeErrors.join("\n"));

  const byName = Map.groupBy(remote, (r) => r.name);
  const errors = [
    ...specs.flatMap((s) => checkGpu(s, gpuTypes)),
    ...checkPlacement(specs, dataCenters, volumes),
    ...checkSecrets(specs, secrets),
    ...specs.flatMap((s) => checkRemote(s, byName.get(s.name) ?? [])),
  ];
  if (errors.length > 0) throw new PlanError(errors.join("\n"));

  const actions = specs.map((spec) => planAction(spec, byName.get(spec.name)?.[0]));
  actions.push(...orphans(specs, remote, known));
  return { actions, warnings: planWarnings(specs, secrets, volumes) };
}

function checkSecrets(specs: EndpointSpec[], secrets: string[] | null): string[] {
  if (!secrets) return [];
  return referencedSecrets(specs)
    .filter((n) => !secrets.includes(n))
    .map(
      (name) =>
        `Runpod secret "${name}" does not exist; create it in the Runpod console (Secrets) first`,
    );
}

/** `same` is every endpoint on Runpod with the spec's name. */
function checkRemote(s: EndpointSpec, same: RemoteEndpoint[]): string[] {
  const errors: string[] = [];
  if (same.length > 1) {
    errors.push(
      `${s.name}: ${same.length} endpoints on Runpod share this name (${same.map((r) => r.id).join(", ")})`,
    );
  }
  const type = same[0]?.type;
  if (type && type !== s.type) {
    errors.push(`${s.name}: type cannot change (${type} -> ${s.type}); delete and recreate it`);
  }
  return errors;
}

function planAction(spec: EndpointSpec, r: RemoteEndpoint | undefined): Action {
  if (!r) return { kind: "create", name: spec.name, spec };
  const { changes, patch } = diff(spec, r);
  return changes.length === 0
    ? { kind: "noop", name: spec.name, id: r.id }
    : { kind: "update", name: spec.name, id: r.id, changes, patch };
}

/** Endpoints in endpoints.json that are still on Runpod but have no directory, by name. */
function orphans(specs: EndpointSpec[], remote: RemoteEndpoint[], known: EndpointIds): Action[] {
  const wanted = new Set(specs.map((s) => s.name));
  return Object.entries(known)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([name, { id }]) => !wanted.has(name) && remote.some((r) => r.id === id))
    .map(([name, { id }]) => ({ kind: "orphan", name, id }));
}

function planWarnings(
  specs: EndpointSpec[],
  secrets: string[] | null,
  volumes: NetworkVolume[] | null | undefined,
): string[] {
  const warnings = specs
    .filter((s) => s.workers.min > 0)
    .map((s) => `${s.name}: workers.min=${s.workers.min} keeps GPUs running and billed while idle`);
  if (secrets === null && referencedSecrets(specs).length > 0) {
    warnings.push("the API key cannot list Runpod secrets, so their existence was not checked");
  }
  if (volumes === null && specs.some((s) => s.networkVolumes.length > 0)) {
    warnings.push("the API key cannot list network volumes, so they were not checked");
  }
  return warnings;
}

/** gpu.types -> the pools that hold them, excluding every other type in those pools. */
function resolveGpuTypes(spec: EndpointSpec, gpuTypes: GpuType[], errors: string[]): EndpointSpec {
  const { types, ...gpu } = spec.gpu;
  if (!types) return spec;
  const byId = new Map(gpuTypes.map((g) => [g.id, g]));
  const pools: string[] = [];
  for (const t of types) {
    const pool = byId.get(t)?.pool;
    if (!byId.has(t)) {
      errors.push(`${spec.name}: unknown GPU type "${t}" (IDs: GET /v2/catalog/gpus)`);
    } else if (!pool) {
      errors.push(`${spec.name}: GPU type "${t}" is not offered on Serverless`);
    } else if (!pools.includes(pool)) {
      pools.push(pool);
    }
  }
  const excludedTypes = gpuTypes
    .filter((g) => g.pool && pools.includes(g.pool) && !types.includes(g.id))
    .map((g) => g.id)
    .sort();
  return { ...spec, gpu: { ...gpu, pools, excludedTypes } };
}

function checkPlacement(
  specs: EndpointSpec[],
  dataCenters: DataCenter[] | undefined,
  volumes: NetworkVolume[] | null | undefined,
): string[] {
  const knownDcs = dataCenters && new Set(dataCenters.map((d) => d.id));
  return specs.flatMap((s) => [
    ...(knownDcs ? checkDataCenters(s, knownDcs) : []),
    ...(volumes ? checkVolumes(s, volumes) : []),
  ]);
}

function checkDataCenters(s: EndpointSpec, known: Set<string>): string[] {
  return s.dataCenterIds
    .filter((dc) => !known.has(dc))
    .map((dc) => `${s.name}: unknown data center "${dc}" (known: ${[...known].sort().join(", ")})`);
}

function checkVolumes(s: EndpointSpec, volumes: NetworkVolume[]): string[] {
  const errors: string[] = [];
  const byId = new Map(volumes.map((v) => [v.id, v]));
  const usedDcs = new Set<string>();
  for (const id of s.networkVolumes) {
    const vol = byId.get(id);
    if (!vol) {
      const list = volumes.map((v) => `${v.id} (${v.name}, ${v.dataCenter})`).join(", ");
      errors.push(`${s.name}: network volume "${id}" does not exist (volumes: ${list || "none"})`);
      continue;
    }
    if (s.dataCenterIds.length > 0 && !s.dataCenterIds.includes(vol.dataCenter)) {
      errors.push(
        `${s.name}: network volume "${id}" is in ${vol.dataCenter}, which is not in dataCenters`,
      );
    }
    if (usedDcs.has(vol.dataCenter)) {
      errors.push(
        `${s.name}: two network volumes are in ${vol.dataCenter}; use one per data center`,
      );
    }
    usedDcs.add(vol.dataCenter);
  }
  return errors;
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

/** Records a change when the values differ, and reports whether they did. */
type Compare = (field: string, from: unknown, to: unknown) => boolean;

function diff(
  spec: EndpointSpec,
  r: RemoteEndpoint,
): { changes: Change[]; patch: Record<string, unknown> } {
  const changes: Change[] = [];
  const patch: Record<string, unknown> = {};
  const compare: Compare = (field, from, to) => {
    if (isDeepStrictEqual(from, to)) return false;
    changes.push({ field, from, to });
    return true;
  };
  const set = (key: string, changed: boolean, value: unknown) => {
    if (changed) patch[key] = value;
  };

  set("image", compare("image", r.image, spec.image), spec.image);
  set("disk", compare("disk", r.disk, spec.disk), spec.disk);
  set("env", diffEnv(spec, r, compare), spec.env);
  const gpu = diffGpu(spec, r, compare);
  if (gpu) patch.gpu = gpu;
  const workerChanges = (["min", "max", "idleTimeout"] as const).map((k) =>
    compare(`workers.${k}`, r.workers?.[k], spec.workers[k]),
  );
  set("workers", workerChanges.some(Boolean), spec.workers);
  const remoteScaling = Object.fromEntries(
    Object.keys(spec.scaling).map((k) => [k, (r.scaling as Record<string, unknown>)?.[k]]),
  );
  set("scaling", compare("scaling", remoteScaling, spec.scaling), spec.scaling);
  set("timeout", compare("timeout", r.timeout, spec.timeout), spec.timeout);
  // Empty means "let Runpod choose"; Runpod may report the data centers it picked, so an
  // empty list is not compared.
  const dcs = sorted(spec.dataCenterIds);
  set(
    "dataCenterIds",
    dcs.length > 0 && compare("dataCenterIds", sorted(r.dataCenterIds), dcs),
    spec.dataCenterIds,
  );
  const vols = sorted(spec.networkVolumes);
  set(
    "networkVolumes",
    compare("networkVolumes", sorted(r.networkVolumes), vols),
    spec.networkVolumes,
  );
  set("flashboot", compare("flashboot", r.flashboot, spec.flashboot), spec.flashboot);

  return { changes, patch };
}

/** PATCH replaces env as a whole, so any key change sends the full map. */
function diffEnv(spec: EndpointSpec, r: RemoteEndpoint, compare: Compare): boolean {
  const remoteEnv = r.env ?? {};
  const keys = [...new Set([...Object.keys(remoteEnv), ...Object.keys(spec.env)])].sort();
  return keys.map((k) => compare(`env.${k}`, remoteEnv[k], spec.env[k])).some(Boolean);
}

/** The gpu part of the PATCH body, or undefined when nothing changed. */
function diffGpu(
  spec: EndpointSpec,
  r: RemoteEndpoint,
  compare: Compare,
): Record<string, unknown> | undefined {
  // pools and excludedTypes are one selection: sending pools alone clears the exclusions.
  const poolsChanged = compare("gpu.pools", sorted(r.gpu?.pools), sorted(spec.gpu.pools));
  const excludedChanged = compare(
    "gpu.excludedTypes",
    sorted(r.gpu?.excludedTypes),
    sorted(spec.gpu.excludedTypes),
  );
  const countChanged = compare("gpu.count", r.gpu?.count ?? 1, spec.gpu.count);
  // Runpod returns null or "" for no floor; PATCH clears it with "".
  const cuda = spec.gpu.minCudaVersion;
  const cudaChanged = compare("gpu.minCudaVersion", r.gpu?.minCudaVersion || undefined, cuda);
  const cudaPatch = cudaChanged ? { minCudaVersion: cuda ?? "" } : {};
  if (poolsChanged || excludedChanged) return { ...spec.gpu, ...cudaPatch };
  if (!countChanged && !cudaChanged) return undefined;
  return { ...(countChanged ? { count: spec.gpu.count } : {}), ...cudaPatch };
}

function show(field: string, value: unknown): string {
  if (value === undefined) return "(none)";
  // A secret reference is a name, not a value, so it is safe to show.
  if (typeof value === "string" && SECRET_REF.test(value)) return JSON.stringify(value);
  if (field.startsWith("env.") && SECRET_KEY.test(field)) return "(hidden)";
  return JSON.stringify(value);
}

/** Plan lines for one field of a new endpoint. */
function renderField(k: string, v: unknown): string[] {
  // Empty lists mean "any data center" and "no volume"; leave them out of the plan.
  if (Array.isArray(v) && v.length === 0) return [];
  if (k !== "env") return [`+     ${k}: ${show(k, v)}`];
  return Object.entries(v as Record<string, string>).map(
    ([ek, ev]) => `+     env.${ek}: ${show(`env.${ek}`, ev)}`,
  );
}

function renderCreate(spec: EndpointSpec): string[] {
  const { name: _, ...fields } = spec;
  return [
    `+ create ${spec.name}`,
    ...Object.entries(fields).flatMap(([k, v]) => renderField(k, v)),
  ];
}

function renderAction(a: Action, prune: boolean): string[] {
  switch (a.kind) {
    case "create":
      return renderCreate(a.spec);
    case "update":
      return [
        `! update ${a.name} (${a.id})`,
        ...a.changes.map(
          (c) => `!     ${c.field}: ${show(c.field, c.from)} -> ${show(c.field, c.to)}`,
        ),
      ];
    case "noop":
      return [`  ${a.name} (${a.id}): no changes`];
    case "orphan":
      return [
        prune
          ? `- delete ${a.name} (${a.id})`
          : `- ${a.name} (${a.id}): endpoints/${a.name}/ removed; not deleted unless apply runs with --prune`,
      ];
  }
}

/** Markdown for the PR comment and the job log. */
export function renderPlan(plan: Plan, { prune }: { prune: boolean }): string {
  const count = (kind: Action["kind"]) => plan.actions.filter((a) => a.kind === kind).length;
  const lines = plan.actions.flatMap((a) => renderAction(a, prune));

  const summary = [
    `${count("create")} to create`,
    `${count("update")} to update`,
    `${count("noop")} unchanged`,
    `${count("orphan")} ${prune ? "to delete" : "without a directory"}`,
  ].join(", ");
  const out = ["### Runpod plan", "", `**${summary}**`, ""];
  if (lines.length > 0) out.push("```diff", ...lines, "```", "");
  for (const w of plan.warnings) out.push(`> [!WARNING]`, `> ${w}`, "");
  return out.join("\n");
}
