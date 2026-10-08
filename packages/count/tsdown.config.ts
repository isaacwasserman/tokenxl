import type { UserConfig } from "tsdown/config";
import { defineConfig } from "tsdown/config";

// The TypeScript compiler reads the JSON profile registry; the faster oxc path cannot.
const dts = { generator: "tsc" } as const;

const config: UserConfig[] = [
  defineConfig({
    entry: { index: "src/index.ts", internal: "src/internal.ts" },
    dts,
  }),
  defineConfig({
    entry: { cli: "src/cli/entry.ts" },
    dts: false,
  }),
];

export default config;
