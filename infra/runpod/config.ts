// Reads infra/runpod/defaults.yaml and models/*.yaml into endpoint specs.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { parse } from "yaml";

export type Scaling =
  | { type: "QUEUE_DELAY"; queueDelay: number }
  | { type: "REQUEST_COUNT"; requestCount: number };
export type FlashBoot = "OFF" | "FLASHBOOT" | "PRIORITY_FLASHBOOT";

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

// Keys that look like credentials. Their values would show up in PR comments.
export const SECRET_KEY = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i;
// An env value that Runpod replaces with an account secret when a worker boots.
// The value itself never passes through this repository.
export const SECRET_REF = /^\{\{ RUNPOD_SECRET_(.+) \}\}$/;
export const secretRef = (name: string) => `{{ RUNPOD_SECRET_${name} }}`;
// Set by sync so that the OpenAI-compatible route accepts the model name.
const SERVED_NAME_KEY = "OPENAI_SERVED_MODEL_NAME_OVERRIDE";

const EnvKey = v.pipe(
  v.string(),
  v.regex(/^[A-Z_][A-Z0-9_]*$/, "env var names are UPPER_SNAKE_CASE"),
  v.check(
    (k) => !SECRET_KEY.test(k),
    "secrets must not be written in YAML; reference a Runpod secret under secrets:",
  ),
  v.check((k) => k !== SERVED_NAME_KEY, `${SERVED_NAME_KEY} is set from name`),
);
const Env = v.record(
  EnvKey,
  v.pipe(
    v.union([v.string(), v.number(), v.boolean()]),
    v.transform((x) => String(x)),
  ),
);
const PositiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

// env var name -> Runpod secret name. Names follow POST /v2/account/secrets.
const Secrets = v.record(
  v.pipe(
    v.string(),
    v.regex(/^[A-Z_][A-Z0-9_]*$/, "env var names are UPPER_SNAKE_CASE"),
    v.check((k) => k !== SERVED_NAME_KEY, `${SERVED_NAME_KEY} is set from name`),
  ),
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
  flashboot: v.picklist(["OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"]),
  timeout: PositiveInt,
  idleTimeout: v.pipe(PositiveInt, v.maxValue(3600)),
  scaling: v.variant("type", [
    v.strictObject({
      type: v.literal("QUEUE_DELAY"),
      queueDelay: v.pipe(v.number(), v.minValue(0.5)),
    }),
    v.strictObject({ type: v.literal("REQUEST_COUNT"), requestCount: PositiveInt }),
  ]),
  env: v.optional(Env, {}),
});

const Model = v.pipe(
  v.strictObject({
    name: v.pipe(
      v.string(),
      v.regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "name is lowercase a-z, 0-9 and -"),
    ),
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
    vllm: v.pipe(
      Env,
      v.check(
        (env) => typeof env.MODEL_NAME === "string" && env.MODEL_NAME !== "",
        "vllm.MODEL_NAME is required",
      ),
    ),
    secrets: v.optional(Secrets, {}),
  }),
  v.check((m) => m.workers.min <= m.workers.max, "workers.min must be <= workers.max"),
  v.check(
    (m) => Object.keys(m.secrets).every((k) => !(k in m.vllm)),
    "an env var is set in both vllm and secrets",
  ),
);

export class ConfigError extends Error {}

async function readYaml<T>(
  file: string,
  schema: v.GenericSchema<unknown, T>,
  root: string,
): Promise<T> {
  const rel = path.relative(root, file);
  let raw: unknown;
  try {
    raw = parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${rel}: ${(e as Error).message}`);
  }
  const result = v.safeParse(schema, raw);
  if (!result.success) {
    const issues = result.issues
      .map((i) => `  ${v.getDotPath(i) ?? "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`${rel}:\n${issues}`);
  }
  return result.output;
}

/** Loads every model as a full endpoint spec, sorted by name. */
export async function loadSpecs(root: string): Promise<EndpointSpec[]> {
  const defaults = await readYaml(path.join(root, "infra/runpod/defaults.yaml"), Defaults, root);
  const dir = path.join(root, "models");
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();

  const specs: EndpointSpec[] = [];
  for (const file of files) {
    const model = await readYaml(path.join(dir, file), Model, root);
    if (path.parse(file).name !== model.name) {
      throw new ConfigError(`models/${file}: file name must be ${model.name}.yaml`);
    }
    const refs = Object.fromEntries(
      Object.entries(model.secrets).map(([k, name]) => [k, secretRef(name)]),
    );
    specs.push({
      name: model.name,
      type: defaults.type,
      image: defaults.image,
      disk: model.disk ?? defaults.disk,
      env: { ...defaults.env, ...model.vllm, ...refs, [SERVED_NAME_KEY]: model.name },
      gpu: {
        pools: model.gpu.pools,
        excludedTypes: model.gpu.excludedTypes,
        count: model.gpu.count,
      },
      workers: {
        min: model.workers.min,
        max: model.workers.max,
        // The API rejects idleTimeout for queue endpoints that scale on request count.
        ...(defaults.type === "QUEUE" && defaults.scaling.type === "REQUEST_COUNT"
          ? {}
          : { idleTimeout: defaults.idleTimeout }),
      },
      scaling: defaults.scaling,
      timeout: defaults.timeout,
      flashboot: defaults.flashboot,
    });
  }
  return specs;
}
