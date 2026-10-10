// Temporary repositories with loorel.config.ts and endpoints/, for tests.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Defaults, EndpointDef } from "../define.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
// Temporary repositories have no node_modules, so they import @loorel/define by file URL.
export const LOOREL = JSON.stringify(
  pathToFileURL(path.join(REPO_ROOT, "packages/define/src/define.ts")).href,
);

export const DEFAULTS: Defaults = {
  image: "runpod/worker-v1-vllm:v1.0.0",
  type: "QUEUE",
  disk: 50,
  flashboot: "FLASHBOOT",
  timeout: 600000,
  idleTimeout: 5,
  scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
  env: { GPU_MEMORY_UTILIZATION: "0.90" },
};

/** A fresh copy of the qwen3-8b endpoint, changed by `edit` (which may break it on purpose). */
export function qwen(
  edit: (e: EndpointDef & Record<string, unknown>) => void = () => {},
): EndpointDef {
  const e: EndpointDef = {
    model: { name: "qwen3-8b", source: "Qwen/Qwen3-8B", vllm: { MAX_MODEL_LEN: 8192 } },
    gpu: { pools: ["ADA_24"], count: 1 },
    workers: { min: 0, max: 2 },
  };
  edit(e as EndpointDef & Record<string, unknown>);
  return e;
}
export const QWEN = qwen();
export const CONFIG = `import { defineConfig } from ${LOOREL};
export default defineConfig({ defaults: ${JSON.stringify(DEFAULTS)} });
`;
export const endpointFile = (endpoint: unknown) =>
  `import { defineEndpoint } from ${LOOREL};\nexport default defineEndpoint(${JSON.stringify(endpoint)});\n`;

/** A repository with loorel.config.ts and one endpoints/<name>/ directory per entry. */
export async function makeRepo(endpoints: Record<string, unknown>, endpointsJson?: unknown) {
  const files: Record<string, string> = { "loorel.config.ts": CONFIG };
  for (const [name, endpoint] of Object.entries(endpoints))
    files[`endpoints/${name}/endpoint.config.ts`] = endpointFile(endpoint);
  return makeRepoWithFiles(files, endpointsJson);
}

export async function makeRepoWithFiles(files: Record<string, string>, endpointsJson?: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "loorel-"));
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  if (endpointsJson)
    await writeFile(path.join(root, "endpoints.json"), JSON.stringify(endpointsJson));
  return root;
}
