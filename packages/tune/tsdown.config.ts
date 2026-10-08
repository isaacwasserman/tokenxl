import type { UserConfig } from "tsdown/config";
import { defineConfig } from "tsdown/config";

// @tokenxl/count stays an external dependency; its internals change with its version.
const config: UserConfig = defineConfig({
  entry: {
    index: "src/index.ts",
    "provider-adapters": "src/provider-adapters/index.ts",
  },
  dts: { generator: "tsc" },
});

export default config;
