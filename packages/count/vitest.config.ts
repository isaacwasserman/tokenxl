import type { ViteUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({ test: { maxWorkers: 2 } });

export default config;
