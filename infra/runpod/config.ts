// Loads loorel.config.ts (models and endpoints written in TypeScript) into endpoint specs.
// The types in define.ts guide the editor; the schemas here check the same values at runtime,
// including the rules that types cannot express.
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import type { FlashBoot, Scaling } from "./define.ts";

export type { FlashBoot, Scaling };

/** The managed part of a Runpod endpoint, in REST API v2 field names. */
export interface EndpointSpec {
  name: string;
  type: "QUEUE" | "LOAD_BALANCER";
  image: string;
  disk: number;
  env: Record<string, string>;
  gpu: { pools: string[]; excludedTypes: string[]; count: number };
  workers: { min: number; max: number; idleTimeout?: number };
  scaling: Scaling;
  timeout: number;
  flashboot: FlashBoot;
}

export const CONFIG_FILE = "loorel.config.ts";

// Keys that look like credentials. Their values would show up in PR comments.
export const SECRET_KEY = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i;
// An env value that Runpod replaces with an account secret when a worker boots.
// The value itself never passes through this repository.
export const SECRET_REF = /^\{\{ RUNPOD_SECRET_(.+) \}\}$/;
export const secretRef = (name: string) => `{{ RUNPOD_SECRET_${name} }}`;
// Set by sync from the model, so they cannot be written by hand.
const SERVED_NAME_KEY = "OPENAI_SERVED_MODEL_NAME_OVERRIDE";
const SOURCE_KEY = "MODEL_NAME";
const RESERVED = {
  [SERVED_NAME_KEY]: `${SERVED_NAME_KEY} is set from the model name`,
  [SOURCE_KEY]: `${SOURCE_KEY} is set from the model source`,
} as Record<string, string>;

const EnvName = v.pipe(
  v.string(),
  v.regex(/^[A-Z_][A-Z0-9_]*$/, "env var names are UPPER_SNAKE_CASE"),
  v.check(
    (k) => !(k in RESERVED),
    (i) => RESERVED[i.input as string] ?? "",
  ),
);
const EnvKey = v.pipe(
  EnvName,
  v.check(
    (k) => !SECRET_KEY.test(k),
    "secret values must not be written in the config; reference a Runpod secret under secrets",
  ),
);
const Env = v.pipe(
  v.record(
    EnvKey,
    v.optional(
      v.pipe(
        v.union([v.string(), v.number(), v.boolean()]),
        v.transform((x) => String(x)),
      ),
    ),
  ),
  // `{ KEY: undefined }` is allowed by the type and means the key is not set.
  v.transform(
    (env) =>
      Object.fromEntries(Object.entries(env).filter(([, x]) => x !== undefined)) as Record<
        string,
        string
      >,
  ),
);
const PositiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));
const Name = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "names are lowercase a-z, 0-9 and -"),
);
const FlashBootSchema = v.picklist(["OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"]);
const IdleTimeout = v.pipe(PositiveInt, v.maxValue(3600));
const ScalingSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("QUEUE_DELAY"),
    queueDelay: v.pipe(v.number(), v.minValue(0.5)),
  }),
  v.strictObject({ type: v.literal("REQUEST_COUNT"), requestCount: PositiveInt }),
]);

// env var name -> Runpod secret name. Names follow POST /v2/account/secrets.
const Secrets = v.record(
  EnvName,
  v.pipe(
    v.string(),
    v.regex(/^[a-zA-Z_][a-zA-Z0-9_.\-/]*$/, "Runpod secret names use letters, digits and _.-/"),
    v.maxLength(191),
    v.check((n) => !/^RUNPOD/i.test(n), "the RUNPOD prefix is reserved by Runpod"),
  ),
);

const Defaults = v.strictObject({
  image: v.pipe(v.string(), v.regex(/:[\w.-]+$/, "image must have an explicit tag")),
  type: v.picklist(["QUEUE", "LOAD_BALANCER"]),
  disk: PositiveInt,
  flashboot: FlashBootSchema,
  timeout: PositiveInt,
  idleTimeout: IdleTimeout,
  scaling: ScalingSchema,
  env: v.optional(Env, {}),
});

