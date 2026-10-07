import type { UserConfig } from "tsdown/config";
import { defineConfig } from "tsdown/config";

// The TypeScript compiler reads the JSON profile registry; the faster oxc path cannot.
const dts = { generator: "tsc" } as const;

const config: UserConfig[] = [
  defineConfig({
    entry: "src/index.ts",
    dts,
  }),
  defineConfig({
    entry: { tune: "src/tune/index.ts" },
    dts,
  }),
  defineConfig({
    entry: { "provider-adapters": "src/provider-adapters/index.ts" },
    dts,
  }),
  defineConfig({
    entry: { cli: "src/cli/entry.ts" },
    dts: false,
  }),
];

export default config;
