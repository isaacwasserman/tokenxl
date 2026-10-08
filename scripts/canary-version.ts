// Sets every workspace package to the next patch version with a canary
// suffix, for example 0.1.1-canary.abc1234. The versions stay the same across
// packages, because @tokenxl/tune depends on the exact @tokenxl/count version.
//
//   node scripts/canary-version.ts <short-sha>

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const sha = process.argv[2];
if (!sha) throw new Error("Usage: node scripts/canary-version.ts <short-sha>");
const root = resolve(import.meta.dirname, "..");
for (const directory of ["packages/count", "packages/tune"]) {
  const path = resolve(root, directory, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version: string };
  const [major, minor, patch] = pkg.version
    .split("-")[0]!
    .split(".")
    .map(Number);
  pkg.version = `${major}.${minor}.${patch! + 1}-canary.${sha}`;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${directory}: ${pkg.version}`);
}
