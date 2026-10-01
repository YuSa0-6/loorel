// In-memory Runpod REST API v2 for tests. Follows the documented PATCH rules:
// top-level fields are replaced, and gpu.pools replaces pools and excludedTypes together.
import type { GpuType, RemoteEndpoint } from "../runpod-api.ts";

export interface FakeRunpod {
  endpoints: RemoteEndpoint[];
  requests: { method: string; path: string; body?: unknown }[];
  fetch: typeof fetch;
}

export const GPU_TYPES: GpuType[] = [
  { id: "NVIDIA GeForce RTX 4090", pool: "ADA_24" },
  { id: "NVIDIA L4", pool: "ADA_24" },
  { id: "NVIDIA A100 80GB PCIe", pool: "AMPERE_80" },
  { id: "NVIDIA GeForce RTX 3070", pool: null },
];

export function fakeRunpod(endpoints: RemoteEndpoint[] = [], { pageSize = 2 } = {}): FakeRunpod {
  const state: FakeRunpod = {
    endpoints: structuredClone(endpoints),
    requests: [],
    fetch: undefined as never,
  };
  let nextId = 1;
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  state.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    state.requests.push({ method, path: url.pathname + url.search, body });
    if (new Headers(init?.headers).get("authorization") !== "Bearer test-key") {
      return json(401, { title: "Unauthorized", status: 401, detail: "missing bearer token" });
    }

    const route = url.pathname.replace(/^\/v2/, "");
    if (method === "GET" && route === "/catalog/gpus") return json(200, { gpus: GPU_TYPES });
    if (method === "GET" && route === "/serverless") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = state.endpoints.slice(start, start + pageSize);
      const hasNextPage = start + pageSize < state.endpoints.length;
      return json(200, {
        endpoints: page,
        pagination: { hasNextPage, nextCursor: hasNextPage ? String(start + pageSize) : null },
      });
    }
    if (method === "POST" && route === "/serverless") {
      const created = {
        ...body,
        id: `ep${nextId++}`,
        gpu: { excludedTypes: [], ...body.gpu },
      } as RemoteEndpoint;
      state.endpoints.push(created);
      return json(201, created);
    }
    const match = route.match(/^\/serverless\/([^/]+)$/);
    const index = match ? state.endpoints.findIndex((e) => e.id === match[1]) : -1;
    if (index === -1)
      return json(404, { title: "Not Found", status: 404, detail: "endpoint not found" });
    const current = state.endpoints[index]!;
    if (method === "PATCH") {
      const gpu = body.gpu?.pools
        ? { excludedTypes: [], count: current.gpu?.count, ...body.gpu }
        : { ...current.gpu, ...body.gpu };
      state.endpoints[index] = { ...current, ...body, gpu };
      return json(200, state.endpoints[index]);
    }
    if (method === "DELETE") {
      state.endpoints.splice(index, 1);
      return json(204);
    }
    return json(405, { title: "Method Not Allowed", status: 405, detail: method });
  };
  return state;
}
