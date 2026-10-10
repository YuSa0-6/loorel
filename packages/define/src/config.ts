// Loads loorel.config.ts (shared defaults) and endpoints/<name>/endpoint.config.ts
// (one Runpod endpoint per directory) into endpoint specs.
// The types in define.ts guide the editor; the schemas here check the same values at runtime,
// including the rules that types cannot express.
import type { Dirent } from "node:fs";
import { access, readdir } from "node:fs/promises";
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

const CONFIG_FILE = "loorel.config.ts";
const ENDPOINTS_DIR = "endpoints";
const ENDPOINT_FILE = "endpoint.config.ts";

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

const Image = v.pipe(v.string(), v.regex(/:[\w.-]+$/, "image must have an explicit tag"));

const Defaults = v.strictObject({
  image: Image,
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
    api: v.optional(v.picklist(["openai", "decision"]), "openai"),
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
    image: v.optional(Image),
    disk: v.optional(PositiveInt),
    flashboot: v.optional(FlashBootSchema),
    timeout: v.optional(PositiveInt),
    idleTimeout: v.optional(IdleTimeout),
    scaling: v.optional(ScalingSchema),
  }),
  v.check((e) => e.workers.min <= e.workers.max, "workers.min must be <= workers.max"),
  // The vLLM image in defaults serves only the OpenAI-compatible API.
  v.check(
    (e) => e.model.api !== "decision" || e.image !== undefined,
    "a decision model needs a worker image that serves the decision API; set image",
  ),
);

const Config = v.strictObject({ defaults: Defaults });

export class ConfigError extends Error {}

/** Imports a config file and validates its default export. `rel` is used in messages. */
async function importConfig<T>(
  root: string,
  rel: string,
  schema: v.GenericSchema<unknown, T>,
): Promise<T> {
  const file = path.join(root, rel);
  let raw: unknown;
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (mod.default === undefined) throw new Error("it has no default export");
    raw = mod.default;
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

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * Endpoint directory names under endpoints/, sorted. Directories starting with "_" or "."
 * hold shared code (for example a model used by several endpoints) and are skipped.
 */
async function endpointDirs(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, ENDPOINTS_DIR), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const names = entries
    .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const dir = `${ENDPOINTS_DIR}/${name}`;
    const result = v.safeParse(Name, name);
    if (!result.success) {
      throw new ConfigError(
        `${dir}: ${result.issues[0].message} (the directory name is the endpoint name)`,
      );
    }
    if (!(await exists(path.join(root, dir, ENDPOINT_FILE)))) {
      throw new ConfigError(
        `${dir}: ${ENDPOINT_FILE} not found (start the directory name with _ to keep shared code there)`,
      );
    }
  }
  return names;
}

/** One endpoint directory: the Runpod spec plus what callers need to know. */
export interface LoadedEndpoint {
  name: string;
  /** How callers talk to the worker: OpenAI-compatible chat or the decision API. */
  api: "openai" | "decision";
  /** The model name callers send. */
  model: string;
  spec: EndpointSpec;
}

/** Loads loorel.config.ts and every endpoints/<name>/endpoint.config.ts, sorted by name. */
export async function loadEndpoints(root: string): Promise<LoadedEndpoint[]> {
  if (!(await exists(path.join(root, CONFIG_FILE)))) {
    throw new ConfigError(`${CONFIG_FILE} not found`);
  }
  const { defaults } = await importConfig(root, CONFIG_FILE, Config);

  const endpoints: LoadedEndpoint[] = [];
  for (const name of await endpointDirs(root)) {
    const file = `${ENDPOINTS_DIR}/${name}/${ENDPOINT_FILE}`;
    const e = await importConfig(root, file, Endpoint);
    const { model } = e;
    // Callers send decision requests to /runsync, which only queue endpoints have.
    if (model.api === "decision" && defaults.type !== "QUEUE") {
      throw new ConfigError(`${file}: a decision model needs type QUEUE in ${CONFIG_FILE}`);
    }
    const refs = Object.fromEntries(
      Object.entries(model.secrets).map(([k, secret]) => [k, secretRef(secret)]),
    );
    const scaling = e.scaling ?? defaults.scaling;
    endpoints.push({
      name,
      api: model.api,
      model: model.name,
      spec: {
        name,
        type: defaults.type,
        image: e.image ?? defaults.image,
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
      },
    });
  }
  return endpoints;
}

/** The Runpod specs of every endpoint, sorted by name. */
export const loadSpecs = async (root: string): Promise<EndpointSpec[]> =>
  (await loadEndpoints(root)).map((e) => e.spec);
