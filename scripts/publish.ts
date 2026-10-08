// Publishes each workspace package whose version is not on npm yet, through
// npm trusted publishing: in GitHub Actions, npm exchanges the workflow's OIDC
// token for a short-lived publish token, so no npm token is stored.
//
//   node scripts/publish.ts [--tag <dist-tag>] [--dry-run]
//
// pnpm packs each package, which replaces the `workspace:` version of
// @tokenxl/count with the real one; npm then publishes the tarball with
// provenance. With the `latest` tag, the script then creates the git tags
// (`changeset tag`), whose "New tag:" lines the changesets action turns into
// GitHub releases.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tag: { type: "string", default: "latest" },
    // Packs and checks each package without publishing or tagging.
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});
const tag = values.tag;
const dryRun = values["dry-run"];
const root = resolve(import.meta.dirname, "..");
// @tokenxl/count first: @tokenxl/tune depends on its exact version.
const PACKAGES = ["packages/count", "packages/tune"];
const destination = mkdtempSync(join(tmpdir(), "tokenxl-publish-"));

function isPublished(name: string, version: string): boolean {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

let published = 0;
for (const directory of PACKAGES) {
  const cwd = resolve(root, directory);
  const { name, version } = JSON.parse(
    readFileSync(resolve(cwd, "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (isPublished(name, version)) {
    console.log(`${name}@${version} is already on npm.`);
    continue;
  }
  const before = new Set(readdirSync(destination));
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd,
    stdio: "inherit",
  });
  const tarball = readdirSync(destination).find((file) => !before.has(file));
  if (!tarball) throw new Error(`pnpm pack wrote no tarball for ${name}.`);
  execFileSync(
    "npm",
    [
      "publish",
      join(destination, tarball),
      "--access",
      "public",
      "--tag",
      tag,
      // Provenance needs the CI identity, which a local dry run lacks.
      ...(dryRun ? ["--dry-run"] : ["--provenance"]),
    ],
    { stdio: "inherit" },
  );
  published++;
}

if (published && tag === "latest" && !dryRun)
  execFileSync("pnpm", ["changeset", "tag"], { cwd: root, stdio: "inherit" });
