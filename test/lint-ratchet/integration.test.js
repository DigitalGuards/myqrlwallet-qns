const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
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

// Freeze sources at the first ledger revision so later debt fixes can still
// exercise bootstrap. Overlay current lint tooling without executing historical
// configuration. Git history and installed dependencies stay read-only.
async function fixture(t, pkg) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "qns ratchet test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const withLedger = git([
    "rev-list",
    "--reverse",
    "HEAD",
    "--",
    `${pkg}/eslint-ratchet.json`,
  ]).split("\n")[0];
  assert.ok(withLedger, "the integration fixture needs a historical ledger");
  const files = git(["ls-tree", "-r", "--name-only", "-z", withLedger])
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(directory, file)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(directory, file),
      execFileSync("git", ["show", `${withLedger}:${file}`], {
        cwd: repository,
      }),
    );
  }
  for (const file of [
    "scripts/lint-ratchet.mjs",
    "scripts/eslint-policy.mjs",
    ...["app", "sdk"].flatMap((name) =>
      ["eslint.config.js", "tsconfig.json", "tsconfig.eslint.json"].map(
        (file) => `${name}/${file}`,
      ),
    ),
  ])
    await fs.copyFile(path.join(repository, file), path.join(directory, file));
  for (const name of ["app", "sdk"]) {
    const target = path.join(directory, name, "package.json");
    const originalPackage = JSON.parse(await fs.readFile(target, "utf8"));
    const currentPackage = JSON.parse(
      await fs.readFile(path.join(repository, name, "package.json"), "utf8"),
    );
    originalPackage.scripts = currentPackage.scripts;
    await fs.writeFile(target, JSON.stringify(originalPackage));
  }
  await fs.writeFile(
    path.join(directory, ".git"),
    `gitdir: ${git(["rev-parse", "--absolute-git-dir"])}\n`,
  );
  const root = path.join(directory, pkg);
  for (const name of pkg === "app" ? ["app", "sdk"] : ["sdk"]) {
    // Actual node_modules directories match Git's directory ignore patterns.
    // All installed dependency entries remain read-only symlinks.
    const modules = path.join(directory, name, "node_modules");
    await fs.mkdir(modules);
    if (name === "app") {
      // The rename regression must resolve the fixture's rebuilt SDK.
      await fs.mkdir(path.join(modules, "@qns"));
      await fs.symlink(
        path.join(directory, "sdk"),
        path.join(modules, "@qns/sdk"),
        "dir",
      );
    }
    for (const dependency of await fs.readdir(
      path.join(repository, name, "node_modules"),
    )) {
      if (name === "app" && dependency === "@qns") continue;
      await fs.symlink(
        path.join(repository, name, "node_modules", dependency),
        path.join(modules, dependency),
      );
    }
  }
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
    return output;
  }
  function check(base, code = 0, pattern) {
    return run(
      ["run", "lint:ratchet", "--", "--base-ref", base],
      code,
      pattern,
    );
  }
  const mutations = new Map();
  async function write(file, content) {
    const target = path.join(directory, file);
    if (!mutations.has(file)) {
      try {
        mutations.set(file, await fs.readFile(target));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        mutations.set(file, null);
      }
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (content === null) await fs.rm(target);
    else await fs.writeFile(target, content);
  }
  async function edit(file, transform) {
    await write(
      file,
      transform(await fs.readFile(path.join(directory, file), "utf8")),
    );
  }
  async function ledger(data, name = pkg) {
    const target = path.join(directory, name, "eslint-ratchet.json");
    const canonical = serializePairs(collectPairs(data));
    await write(
      `${name}/eslint-ratchet.json`,
      await format(JSON.stringify(canonical), {
        ...(await resolveConfig(target)),
        filepath: target,
      }),
    );
  }
  async function restore() {
    const rebuild = pkg === "app" && mutations.has("sdk/src/index.ts");
    for (const [file, before] of mutations) {
      const target = path.join(directory, file);
      if (before === null) await fs.rm(target, { force: true });
      else await fs.writeFile(target, before);
    }
    mutations.clear();
    await fs.writeFile(ledgerPath, original);
    await fs.rm(path.join(root, "src/review-bypass.ts"), { force: true });
    await fs.rm(path.join(root, "eslint-suppressions.json"), { force: true });
    if (rebuild) run(["--prefix", "../sdk", "run", "build"], 0);
  }
  if (pkg === "app") run(["--prefix", "../sdk", "run", "build"], 0);
  return {
    directory,
    root,
    ledgerPath,
    original,
    withLedger,
    run,
    check,
    ledger,
    write,
    edit,
    restore,
  };
}

