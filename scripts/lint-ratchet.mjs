#!/usr/bin/env node
// One counted ledger per package. All lint rules stay enabled.
import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { suppressionGuard } from "./eslint-policy.mjs";

// Keep type information on repeated parses under CI, including guard scans.
process.env.TSESTREE_SINGLE_RUN = "false";

const repository = fileURLToPath(new URL("../", import.meta.url));
const migrationBase = "9e678b5eab242e550bfbb8f999668345ae0fdc11";
const protectedRules = new Set([
  "no-warning-comments",
  "@typescript-eslint/ban-ts-comment",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function collectPairs(data) {
  if (!isRecord(data)) throw new Error("Ratchet must be a JSON object");
  const pairs = new Map();
  for (const [file, rules] of Object.entries(data)) {
    if (
      !/\.(?:[cm]?[jt]s|tsx|jsx)$/u.test(file) ||
      /[*?{}[\]!\\]/u.test(file) ||
      path.posix.isAbsolute(file) ||
      file.startsWith("../") ||
      path.posix.normalize(file) !== file ||
      !isRecord(rules) ||
      Object.keys(rules).length === 0
    ) {
      throw new Error(
        `Ratchet requires an exact package file with rules: ${file}`,
      );
    }
    for (const [rule, entry] of Object.entries(rules)) {
      if (
        !rule ||
        /\s/u.test(rule) ||
        protectedRules.has(rule) ||
        !isRecord(entry) ||
        Object.keys(entry).join() !== "count" ||
        !Number.isSafeInteger(entry.count) ||
        entry.count <= 0
      ) {
        throw new Error(
          `Invalid or protected ratchet allowance: ${file}: ${rule}`,
        );
      }
      pairs.set(`${file}\0${rule}`, entry.count);
    }
  }
  return pairs;
}

export function assertNoGrowth(current, baseline, label) {
  const grown = [];
  for (const [pair, count] of current) {
    const before = baseline.get(pair) ?? 0;
    if (count > before)
      grown.push(`${pair.replace("\0", ": ")}: ${before} -> ${count}`);
  }
  if (grown.length) {
    throw new Error(
      `Ratchet grew ${label}; only removals and count reductions are allowed:\n${grown.sort().join("\n")}`,
    );
  }
}

export function assertExactFindings(manifest, findings) {
  const differences = [];
  for (const pair of new Set([...manifest.keys(), ...findings.keys()])) {
    const allowed = manifest.get(pair) ?? 0;
    const actual = findings.get(pair) ?? 0;
    if (allowed !== actual)
      differences.push(
        `${pair.replace("\0", ": ")}: manifest ${allowed}, findings ${actual}`,
      );
  }
  if (differences.length)
    throw new Error(
      `Bootstrap manifest must equal current findings exactly:\n${differences.sort().join("\n")}`,
    );
}

const bootstrapSetupFiles = new Set([
  ".github/workflows/ci.yml",
  "README.md",
  "scripts/eslint-policy.mjs",
  "scripts/lint-ratchet.mjs",
  "test/scripts/lint-ratchet.test.js",
  "test/lint-ratchet/integration.test.js",
  ...["app", "sdk"].flatMap((pkg) =>
    [
      "README.md",
      "eslint.config.js",
      "eslint-ratchet.json",
      "tsconfig.json",
      "tsconfig.eslint.json",
    ].map((file) => `${pkg}/${file}`),
  ),
]);

async function assertBootstrapSources(commit, dir) {
  const git = (args) => execFileSync("git", args, { cwd: repository });
  const baseFiles = new Set(
    git(["ls-tree", "-r", "-z", "--name-only", commit])
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const files = new Set([
    ...baseFiles,
    ...git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  ]);
  // Check the whole setup PR, including deletions, staged and untracked files.
  // Also find ignored lint inputs: Git ignore rules cannot hide new source.
  // The pinned app depends on sdk through both package and relative imports.
  async function addLintInputs(directory) {
    let entries;
    try {
      entries = await readdir(path.join(repository, directory), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      if (
        ["node_modules", ".git"].includes(entry.name) ||
        (entry.name === "dist" && ["app", "sdk"].includes(directory))
      )
        continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await addLintInputs(file);
      else if (
        entry.isSymbolicLink() ||
        /\.(?:[cm]?[jt]s|tsx|jsx)$/u.test(file)
      )
        files.add(file);
    }
  }
  for (const pkg of dir === "app" ? ["app", "sdk"] : ["sdk"])
    await addLintInputs(pkg);

  const changed = [];
  for (const file of [...files].sort()) {
    if (bootstrapSetupFiles.has(file) || /^docs\/.*\.md$/u.test(file)) continue;
    let current;
    let present = false;
    try {
      const target = path.join(repository, file);
      const info = await lstat(target);
      present = true;
      if (info.isFile()) current = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const before = baseFiles.has(file)
      ? git(["show", `${commit}:${file}`])
      : null;
    if (!present && !before) continue;
    if (current && before) {
      if (current.equals(before)) continue;
      if (/^(?:(?:app|sdk)\/)?package\.json$/u.test(file)) {
        const metadata = (bytes) => {
          const data = JSON.parse(bytes.toString("utf8"));
          delete data.scripts;
          return data;
        };
        if (isDeepStrictEqual(metadata(current), metadata(before))) continue;
      }
    }
    changed.push(file);
  }
  if (changed.length)
    throw new Error(
      `Bootstrap setup PR must not change sources; only lint setup, package.json scripts, CI and docs may differ:\n${changed.join("\n")}`,
    );
}

export function collectFindings(results, root) {
  const pairs = new Map();
  for (const result of results) {
    const file = path.relative(root, result.filePath).split(path.sep).join("/");
    for (const message of result.messages) {
      // Inline overrides and disable comments produce ruleless diagnostics
      // with noInlineConfig. They must never become debt allowances.
      if (
        message.fatal ||
        !message.ruleId ||
        message.severity !== 2 ||
        protectedRules.has(message.ruleId)
      ) {
        throw new Error(`${file}:${message.line}: ${message.message}`);
      }
      const pair = `${file}\0${message.ruleId}`;
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
  }
  return pairs;
}

export function serializePairs(pairs) {
  const files = new Map();
  for (const [pair, count] of [...pairs].sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    const [file, rule] = pair.split("\0");
    if (!files.has(file)) files.set(file, new Map());
    files.get(file).set(rule, { count });
  }
  return Object.fromEntries(
    [...files].map(([file, rules]) => [file, Object.fromEntries(rules)]),
  );
}

export async function lintPackage(root) {
  const require = createRequire(path.join(root, "package.json"));
  const { ESLint } = require("eslint");
  // Scan current sources once, bypassing bulk suppressions.
  const eslint = new ESLint({
    cwd: root,
    applySuppressions: false,
    overrideConfigFile: path.join(root, "eslint.config.js"),
    overrideConfig: [
      suppressionGuard,
      {
        files: ["**/*.{ts,tsx,mts,cts}"],
        languageOptions: { parserOptions: { tsconfigRootDir: root } },
      },
    ],
  });
  return collectFindings(await eslint.lintFiles(["."]), root);
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      "base-ref": { type: "string", default: "origin/main" },
      dir: { type: "string" },
    },
  });
  if (!["app", "sdk"].includes(values.dir))
    throw new Error("--dir must be app or sdk");
  if (!values["base-ref"].trim())
    throw new Error("--base-ref must be a Git ref");
  const root = path.join(repository, values.dir);
  const file = `${values.dir}/eslint-ratchet.json`;
  const ledgerPath = path.join(repository, file);
  const source = await readFile(ledgerPath, "utf8");
  const previous = collectPairs(JSON.parse(source));
  const git = (args) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" });
  const commit = git([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values["base-ref"]}^{commit}`,
  ]).trim();
  const exists = git(["ls-tree", "--name-only", commit, "--", file]).trim();
  if (exists) {
    // Historical data is parsed as JSON; historical code is never executed.
    const baseline = collectPairs(
      JSON.parse(git(["show", `${commit}:${file}`])),
    );
    assertNoGrowth(
      previous,
      baseline,
      `against ${values["base-ref"]} (${commit})`,
    );
  } else if (commit !== migrationBase) {
    throw new Error(
      `Missing ${file} at base ${commit}; only the initial migration may add a ledger`,
    );
  } else {
    await assertBootstrapSources(commit, values.dir);
    console.log(`lint-ratchet: bootstrap sources equal ${commit}`);
  }

  const require = createRequire(path.join(root, "package.json"));
  const { format, resolveConfig } = require("prettier");
  const current = await lintPackage(root);
  if (!exists) assertExactFindings(previous, current);
  assertNoGrowth(current, previous, "against the working ledger");
  const data = serializePairs(current);
  const canonical = await format(JSON.stringify(data), {
    ...(await resolveConfig(ledgerPath)),
    filepath: ledgerPath,
  });
  if (values.check && source !== canonical) {
    throw new Error(
      "Ratchet has stale allowances or noncanonical data; run npm run lint:ratchet:update",
    );
  }
  if (!values.check && source !== canonical)
    await writeFile(ledgerPath, canonical);
  const reports = [...current.values()].reduce(
    (total, count) => total + count,
    0,
  );
  console.log(
    `lint-ratchet: OK (${current.size} pairs, ${Object.keys(data).length} files, ${reports} findings; base ${commit})`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(`lint-ratchet: ${error.message}`);
    process.exitCode = 1;
  }
}
