// One entry point for every endpoint in loorel.gen.ts. The endpoint's api picks the call style:
// model() for OpenAI-compatible chat (an AI SDK model), decider() for the decision API.
import { createLoorelModel, InferenceConfigError } from "./ai.ts";
import { createLoorelDecider } from "./decision.ts";

/** One entry of `endpoints` in loorel.gen.ts. */
export interface EndpointInfo {
  readonly api: "openai" | "decision";
  readonly model: string;
}

/** Endpoint names in E whose api is A. */
type NamesWith<E, A> = { [K in keyof E]: E[K] extends { api: A } ? K : never }[keyof E] & string;

export interface LoorelClientOptions<E extends Record<string, EndpointInfo>> {
  /** `endpoints` from loorel.gen.ts (pnpm types). */
  endpoints: E;
  /** endpoints.json, written by apply: endpoint name -> { id }. */
  ids: Partial<Record<string, { id: string }>>;
  apiKey: string;
  /** Route through Cloudflare AI Gateway (custom provider "runpod") instead of Runpod directly. */
  gateway?: { accountId: string; gatewayId: string; token: string };
  fetch?: typeof fetch;
}

export function createLoorelClient<const E extends Record<string, EndpointInfo>>(
  options: LoorelClientOptions<E>,
) {
  const route = (name: string, api: EndpointInfo["api"]) => {
    const info = options.endpoints[name];
    if (!info) throw new InferenceConfigError(`${name} is not in loorel.gen.ts`);
    // Types already prevent this; the check covers plain JavaScript callers.
    if (info.api !== api) throw new InferenceConfigError(`${name} uses the ${info.api} API`);
    const id = options.ids[name]?.id;
    if (!id) throw new InferenceConfigError(`${name} has no ID in endpoints.json; run apply first`);
    const { gateway } = options;
    return {
      model: info.model,
      apiKey: options.apiKey,
      fetch: options.fetch,
      ...(gateway
        ? {
            baseURL: `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.gatewayId}/custom-runpod/v2/${id}`,
            gatewayToken: gateway.token,
          }
        : { endpointId: id }),
    };
  };

  return {
    /** An AI SDK chat model for an endpoint whose model uses the OpenAI-compatible API. */
    model(name: NamesWith<E, "openai">) {
      const r = route(name, "openai");
      return createLoorelModel("baseURL" in r ? { ...r, baseURL: `${r.baseURL}/openai/v1` } : r);
    },
    /** A typed decide() for an endpoint whose model uses the decision API. */
    decider(name: NamesWith<E, "decision">, timing?: { timeoutMs?: number; pollMs?: number }) {
      return createLoorelDecider({ ...route(name, "decision"), ...timing });
    },
  };
}
