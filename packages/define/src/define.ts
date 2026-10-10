// Types and helpers imported as "@loorel/define" by loorel.config.ts and endpoints/<name>/*.config.ts.
// The define* functions return their argument unchanged: they exist so that the editor
// checks and completes each definition. config.ts validates the values again at runtime.

/** GPU pool IDs of Runpod REST API v2: https://docs.runpod.io/references/gpu-types */
export type GpuPool =
  | "AMPERE_16" // A4000, A4500, RTX 4000, RTX 2000 (16 GB)
  | "AMPERE_24" // L4, A5000, 3090 (24 GB)
  | "ADA_24" // 4090 (24 GB)
  | "AMPERE_48" // A6000, A40 (48 GB)
  | "ADA_48_PRO" // L40, L40S, 6000 Ada (48 GB)
  | "AMPERE_80" // A100 (80 GB)
  | "ADA_80_PRO" // H100 (80 GB)
  | "HOPPER_141"; // H200 (141 GB)

/** Numbers and booleans are sent to Runpod as strings. */
export type EnvValue = string | number | boolean;

/**
 * vLLM worker env vars: https://docs.runpod.io/serverless/vllm/environment-variables
 * The common ones are listed for completion; any other UPPER_SNAKE_CASE name works too.
 */
export interface VllmEnv {
  /** Maximum context length in tokens. */
  MAX_MODEL_LEN?: EnvValue;
  /** Share of GPU memory that vLLM may use, 0 to 1. */
  GPU_MEMORY_UTILIZATION?: EnvValue;
  /** Requests one worker handles at the same time. */
  MAX_CONCURRENCY?: EnvValue;
  /** Weight data type, for example "auto" or "bfloat16". */
  DTYPE?: EnvValue;
  /** Quantization method, for example "awq" or "gptq". */
  QUANTIZATION?: EnvValue;
  /** GPUs one model is split across. Usually the same as gpu.count. */
  TENSOR_PARALLEL_SIZE?: EnvValue;
  [name: string]: EnvValue | undefined;
}

/** What is served: the model weights and how vLLM runs them. */
export interface ModelDef {
  /**
   * The model name that apps send in `model`. Lowercase a-z, 0-9 and -.
   * Set as OPENAI_SERVED_MODEL_NAME_OVERRIDE.
   */
  name: string;
  /** Hugging Face repository, for example "Qwen/Qwen3-8B". Set as MODEL_NAME. */
  source: string;
  /**
   * How callers talk to the model. Defaults to "openai" (chat completions through vLLM).
   * "decision" is the System One request format of decision models such as Jev, Cloudflare
   * Clef and Perplexity Decider: a state and typed questions in, probabilities out.
   * A decision model needs an endpoint `image` whose worker serves that format.
   */
  api?: "openai" | "decision";
  /** vLLM worker env vars. Secret values do not belong here; use `secrets`. */
  vllm?: VllmEnv;
  /** env var name -> Runpod secret name. Runpod fills in the value when a worker boots. */
  secrets?: Record<string, string>;
}

export type Scaling =
  | {
      type: "QUEUE_DELAY";
      /** Seconds a request may wait before a worker is added. */
      queueDelay: number;
    }
  | {
      type: "REQUEST_COUNT";
      /** Requests per worker before a worker is added. */
      requestCount: number;
    };

export type FlashBoot = "OFF" | "FLASHBOOT" | "PRIORITY_FLASHBOOT";

/** Settings every endpoint starts from. An endpoint may override some of them. */
export interface Defaults {
  /** vLLM worker image with an exact tag. */
  image: string;
  type: "QUEUE" | "LOAD_BALANCER";
  /** Container disk in GB. The model is downloaded here. */
  disk: number;
  flashboot: FlashBoot;
  /** Milliseconds per request. */
  timeout: number;
  /** Seconds before an idle worker stops, 1 to 3600. */
  idleTimeout: number;
  scaling: Scaling;
  /** vLLM worker env vars shared by every model. */
  env?: VllmEnv;
  /**
   * Data centers workers may start in, for example "US-TX-3". Empty or unset lets Runpod choose.
   * IDs: GET https://api.runpod.io/v2/catalog/datacenters
   */
  dataCenters?: string[];
  /** Lowest CUDA driver version a worker host may have, as "major.minor" (for example "12.8"). */
  minCudaVersion?: string;
}

interface GpuCommon {
  /** GPUs per worker. Defaults to 1. */
  count?: number;
  /** Lowest CUDA driver version a worker host may have, as "major.minor". Overrides defaults. */
  minCudaVersion?: string;
}

/** Pick GPUs by pool, optionally leaving some types out. */
export interface GpuByPool extends GpuCommon {
  /** Pools to start workers in, in order of preference. At least one. */
  pools: [GpuPool, ...GpuPool[]];
  /** GPU types inside the pools to leave out, for example "NVIDIA L4". */
  excludedTypes?: string[];
}

/**
 * Pick exact GPU types, for example "NVIDIA GeForce RTX 4090". The plan turns them into the
 * pools that hold them and excludes every other type in those pools.
 * IDs: GET https://api.runpod.io/v2/catalog/gpus
 */
export interface GpuByType extends GpuCommon {
  types: [string, ...string[]];
}

/**
 * Where and how a model runs: one Runpod Serverless endpoint.
 * The directory name (endpoints/<name>/) is the endpoint name on Runpod.
 */
export interface EndpointDef {
  /** Usually imported from ./model.config.ts, or from another endpoint's directory. */
  model: ModelDef;
  gpu: GpuByPool | GpuByType;
  workers: {
    /** Workers kept running. 0 means nothing is billed while idle. */
    min: number;
    /** Most workers running at the same time. */
    max: number;
  };
  /**
   * Worker image with an exact tag, instead of defaults.image. Required for a decision model:
   * its worker takes { input: <decision request> } on /runsync and returns the decision response.
   */
  image?: string;
  /** Env vars for this endpoint only, on top of defaults.env and the model's vllm. */
  env?: VllmEnv;
  /** Data centers for this endpoint, instead of defaults.dataCenters. */
  dataCenters?: string[];
  /**
   * Network volume IDs mounted at /runpod-volume, for example to keep model weights between
   * cold starts. At most one per data center, and each must be in one of `dataCenters` when set.
   * IDs: GET https://api.runpod.io/v2/network-volumes
   */
  networkVolumes?: string[];
  disk?: number;
  flashboot?: FlashBoot;
  timeout?: number;
  idleTimeout?: number;
  scaling?: Scaling;
}

/** loorel.config.ts. Endpoints are found in endpoints/<name>/endpoint.config.ts. */
export interface Config {
  defaults: Defaults;
}

export const defineModel = <const M extends ModelDef>(model: M): M => model;
export const defineEndpoint = <const E extends EndpointDef>(endpoint: E): E => endpoint;
export const defineConfig = (config: Config): Config => config;
