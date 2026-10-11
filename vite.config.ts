import { configDefaults, defineConfig } from "vite-plus";

// .claude/skills holds third-party skills vendored as-is; keep them out of format, lint and test.
const vendored = [".claude/**"];

export default defineConfig({
  fmt: {
    ignorePatterns: vendored,
  },
  lint: {
    ignorePatterns: vendored,
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    exclude: [...configDefaults.exclude, ...vendored],
  },
  staged: {
    "*": "vp check --fix",
  },
});
