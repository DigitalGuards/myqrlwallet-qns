const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repository = path.resolve(__dirname, "../..");
const migrationBase = "9e678b5eab242e550bfbb8f999668345ae0fdc11";
const anyRule = "@typescript-eslint/no-explicit-any";
const arrayRule = "@typescript-eslint/array-type";
const selectedPackage = process.env.LINT_RATCHET_TEST_PACKAGE;
assert.ok(!selectedPackage || ["app", "sdk"].includes(selectedPackage));
const packages = selectedPackage ? [selectedPackage] : ["app", "sdk"];
const git = (args) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

// These fixtures share read-only Git history and installed dependencies. All
// source/ledger mutations and bootstrap exports stay in temporary directories.
async function fixture(t, pkg) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "qns ratchet test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageSources = pkg === "app" ? ["app", "sdk"] : ["sdk"];
  const files = git([
    "ls-files",
    "-z",
    "--",
    ...packageSources,
    "scripts/lint-ratchet.mjs",
    "scripts/eslint-policy.mjs",
  ])
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(directory, file)), {
      recursive: true,
    });
    await fs.copyFile(path.join(repository, file), path.join(directory, file));
  }
  await fs.writeFile(
    path.join(directory, ".git"),
    `gitdir: ${git(["rev-parse", "--absolute-git-dir"])}\n`,
  );
  const root = path.join(directory, pkg);
  for (const name of packageSources)
    await fs.symlink(
      path.join(repository, name, "node_modules"),
      path.join(directory, name, "node_modules"),
      "dir",
    );
  const temporary = path.join(directory, "tmp");
  await fs.mkdir(temporary);
  const ledgerPath = path.join(root, "eslint-ratchet.json");
  const original = await fs.readFile(ledgerPath, "utf8");
  const requirePackage = createRequire(path.join(root, "package.json"));
  const { format, resolveConfig } = requirePackage("prettier");
  const { collectPairs, serializePairs } =
    await import("../../scripts/lint-ratchet.mjs");
  const env = {
    ...process.env,
    CI: "true",
    // Each child must override a conflicting inherited single-run setting.
    TSESTREE_SINGLE_RUN: "true",
    TMPDIR: temporary,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
  };
  function run(args, code, pattern) {
    const result = spawnSync("npm", args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, code, output);
    if (pattern) assert.match(output, pattern);
    assert.deepEqual(
      readdirSync(temporary).filter((name) =>
        name.startsWith("qns-lint-base-"),
      ),
      [],
      "bootstrap exports must be removed",
    );
    return output;
  }
  function check(base, code = 0, pattern) {
    return run(
      ["run", "lint:ratchet", "--", "--base-ref", base],
      code,
      pattern,
    );
  }
  async function ledger(data) {
    const canonical = serializePairs(collectPairs(data));
    await fs.writeFile(
      ledgerPath,
      await format(JSON.stringify(canonical), {
        ...(await resolveConfig(ledgerPath)),
        filepath: ledgerPath,
      }),
    );
  }
  async function restore() {
    await fs.writeFile(ledgerPath, original);
    await fs.rm(path.join(root, "src/review-bypass.ts"), { force: true });
    await fs.rm(path.join(root, "eslint-suppressions.json"), { force: true });
  }
  return { directory, root, ledgerPath, original, run, check, ledger, restore };
}

