import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Persist only the caller's allowlisted result, with private file permissions. */
async function writeResult(name: string, result: object): Promise<void> {
  await mkdir("artifacts", { recursive: true });
  await writeFile(path.join("artifacts", name), `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

export async function finishResult(
  name: string,
  result: { ok: boolean; error?: { code: string; httpStatus?: number } },
): Promise<void> {
  try {
    await writeResult(name, result);
  } catch {
    result.ok = false;
    result.error = { code: "output_file_error" };
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