const Model = v.pipe(
  v.strictObject({
    name: Name,
    source: v.pipe(v.string(), v.nonEmpty("source is required")),
    vllm: v.optional(Env, {}),
    secrets: v.optional(Secrets, {}),
  }),
  v.check(
    (m) => Object.keys(m.secrets).every((k) => !(k in m.vllm)),
    "an env var is set in both vllm and secrets",
  ),
);

const Endpoint = v.pipe(
  v.strictObject({
    name: v.optional(Name),
    model: Model,
    gpu: v.strictObject({
      pools: v.pipe(v.array(v.string()), v.minLength(1)),
      excludedTypes: v.optional(v.array(v.string()), []),
      count: v.optional(PositiveInt, 1),
    }),
    workers: v.strictObject({
      min: v.pipe(v.number(), v.integer(), v.minValue(0)),
      max: PositiveInt,
    }),
    disk: v.optional(PositiveInt),
    flashboot: v.optional(FlashBootSchema),
    timeout: v.optional(PositiveInt),
    idleTimeout: v.optional(IdleTimeout),
    scaling: v.optional(ScalingSchema),
  }),
  v.check((e) => e.workers.min <= e.workers.max, "workers.min must be <= workers.max"),
);

const Config = v.strictObject({
  defaults: Defaults,
  endpoints: v.array(Endpoint),
});

export class ConfigError extends Error {}

/** "endpoints.0.model.vllm.X" -> "endpoints[0] (qwen3-8b) model.vllm.X" */
function where(issue: v.BaseIssue<unknown>, raw: unknown): string {
  const keys = (issue.path ?? []).map((p) => p.key as string | number);
  if (keys.length === 0) return "(root)";
  if (keys[0] === "endpoints" && typeof keys[1] === "number") {
    const e = (raw as { endpoints?: { name?: unknown; model?: { name?: unknown } }[] }).endpoints?.[
      keys[1]
    ];
    const name = e?.name ?? e?.model?.name;
    const label = `endpoints[${keys[1]}]${typeof name === "string" ? ` (${name})` : ""}`;
    return keys.length > 2 ? `${label} ${keys.slice(2).join(".")}` : label;
  }
  return keys.join(".");
}

async function importConfig(root: string): Promise<unknown> {
  const file = path.join(root, CONFIG_FILE);
  try {
    await access(file);
  } catch {
    throw new ConfigError(`${CONFIG_FILE} not found`);
  }
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (mod.default === undefined) throw new Error("it has no default export");
    return mod.default;
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE}: ${(e as Error).message}`);
  }
}

/** Loads every endpoint as a full spec, sorted by name. */
export async function loadSpecs(root: string): Promise<EndpointSpec[]> {
  const raw = await importConfig(root);
  const result = v.safeParse(Config, raw);
  if (!result.success) {
    const issues = result.issues.map((i) => `  ${where(i, raw)}: ${i.message}`).join("\n");
    throw new ConfigError(`${CONFIG_FILE}:\n${issues}`);
  }
  const { defaults, endpoints } = result.output;

  const specs = endpoints.map((e): EndpointSpec => {
    const { model } = e;
    const refs = Object.fromEntries(
      Object.entries(model.secrets).map(([k, name]) => [k, secretRef(name)]),
    );
    const scaling = e.scaling ?? defaults.scaling;
    return {
      name: e.name ?? model.name,
      type: defaults.type,
      image: defaults.image,
      disk: e.disk ?? defaults.disk,
      env: {
        ...defaults.env,
        [SOURCE_KEY]: model.source,
        ...model.vllm,
        ...refs,
        [SERVED_NAME_KEY]: model.name,
      },
      gpu: { pools: e.gpu.pools, excludedTypes: e.gpu.excludedTypes, count: e.gpu.count },
      workers: {
        min: e.workers.min,
        max: e.workers.max,
        // The API rejects idleTimeout for queue endpoints that scale on request count.
        ...(defaults.type === "QUEUE" && scaling.type === "REQUEST_COUNT"
          ? {}
          : { idleTimeout: e.idleTimeout ?? defaults.idleTimeout }),
      },
      scaling,
      timeout: e.timeout ?? defaults.timeout,
      flashboot: e.flashboot ?? defaults.flashboot,
    };
  });

  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name)) {
      throw new ConfigError(
        `${CONFIG_FILE}: two endpoints are named ${s.name}; set a different name on one of them`,
      );
    }
    seen.add(s.name);
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}
