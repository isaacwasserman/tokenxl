import type { ViteUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

// Tests run against the @tokenxl/count sources, without a build.
const config: ViteUserConfig = defineConfig({
  resolve: { conditions: ["tokenxl-source"] },
  ssr: { resolve: { conditions: ["tokenxl-source"] } },
  test: { maxWorkers: 2 },
});

export default config;
