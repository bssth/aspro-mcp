// Bundles the server together with its dependencies, so the published package
// has no runtime dependencies at all. `npx -y aspro-mcp` then installs a single
// package instead of ~100, which is the difference between a sub-second start
// and a 30s+ one that MCP clients time out on (see CHANGELOG 0.2.2).
import { build, context } from "esbuild";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/index.ts", "src/smoke.ts", "src/e2e.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  metafile: true,
  logLevel: "info",
  // Bundled CommonJS dependencies call require() for Node built-ins, which
  // does not exist in an ES module unless we provide it.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
};

// Redistributing bundled dependencies means shipping their license texts too.
function writeThirdPartyLicenses(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.outputs["dist/index.js"].inputs)) {
    const match = input.match(/^((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) roots.add(match[1]);
  }

  const sections = [...roots].sort().map((root) => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const file = readdirSync(root).find((name) => /^(licen[sc]e|copying)(\.|$)/i.test(name));
    const text = file ? readFileSync(join(root, file), "utf8").trim() : `License: ${pkg.license}`;
    return `${pkg.name}@${pkg.version} (${pkg.license})\n\n${text}`;
  });

  writeFileSync(
    "dist/THIRD_PARTY_LICENSES.txt",
    "dist/index.js bundles the following third-party packages.\n\n" +
      sections.join(`\n\n${"-".repeat(72)}\n\n`) +
      "\n",
  );
  console.log(`  dist/THIRD_PARTY_LICENSES.txt  ${sections.length} packages`);
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  if (existsSync("dist")) rmSync("dist", { recursive: true });
  const { metafile } = await build(options);
  writeThirdPartyLicenses(metafile);
}
