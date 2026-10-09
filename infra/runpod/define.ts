// Declares models and endpoints in TypeScript instead of YAML.
// The argument types come from the same valibot schemas that check models/*.yaml,
// so the editor and the plan reject the same mistakes.
import * as v from "valibot";
import {
  Env,
  Gpu,
  Model,
  Name,
  PositiveInt,
  Secrets,
  WorkerCount,
  parseConfig,
  secretRef,
  type EndpointSpec,
} from "./config.ts";

/** A vLLM model. Same fields as models/*.yaml; defaults.yaml fills the rest. */
export type ModelConfig = v.InferInput<typeof Model>;
export type ModelDef = v.InferOutput<typeof Model> & { readonly kind: "model" };

export function defineModel(config: ModelConfig): ModelDef {
  const model = parseConfig(Model, config, `model ${config.name}`);
  return { ...model, kind: "model" };
}

const EndpointConfig = v.pipe(
  v.strictObject({
    name: Name,
    type: v.optional(v.picklist(["QUEUE", "LOAD_BALANCER"]), "QUEUE"),
    image: v.pipe(v.string(), v.regex(/:[\w.-]+$/, "image must have an explicit tag")),
    gpu: Gpu,
    workers: v.strictObject({
      min: WorkerCount,
      max: PositiveInt,
      idleTimeout: v.optional(v.pipe(PositiveInt, v.maxValue(3600)), 5),
    }),
    disk: v.optional(PositiveInt, 20),
    env: v.optional(Env, {}),
    secrets: v.optional(Secrets, {}),
    scaling: v.optional(
      v.variant("type", [
        v.strictObject({
          type: v.literal("QUEUE_DELAY"),
          queueDelay: v.pipe(v.number(), v.minValue(0.5)),
        }),
        v.strictObject({ type: v.literal("REQUEST_COUNT"), requestCount: PositiveInt }),
      ]),
      { type: "QUEUE_DELAY", queueDelay: 4 },
    ),
    timeout: v.optional(PositiveInt, 600000),
    flashboot: v.optional(v.picklist(["OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"]), "FLASHBOOT"),
  }),
  v.check((e) => e.workers.min <= e.workers.max, "workers.min must be <= workers.max"),
  v.check(
    (e) => Object.keys(e.secrets).every((k) => !(k in e.env)),
    "an env var is set in both env and secrets",
  ),
);

/** Any valibot schema for the JSON that goes in `input` or comes back as `output`. */
type IoSchema = v.GenericSchema<any, any>;

export type EndpointConfig<TIn extends IoSchema, TOut extends IoSchema> = v.InferInput<
  typeof EndpointConfig
> & {
  /** Checks the job input before it is sent. Its input type is what callers pass. */
  input: TIn;
  /** Checks the worker's output before it is returned. Its output type is what callers get. */
  output: TOut;
};

export interface EndpointDef<TIn extends IoSchema, TOut extends IoSchema> {
  readonly kind: "endpoint";
  readonly name: string;
  /** What sync sends to Runpod, in REST API v2 field names. */
  readonly spec: EndpointSpec;
  readonly input: TIn;
  readonly output: TOut;
}

export type EndpointInput<E> =
  E extends EndpointDef<infer TIn, IoSchema> ? v.InferInput<TIn> : never;
export type EndpointOutput<E> =
  E extends EndpointDef<IoSchema, infer TOut> ? v.InferOutput<TOut> : never;

/** A Serverless endpoint whose job input and output are typed by valibot schemas. */
export function defineEndpoint<TIn extends IoSchema, TOut extends IoSchema>(
  config: EndpointConfig<TIn, TOut>,
): EndpointDef<TIn, TOut> {
  const { input, output, ...rest } = config;
  const e = parseConfig(EndpointConfig, rest, `endpoint ${config.name}`);
  const refs = Object.fromEntries(
    Object.entries(e.secrets).map(([k, name]) => [k, secretRef(name)]),
  );
  return {
    kind: "endpoint",
    name: e.name,
    spec: {
      name: e.name,
      type: e.type,
      image: e.image,
      disk: e.disk,
      env: { ...e.env, ...refs },
      gpu: e.gpu,
      workers: {
        min: e.workers.min,
        max: e.workers.max,
        // The API rejects idleTimeout for queue endpoints that scale on request count.
        ...(e.type === "QUEUE" && e.scaling.type === "REQUEST_COUNT"
          ? {}
          : { idleTimeout: e.workers.idleTimeout }),
      },
      scaling: e.scaling,
      timeout: e.timeout,
      flashboot: e.flashboot,
    },
    input,
    output,
  };
}