for (const pkg of packages) {
  test(`${pkg} lint ratchet integration`, async (t) => {
    const f = await fixture(t, pkg);
    t.beforeEach(f.restore);
    t.afterEach(f.restore);
    const { withLedger } = f;
    const probe = path.join(f.root, "src/review-bypass.ts");
    const newPair = JSON.parse(f.original);
    newPair["src/review-bypass.ts"] = { [anyRule]: { count: 1 } };

    await t.test(
      "unchanged manifests pass bootstrap and a base with a ledger",
      () => {
        f.check(migrationBase, 0, /bootstrap sources equal/u);
        assert.doesNotMatch(f.check(withLedger), /bootstrap sources equal/u);
      },
    );

    await t.test(
      "new any without an allowance fails checks and regeneration",
      async () => {
        await fs.writeFile(probe, "export type ReviewEscape = any;\n");
        f.check(migrationBase, 1, /setup PR must not change sources/u);
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
          /setup PR must not change sources[\s\S]*src\/review-bypass\.ts/u,
        );
        f.check(withLedger, 1, /0 -> 1/u);
        const before = await fs.readFile(f.ledgerPath, "utf8");
        f.run(
          ["run", "lint:ratchet:update", "--", "--base-ref", migrationBase],
          1,
          /setup PR must not change sources/u,
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
          f.check(migrationBase, 1, /setup PR must not change sources/u);
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
          f.check(migrationBase, 1, /setup PR must not change sources/u);
          f.check(withLedger, 1, /no-unsafe-assignment: 0 -> 1/u);
        } finally {
          await fs.writeFile(target, before);
        }
      },
    );

    await t.test(
      "round 2 SDK rename plus app allowance fails bootstrap",
      async () => {
        await f.edit("sdk/src/index.ts", (source) => {
          assert.match(source, /export \{ parseNetworkConfig,/u);
          return source.replace(
            "export { parseNetworkConfig,",
            "export { parseNetworkConfig as parseConfiguration,",
          );
        });
        for (const file of ["app/src/rpc.ts", "app/vite.config.ts"])
          await f.edit(file, (source) =>
            source.replaceAll("parseNetworkConfig", "parseConfiguration"),
          );
        await f.edit(
          "app/vite.config.ts",
          (source) =>
            `${source}\nexport function reviewUnsafeCall(): void {\n  JSON.parse("null")();\n}\n`,
        );
        const data = JSON.parse(
          await fs.readFile(
            path.join(f.directory, "app/eslint-ratchet.json"),
            "utf8",
          ),
        );
        data["vite.config.ts"] = {
          "@typescript-eslint/no-unsafe-call": { count: 1 },
        };
        await f.ledger(data, "app");
        // Reject the exact review patch before consulting any SDK build.
        f.check(
          migrationBase,
          1,
          /setup PR must not change sources[\s\S]*sdk\/src\/index\.ts/u,
        );
        if (pkg === "app") {
          // Complete the rename for the namespace import in this test too,
          // then prove even lint-clean source plus an allowance is rejected.
          await f.edit("app/src/App.name-state.test.tsx", (source) =>
            source.replaceAll("parseNetworkConfig", "parseConfiguration"),
          );
          f.run(["--prefix", "../sdk", "run", "build"], 0);
        }
        f.run(["run", "lint"], 0);
        f.check(
          migrationBase,
          1,
          /setup PR must not change sources[\s\S]*sdk\/src\/index\.ts/u,
        );
      },
    );

    await t.test(
      "a dependency-only source change fails bootstrap",
      async () => {
        await f.edit(
          "sdk/src/index.ts",
          (source) => `${source}\n// Source identity probe.\n`,
        );
        f.check(
          migrationBase,
          1,
          /setup PR must not change sources[\s\S]*sdk\/src\/index\.ts/u,
        );
      },
    );

    for (const [label, transform] of [
      [
        "raised count",
        (data, file, rule) => {
          data[file][rule].count++;
        },
      ],
      [
        "lowered count",
        (data, file, rule) => {
          data[file][rule].count--;
        },
      ],
      [
        "missing pair",
        (data, file, rule) => {
          delete data[file][rule];
          if (!Object.keys(data[file]).length) delete data[file];
        },
      ],
      [
        "extra pair",
        (data, file) => {
          data[file][anyRule] = { count: 1 };
        },
      ],
    ]) {
      await t.test(
        `bootstrap rejects ${label} without changing source`,
        async () => {
          const data = JSON.parse(f.original);
          const [file, rules] = Object.entries(data).find(([, rules]) =>
            Object.values(rules).some(({ count }) => count > 1),
          );
          const [rule] = Object.entries(rules).find(
            ([, { count }]) => count > 1,
          );
          transform(data, file, rule);
          await f.ledger(data);
          const before = await fs.readFile(f.ledgerPath, "utf8");
          f.check(
            migrationBase,
            1,
            /Bootstrap manifest must equal current findings exactly/u,
          );
          f.run(
            ["run", "lint:ratchet:update", "--", "--base-ref", migrationBase],
            1,
            /Bootstrap manifest must equal current findings exactly/u,
          );
          assert.equal(await fs.readFile(f.ledgerPath, "utf8"), before);
        },
      );
    }

    await t.test(
      "bootstrap permits setup and script changes with an exact manifest",
      async () => {
        await f.edit(
          `${pkg}/eslint.config.js`,
          (source) => `${source}\n// Setup configuration probe.\n`,
        );
        await f.edit(`${pkg}/tsconfig.eslint.json`, (source) => `${source}\n`);
        await f.edit(`${pkg}/tsconfig.json`, (source) => `${source}\n`);
        await f.edit(`${pkg}/package.json`, (source) => {
          const data = JSON.parse(source);
          data.scripts["ratchet:probe"] = "node --version";
          return JSON.stringify(data);
        });
        await f.edit(
          "scripts/eslint-policy.mjs",
          (source) => `${source}\n// Setup policy probe.\n`,
        );
        await f.edit(
          ".github/workflows/ci.yml",
          (source) => `${source}\n# Setup CI probe.\n`,
        );
        await f.write("docs/ratchet-probe.md", "Lint setup documentation.\n");
        f.check(migrationBase, 0, /bootstrap sources equal/u);
      },
    );

    await t.test(
      "bootstrap rejects package metadata and lockfile changes",
      async () => {
        await f.edit(`${pkg}/package.json`, (source) => {
          const data = JSON.parse(source);
          data.dependencies["ratchet-probe"] = "1.0.0";
          return JSON.stringify(data);
        });
        f.check(
          migrationBase,
          1,
          /setup PR must not change sources[\s\S]*package\.json/u,
        );
        await f.restore();
        await f.edit(`${pkg}/package-lock.json`, (source) => `${source}\n`);
        f.check(
          migrationBase,
          1,
          /setup PR must not change sources[\s\S]*package-lock\.json/u,
        );
      },
    );

    await t.test(
      "bootstrap rejects deleted, renamed, ignored, hidden and symlinked sources",
      async () => {
        const file = `${pkg}/src/index.ts`;
        const source = await fs
          .readFile(path.join(f.directory, file), "utf8")
          .catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          });
        const existing = source === null ? `${pkg}/src/main.tsx` : file;
        const before = await fs.readFile(
          path.join(f.directory, existing),
          "utf8",
        );
        await f.write(existing, null);
        f.check(migrationBase, 1, /setup PR must not change sources/u);
        await f.write(`${pkg}/src/renamed-probe.ts`, before);
        f.check(
          migrationBase,
          1,
          /setup PR must not change sources[\s\S]*renamed-probe\.ts/u,
        );
        await f.restore();
        for (const name of [
          ".hidden-probe.ts",
          ".env.probe.ts",
          "nested/dist/probe.ts",
        ]) {
          await f.write(`${pkg}/${name}`, "export const reviewValue = 1;\n");
          const output = f.check(
            migrationBase,
            1,
            /setup PR must not change sources/u,
          );
          assert.ok(output.includes(`${pkg}/${name}`), output);
          await f.restore();
        }
        for (const [name, target] of [
          ["linked-probe.ts", existing.slice(pkg.length + 1)],
          ["linked-probe", "src"],
        ]) {
          await f.write(`${pkg}/${name}`, "");
          await fs.rm(path.join(f.root, name));
          await fs.symlink(target, path.join(f.root, name));
          const output = f.check(
            migrationBase,
            1,
            /setup PR must not change sources/u,
          );
          assert.ok(output.includes(`${pkg}/${name}`), output);
          await f.restore();
        }
      },
    );

    await t.test(
      "a base with a manifest permits fixes and removes stale allowances",
      async () => {
        const file = pkg === "app" ? "src/wallet.ts" : "src/registration.ts";
        const [before, after] =
          pkg === "app"
            ? ["Array<() => void>", "(() => void)[]"]
            : [
                "ReadonlyArray<{ step: RegistrationStep; required: boolean }>",
                "readonly { step: RegistrationStep; required: boolean }[]",
              ];
        await f.edit(`${pkg}/${file}`, (source) => {
          assert.ok(source.includes(before));
          return source.replace(before, after);
        });
        f.check(withLedger, 1, /stale allowances/u);
        f.run(
          ["run", "lint:ratchet:update", "--", "--base-ref", withLedger],
          0,
          /lint-ratchet: OK/u,
        );
        const data = JSON.parse(f.original);
        delete data[file][arrayRule];
        if (!Object.keys(data[file]).length) delete data[file];
        assert.deepEqual(
          JSON.parse(await fs.readFile(f.ledgerPath, "utf8")),
          data,
        );
        f.check(withLedger, 0, /lint-ratchet: OK/u);
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
      "repeated current scans cover typed source, tests and scripts",
      async () => {
        const root = path.join(f.directory, "lint-probe");
        const sources = {
          "package.json": '{"type":"module"}\n',
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
        for (const file of [
          "eslint.config.js",
          "tsconfig.json",
          "tsconfig.eslint.json",
        ])
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
        assert.deepEqual(await lintPackage(root), expected);
        assert.deepEqual(await lintPackage(root), expected);
      },
    );
  });
}
