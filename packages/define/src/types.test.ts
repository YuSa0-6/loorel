import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { makeRepo, qwen, QWEN, REPO_ROOT } from "./testing/repo.ts";
import { renderTypes, types } from "./types.ts";

async function run(root: string, ...argv: string[]) {
  const lines: string[] = [];
  const code = await types({ argv, root, log: (l) => lines.push(l) });
  return { code, output: lines.join("\n") };
}

const CLEF = qwen((e) => {
  e.model = { name: "clef", source: "Cloudflare/clef", api: "decision" };
  e.image = "example/clef-worker:v1.0.0";
});

describe("types", () => {
  test("the repository's loorel.gen.ts is up to date", async () => {
    const { code, output } = await run(REPO_ROOT, "--check");
    expect(output).toBe("");
    expect(code).toBe(0);
  });

  test("every endpoint is listed with its api and model name", async () => {
    const root = await makeRepo({ "qwen3-8b": QWEN, "risk-check": CLEF });
    expect(await run(root)).toEqual({ code: 0, output: "wrote loorel.gen.ts" });
    const text = await readFile(path.join(root, "loorel.gen.ts"), "utf8");
    expect(text).toContain('  "qwen3-8b": {\n    api: "openai",\n    model: "qwen3-8b",\n  },');
    expect(text).toContain('  "risk-check": {\n    api: "decision",\n    model: "clef",\n  },');
    expect(text).toContain("export type Endpoints = typeof endpoints;");
  });

  test("--check fails when the file is missing or stale, and writes nothing", async () => {
    const root = await makeRepo({ "qwen3-8b": QWEN });
    expect(await run(root, "--check")).toEqual({
      code: 1,
      output: "error: loorel.gen.ts is out of date; run pnpm types",
    });
    await run(root);
    expect((await run(root, "--check")).code).toBe(0);
  });

  test("no endpoints give an empty object, and names that are identifiers stay unquoted", () => {
    expect(renderTypes([])).toContain("export const endpoints = {} as const;");
    const spec = {} as never;
    expect(renderTypes([{ name: "clef", api: "decision", model: "clef", spec }])).toContain(
      "  clef: {",
    );
  });

  test("an unknown argument is a usage error", async () => {
    expect((await run(REPO_ROOT, "--chek")).code).toBe(2);
  });
});
