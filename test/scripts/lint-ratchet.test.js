const assert = require("node:assert/strict");
const test = require("node:test");

const ratchet = import("../../scripts/lint-ratchet.mjs");
const rule = "@typescript-eslint/consistent-type-definitions";

test("ratchet accepts exact package paths and positive counts", async () => {
  const { collectPairs } = await ratchet;
  const pairs = collectPairs({
    "src/view.tsx": { [rule]: { count: 2 } },
    "scripts/build.mts": { [rule]: { count: 1 } },
    "test/fixture.cts": { [rule]: { count: 3 } },
  });
  assert.equal(pairs.size, 3);
  assert.equal(pairs.get(`src/view.tsx\0${rule}`), 2);
  assert.equal(collectPairs({}).size, 0);
});

test("ratchet rejects globs, traversal, absolute paths and malformed allowances", async () => {
  const { collectPairs } = await ratchet;
  for (const file of [
    "src/*.ts",
    "../outside.ts",
    "/outside.ts",
    "src/../index.ts",
    "src\\index.ts",
  ]) {
    assert.throws(() => collectPairs({ [file]: { [rule]: { count: 1 } } }));
  }
  for (const count of [
    0,
    -1,
    1.5,
    "1",
    null,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() =>
      collectPairs({ "src/index.ts": { [rule]: { count } } }),
    );
  }
  for (const data of [
    null,
    [],
    { "src/index.ts": {} },
    { "src/index.ts": { [rule]: { count: 1, extra: true } } },
  ]) {
    assert.throws(() => collectPairs(data));
  }
});

test("directive guards cannot become ratchet allowances", async () => {
  const { collectPairs } = await ratchet;
  for (const guard of [
    "no-warning-comments",
    "@typescript-eslint/ban-ts-comment",
  ]) {
    assert.throws(() =>
      collectPairs({ "src/index.ts": { [guard]: { count: 1 } } }),
    );
  }
});

test("ratchet rejects growth inside an existing file and rule pair", async () => {
  const { assertNoGrowth } = await ratchet;
  assert.throws(
    () =>
      assertNoGrowth(
        new Map([["src/index.ts\0rule", 3]]),
        new Map([["src/index.ts\0rule", 2]]),
        "against base",
      ),
    /2 -> 3/u,
  );
});

test("allowances cannot move between files or rules even when totals shrink", async () => {
  const { assertNoGrowth } = await ratchet;
  const baseline = new Map([["src/index.ts\0rule", 10]]);
  for (const key of ["src/other.ts\0rule", "src/index.ts\0other-rule"]) {
    assert.throws(
      () => assertNoGrowth(new Map([[key, 1]]), baseline, "against base"),
      /0 -> 1/u,
    );
  }
});

test("ratchet allows count reductions and resolved pair removal", async () => {
  const { assertNoGrowth } = await ratchet;
  const baseline = new Map([
    ["src/index.ts\0rule", 2],
    ["src/other.ts\0rule", 1],
  ]);
  assertNoGrowth(
    new Map([["src/index.ts\0rule", 1]]),
    baseline,
    "against base",
  );
  assertNoGrowth(new Map(), baseline, "against base");
});

test("raw findings preserve per-file counts", async () => {
  const { collectFindings } = await ratchet;
  const message = { ruleId: rule, severity: 2, line: 1, message: "Finding" };
  const pairs = collectFindings(
    [
      { filePath: "/package/src/index.ts", messages: [message, message] },
      { filePath: "/package/test/index.ts", messages: [message] },
    ],
    "/package",
  );
  assert.equal(pairs.get(`src/index.ts\0${rule}`), 2);
  assert.equal(pairs.get(`test/index.ts\0${rule}`), 1);
});

test("fatal errors, inline config warnings and directives fail before counting", async () => {
  const { collectFindings } = await ratchet;
  for (const message of [
    { fatal: true, ruleId: null, severity: 2 },
    { ruleId: null, severity: 1 },
    { ruleId: rule, severity: 1 },
    { ruleId: "no-warning-comments", severity: 2 },
    { ruleId: "@typescript-eslint/ban-ts-comment", severity: 2 },
  ]) {
    assert.throws(
      () =>
        collectFindings(
          [
            {
              filePath: "/package/src/index.ts",
              messages: [{ ...message, line: 1, message: "Blocked" }],
            },
          ],
          "/package",
        ),
      /Blocked/u,
    );
  }
});

test("canonical data round trips all pair counts", async () => {
  const { collectPairs, serializePairs } = await ratchet;
  const pairs = new Map([
    ["test/z.ts\0rule-z", 1],
    ["src/a.ts\0rule-b", 2],
    ["src/a.ts\0rule-a", 3],
  ]);
  const data = serializePairs(pairs);
  assert.deepEqual(Object.keys(data), ["src/a.ts", "test/z.ts"]);
  assert.deepEqual(Object.keys(data["src/a.ts"]), ["rule-a", "rule-b"]);
  assert.deepEqual(collectPairs(data), new Map([...pairs].sort()));
});