for (const pkg of packages) {
  test(`${pkg} lint ratchet integration`, async (t) => {
    const f = await fixture(t, pkg);
    t.beforeEach(f.restore);
    t.afterEach(f.restore);
    const withLedger = git(["rev-parse", "HEAD"]);
    const probe = path.join(f.root, "src/review-bypass.ts");
    const newPair = JSON.parse(f.original);
    newPair["src/review-bypass.ts"] = { [anyRule]: { count: 1 } };

    await t.test(
      "unchanged manifests pass bootstrap and a base with a ledger",
      () => {
        f.check(migrationBase, 0, /initial migration baseline/u);
        assert.doesNotMatch(f.check(withLedger), /initial migration baseline/u);
      },
    );

    await t.test(
      "new any without an allowance fails checks and regeneration",
      async () => {
        await fs.writeFile(probe, "export type ReviewEscape = any;\n");
        f.check(migrationBase, 1, /against the working ledger/u);
        f.run(
          ["run", "lint:ratchet:update", "--", "--base-ref", withLedger],
          1,
          /0 -> 1/u,
        );
        assert.equal(await fs.readFile(f.ledgerPath, "utf8"), f.original);
      },
    );

    await t.test(
      "new any plus its allowance fails bootstrap and existing-ledger checks",
      async () => {
        await fs.writeFile(probe, "export type ReviewEscape = any;\n");
        await f.ledger(newPair);
        f.run(["run", "lint"], 0);
        f.check(
          migrationBase,
          1,
          /against base sources[\s\S]*src\/review-bypass\.ts: @typescript-eslint\/no-explicit-any: 0 -> 1/u,
        );
        f.check(withLedger, 1, /0 -> 1/u);
        const before = await fs.readFile(f.ledgerPath, "utf8");
        f.run(
          ["run", "lint:ratchet:update", "--", "--base-ref", migrationBase],
          1,
          /against base sources/u,
        );
        assert.equal(await fs.readFile(f.ledgerPath, "utf8"), before);
      },
    );

    await t.test(
      "increasing an existing count from one to two fails both bases",
      async () => {
        const data = JSON.parse(f.original);
        // Both pairs have count one at the pinned migration base. Keep this
        // probe usable after the checked revision has paid down that debt.
        const file = pkg === "app" ? "src/wallet.ts" : "src/registration.ts";
        const count = data[file]?.[arrayRule]?.count ?? 0;
        assert.ok(count <= 1);
        const target = path.join(f.root, file);
        const before = await fs.readFile(target, "utf8");
        try {
          for (let index = count; index < 2; index++)
            await fs.appendFile(
              target,
              `\nexport type ReviewExtra${index} = Array<string>;\n`,
            );
          f.check(withLedger, 1, /against the working ledger[\s\S]*-> 2/u);
          data[file] ??= {};
          data[file][arrayRule] = { count: 2 };
          await f.ledger(data);
          f.run(["run", "lint"], 0);
          f.check(migrationBase, 1, /against base sources[\s\S]*1 -> 2/u);
          f.check(withLedger, 1, /-> 2/u);
        } finally {
          await fs.writeFile(target, before);
        }
      },
    );

    await t.test(
      "typed debt in an existing file cannot gain a bootstrap allowance",
      async () => {
        const file =
          pkg === "app"
            ? "src/App.async-isolation.test.tsx"
            : "src/registration.ts";
        const target = path.join(f.root, file);
        const before = await fs.readFile(target, "utf8");
        try {
          await fs.appendFile(
            target,
            '\nexport const reviewUnsafe = JSON.parse("null");\n',
          );
          const data = JSON.parse(f.original);
          data[file] ??= {};
          data[file]["@typescript-eslint/no-unsafe-assignment"] = { count: 1 };
          await f.ledger(data);
          f.run(["run", "lint"], 0);
          f.check(
            migrationBase,
            1,
            /against base sources[\s\S]*no-unsafe-assignment: 0 -> 1/u,
          );
          f.check(withLedger, 1, /no-unsafe-assignment: 0 -> 1/u);
        } finally {
          await fs.writeFile(target, before);
        }
      },
    );

    await t.test(
      "alternate bulk suppressions cannot hide new debt",
      async () => {
        await fs.writeFile(probe, "export type ReviewEscape = any;\n");
        await fs.writeFile(
          path.join(f.root, "eslint-suppressions.json"),
          JSON.stringify(newPair),
        );
        f.check(withLedger, 1, /against the working ledger[\s\S]*0 -> 1/u);
      },
    );

    for (const [label, comment, diagnostic] of [
      [
        "disable",
        "/* eslint-disable @typescript-eslint/no-explicit-any */",
        /noInlineConfig/u,
      ],
      [
        "inline override",
        '/* eslint "@typescript-eslint/no-explicit-any": "off" */',
        /noInlineConfig/u,
      ],
      ["mixed-case nocheck", "/// @Ts-NoChEcK", /@ts-nocheck/iu],
    ]) {
      await t.test(`${label} is rejected`, async () => {
        await fs.writeFile(
          probe,
          `${comment}\nexport const reviewValue = 1;\n`,
        );
        f.check(withLedger, 1, diagnostic);
      });
    }

    await t.test(
      "archived sources use current typed config across source, tests and scripts",
      async () => {
        const root = path.join(f.directory, "archived");
        const sources = {
          "package.json": '{"type":"module"}\n',
          "eslint.config.js":
            'throw new Error("Historical configuration executed");\n',
          "src/probe.ts": "export type ReviewEscape = any;\n",
          "test/probe.ts": "Promise.resolve(1);\n",
          "scripts/probe.mts": "export type ReviewExtra = Array<string>;\n",
          "scripts/probe.js":
            "export const reviewValue = missingReviewValue;\n",
        };
        for (const [file, source] of Object.entries(sources)) {
          await fs.mkdir(path.dirname(path.join(root, file)), {
            recursive: true,
          });
          await fs.writeFile(path.join(root, file), source);
        }
        for (const file of ["tsconfig.json", "tsconfig.eslint.json"])
          await fs.copyFile(path.join(f.root, file), path.join(root, file));
        await fs.symlink(
          path.join(f.root, "node_modules"),
          path.join(root, "node_modules"),
          "dir",
        );
        const { lintPackage } = await import("../../scripts/lint-ratchet.mjs");
        const expected = new Map([
          [`src/probe.ts\0${anyRule}`, 1],
          ["test/probe.ts\0@typescript-eslint/no-floating-promises", 1],
          [`scripts/probe.mts\0${arrayRule}`, 1],
          ["scripts/probe.js\0no-undef", 1],
        ]);
        assert.deepEqual(await lintPackage(root, f.root), expected);
        assert.deepEqual(await lintPackage(root, f.root), expected);
      },
    );
  });
}
