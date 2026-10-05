import { createRunpod } from "@runpod/ai-sdk-provider";

export interface LoorelModelOptions {
  /** YAML name / OPENAI_SERVED_MODEL_NAME_OVERRIDE, not the endpoint ID. */
  model: string;
  apiKey: string;
  /** Use exactly one of endpointId (direct Runpod) and baseURL (explicit route). */
  endpointId?: string;
  baseURL?: string;
  /** Required only for the authenticated Cloudflare AI Gateway route. */
  gatewayToken?: string;
  fetch?: typeof fetch;
}

export class InferenceConfigError extends Error {}

/** Creates an AI SDK chat model for an existing Loorel vLLM endpoint. */
export function createLoorelModel(options: LoorelModelOptions) {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(options.model)) {
    throw new InferenceConfigError("model must be the lowercase YAML name");
  }
  if (!options.apiKey || /\s/.test(options.apiKey)) {
    throw new InferenceConfigError("RUNPOD_API_KEY is missing or invalid");
  }
  if (Boolean(options.endpointId) === Boolean(options.baseURL)) {
    throw new InferenceConfigError("set exactly one of endpointId and baseURL");
  }
  if (options.endpointId && !/^[a-zA-Z0-9_-]+$/.test(options.endpointId)) {
    throw new InferenceConfigError("endpointId is invalid");
  }

  const baseURL = (
    options.baseURL ?? `https://api.runpod.ai/v2/${options.endpointId}/openai/v1`
  ).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new InferenceConfigError("baseURL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  ) {
    throw new InferenceConfigError(
      "baseURL must be HTTPS without credentials, query, hash or port",
    );
  }
  const direct =
    url.hostname === "api.runpod.ai" && /^\/v2\/[a-zA-Z0-9_-]+\/openai\/v1$/.test(url.pathname);
  const gateway =
    url.hostname === "gateway.ai.cloudflare.com" &&
    /^\/v1\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/custom-runpod\/v2\/[a-zA-Z0-9_-]+\/openai\/v1$/.test(
      url.pathname,
    );
  if (!direct && !gateway) {
    throw new InferenceConfigError("baseURL must be a Runpod or custom-runpod Gateway vLLM route");
  }
  if (gateway && (!options.gatewayToken || /\s/.test(options.gatewayToken))) {
    throw new InferenceConfigError("CF_AIG_TOKEN is missing or invalid");
  }

  return createRunpod({
    apiKey: options.apiKey,
    baseURL,
    // Never send a Gateway token to the direct Runpod route.
    headers: gateway ? { "cf-aig-authorization": `Bearer ${options.gatewayToken}` } : undefined,
    // Custom auth headers must not follow redirects to another destination.
    fetch: (input, init) => (options.fetch ?? fetch)(input, { ...init, redirect: "error" }),
  })(options.model);
}
