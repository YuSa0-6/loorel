// Minimal client for Runpod REST API v2 (https://api.runpod.io/v2/openapi.json).
import type { EndpointSpec } from "./config.ts";

const RUNPOD_API = "https://api.runpod.io/v2";
const RUNPOD_INFERENCE_API = "https://api.runpod.ai/v2";

/** An endpoint as returned by GET /v2/serverless. Only the fields sync reads. */
export interface RemoteEndpoint {
  id: string;
  name: string;
  type?: EndpointSpec["type"];
  image?: string;
  disk?: number;
  env?: Record<string, string>;
  gpu?: {
    pools: string[];
    excludedTypes?: string[];
    count?: number;
    minCudaVersion?: string | null;
  };
  workers: { min?: number; max?: number; idleTimeout?: number };
  scaling: Partial<EndpointSpec["scaling"]>;
  timeout: number;
  flashboot: EndpointSpec["flashboot"];
  dataCenterIds?: string[];
  networkVolumes?: string[];
}

export interface GpuType {
  id: string;
  pool: string | null;
}

/** A data center as returned by GET /v2/catalog/datacenters. */
export interface DataCenter {
  id: string;
  name: string;
}

/** A network volume as returned by GET /v2/network-volumes. */
export interface NetworkVolume {
  id: string;
  name: string;
  dataCenter: string;
}

/** An account secret as returned by GET /v2/account/secrets. The value is never returned. */
export interface Secret {
  name: string;
}

export class RunpodError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RunpodApi {
  listEndpoints(): Promise<RemoteEndpoint[]>;
  listGpuTypes(): Promise<GpuType[]>;
  listSecrets(): Promise<Secret[]>;
  listDataCenters(): Promise<DataCenter[]>;
  listNetworkVolumes(): Promise<NetworkVolume[]>;
  createEndpoint(spec: EndpointSpec): Promise<RemoteEndpoint>;
  updateEndpoint(id: string, patch: Record<string, unknown>): Promise<RemoteEndpoint>;
  deleteEndpoint(id: string): Promise<void>;
  /** Inference API health; worker counts do not prove the model can serve. */
  getEndpointHealth(id: string): Promise<{ workers: { ready?: number; running: number } }>;
  getEndpoint(id: string): Promise<RemoteEndpoint>;
}

export function createRunpodApi(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  { retryReads = true }: { retryReads?: boolean } = {},
): RunpodApi {
  // fallow-ignore-next-line complexity
  async function call<T>(
    method: string,
    pathAndQuery: string,
    body?: unknown,
    base = RUNPOD_API,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(`${base}${pathAndQuery}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // Retry rate limits and server errors on reads only; writes are not idempotent.
      if (
        (res.status === 429 || res.status >= 500) &&
        method === "GET" &&
        retryReads &&
        attempt < 4
      ) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        // Errors follow RFC 9457: { title, status, detail, errors? }
        const text = await res.text();
        let detail = text;
        try {
          const p = JSON.parse(text) as { title?: string; detail?: string; errors?: string[] };
          detail = [p.title, p.detail, ...(p.errors ?? [])].filter(Boolean).join(": ");
        } catch {}
        throw new RunpodError(res.status, `${method} ${pathAndQuery} -> ${res.status} ${detail}`);
      }
      return (res.status === 204 ? undefined : await res.json()) as T;
    }
  }

  return {
    async listEndpoints() {
      const all: RemoteEndpoint[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const page: {
          endpoints: RemoteEndpoint[];
          pagination: { nextCursor: string | null; hasNextPage: boolean };
        } = await call("GET", `/serverless${query}`);
        all.push(...page.endpoints);
        cursor = page.pagination.hasNextPage ? page.pagination.nextCursor : null;
      } while (cursor);
      return all;
    },
    async listGpuTypes() {
      return (await call<{ gpus: GpuType[] }>("GET", "/catalog/gpus")).gpus;
    },
    async listSecrets() {
      return (await call<{ secrets: Secret[] }>("GET", "/account/secrets")).secrets;
    },
    async listDataCenters() {
      return (await call<{ dataCenters: DataCenter[] }>("GET", "/catalog/datacenters")).dataCenters;
    },
    async listNetworkVolumes() {
      return (await call<{ networkVolumes: NetworkVolume[] }>("GET", "/network-volumes"))
        .networkVolumes;
    },
    createEndpoint: (spec) => call("POST", "/serverless", spec),
    updateEndpoint: (id, patch) => call("PATCH", `/serverless/${encodeURIComponent(id)}`, patch),
    deleteEndpoint: (id) => call("DELETE", `/serverless/${encodeURIComponent(id)}`),
    getEndpoint: (id) => call("GET", `/serverless/${encodeURIComponent(id)}`),
    getEndpointHealth: (id) =>
      call("GET", `/${encodeURIComponent(id)}/health`, undefined, RUNPOD_INFERENCE_API),
  };
}
