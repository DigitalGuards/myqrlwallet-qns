QNS lint setup and census, 2026-10-23.

The census was taken from source revision `9e678b5eab242e550bfbb8f999668345ae0fdc11` with this lint setup applied. The original lint commands passed in both packages. Application, SDK, and existing test source files remain unchanged. These are findings from the newly enabled rules.

Both package configs apply `strictTypeChecked` and `stylisticTypeChecked` to every `**/*.{ts,tsx,mts,cts}` file. Dedicated lint TypeScript projects include package source, tests, scripts, and configuration files. Existing Prettier compatibility, JavaScript recommended rules, the SDK network-config URL global, and the stricter QNS ban on every TypeScript suppression directive are preserved.

The shared [wallet policy](../scripts/eslint-policy.mjs) adds separate type imports, the double-assertion fence, console restrictions, explicit floating-promise enforcement, and the historical inner-declaration and constant-loop checks. Type assertions are forbidden, with the standard `as const` allowance. Number interpolation remains allowed. The global comment guard uses `no-warning-comments` with `terms: ["@ts-nocheck"]`, `location: "start"`, and `decoration: ["/"]`; [ESLint matches terms without regard to letter case](https://eslint.org/docs/latest/rules/no-warning-comments#options). Inline ESLint configuration is disabled and reported. No dependencies or lockfiles changed.

Each package has one `eslint-ratchet.json`, consumed by `npm run lint` through the explicit `--suppressions-location` option. There are no rule-off debt overrides or second allowance file. The shared [ratchet checker](../scripts/lint-ratchet.mjs) rescans the same files with `applySuppressions: false`, sets `TSESTREE_SINGLE_RUN=false`, and compares exact file/rule counts against both the working ledger and a Git base. Directive findings, ruleless diagnostics, warnings, and parser failures cannot become allowances. Alternate bulk-suppression files cannot hide findings from this scan.

`npm run lint:ratchet` defaults to `origin/main`. Pass `-- --base-ref <ref>` to select a base. Pair additions and count increases fail. Stale entries or counts also fail the check. After fixing debt, `npm run lint:ratchet:update` can only lower counts and remove resolved pairs; it refuses new debt. Historical ledgers are parsed as JSON without executing historical code.

The initial migration allows a missing base ledger only at the pinned source revision above. Before linting, the checker compares base Git blobs with working file bytes across the setup PR, including the app and its local SDK dependency. Source additions, edits, deletions, renames and symlinks fail with `Bootstrap setup PR must not change sources`. The comparison covers tracked and untracked files; an additional walk covers Git-ignored JavaScript and TypeScript lint inputs in the selected package and, for the app, the SDK. Installed `node_modules` and generated package-root `dist` directories are excluded from that walk. Source files under nested directories named `dist` remain protected.

Bootstrap permits differences only in these setup files:

- `app/` and `sdk/`: `eslint.config.js`, `eslint-ratchet.json`, `tsconfig.json`, `tsconfig.eslint.json`, and `README.md`.
- Root, app and SDK `package.json`: only the `scripts` member may change. All other parsed metadata must match the base; lockfiles must remain byte-identical.
- `scripts/eslint-policy.mjs`, `scripts/lint-ratchet.mjs`, `test/scripts/lint-ratchet.test.js`, and `test/lint-ratchet/integration.test.js`.
- `.github/workflows/ci.yml`, root `README.md`, and Markdown files below `docs/`.

After source equality passes, one scan of the current package must match its manifest exactly: every file/rule pair and count, with no extra or missing pair and no raised or lowered count. This also applies to the update command, before any manifest write. Equal sources make these the base source findings under the new configuration. There is no archive export or second lint scan. Bases with an existing ledger retain the prior rules: allowances can only shrink, current findings must fit the working ledger, and update removes stale allowances. Subsequent bases must contain the ledger, including an empty `{}` after completion.

The existing `app` and `sdk` CI jobs retain their names, fetch full history, and explicitly run lint, the ratchet, and typecheck before tests. Pull requests pass `github.event.pull_request.base.sha` to the checker; main pushes use `github.event.before`. Each package job also runs `test/lint-ratchet/integration.test.js` with `LINT_RATCHET_TEST_PACKAGE` set to its package name. The existing format, build, and test gates remain in place.

| Package | Findings | Exact file/rule pairs | Files with debt |
| ------- | -------: | --------------------: | --------------: |
| app     |       41 |                    31 |              23 |
| sdk     |       16 |                    12 |              10 |

All rule names below have the `@typescript-eslint/` prefix.

| Rule                        | app | sdk |
| --------------------------- | --: | --: |
| `no-empty-function`         |  18 |   7 |
| `array-type`                |  12 |   8 |
| `consistent-type-imports`   |   5 |   0 |
| `prefer-nullish-coalescing` |   3 |   0 |
| `prefer-optional-chain`     |   3 |   0 |
| `prefer-regexp-exec`        |   0 |   1 |

The complete file census is sorted by finding count. Paths are relative to each package. The slice column assigns every finding-bearing file exactly once.

| Package | File                                   | Findings | Slice |
| ------- | -------------------------------------- | -------: | ----- |
| app     | `src/App.tsx`                          |        7 | A1    |
| app     | `src/App.round8-regressions.test.tsx`  |        3 | A2    |
| app     | `src/wallet-transitions.test.ts`       |        3 | A1    |
| app     | `src/wallet.ts`                        |        3 | A1    |
| app     | `src/App.async-isolation.test.tsx`     |        2 | A2    |
| app     | `src/App.claim-ux.test.tsx`            |        2 | A2    |
| app     | `src/App.round3-regressions.test.tsx`  |        2 | A2    |
| app     | `src/App.round5-regressions.test.tsx`  |        2 | A2    |
| app     | `src/App.test.tsx`                     |        2 | A2    |
| app     | `src/wallet.test.ts`                   |        2 | A1    |
| app     | `src/App.recovery-property.test.tsx`   |        1 | A2    |
| app     | `src/App.recovery-settlement.test.tsx` |        1 | A2    |
| app     | `src/App.review-regressions.test.tsx`  |        1 | A2    |
| app     | `src/App.round2-regressions.test.tsx`  |        1 | A2    |
| app     | `src/App.round4-regressions.test.tsx`  |        1 | A2    |
| app     | `src/App.round7-regressions.test.tsx`  |        1 | A2    |
| app     | `src/App.settlement.test.tsx`          |        1 | A2    |
| app     | `src/registration-wallets.test.ts`     |        1 | A1    |
| app     | `src/relay-behavior.test.ts`           |        1 | A2    |
| app     | `src/relay-retry-sdk.test.ts`          |        1 | A1    |
| app     | `src/wallet-cancellation.test.ts`      |        1 | A1    |
| app     | `src/wallet-extension.test.ts`         |        1 | A1    |
| app     | `src/wallet-recovery.test.tsx`         |        1 | A1    |
| sdk     | `src/registration-repairs.test.ts`     |        5 | S1    |
| sdk     | `src/registration-guards.test.ts`      |        2 | S1    |
| sdk     | `src/resolver.test.ts`                 |        2 | S1    |
| sdk     | `src/__tests__/mockProvider.ts`        |        1 | S1    |
| sdk     | `src/owned.test.ts`                    |        1 | S1    |
| sdk     | `src/owned.ts`                         |        1 | S1    |
| sdk     | `src/record-recovery.test.ts`          |        1 | S1    |
| sdk     | `src/recovery.test.ts`                 |        1 | S1    |
| sdk     | `src/registration-read-errors.test.ts` |        1 | S1    |
| sdk     | `src/registration.ts`                  |        1 | S1    |

The proposed cleanup slices are independent. Each slice should rerun the package gates and regenerate its ledger after fixing its assigned files. The SDK has fewer than 20 findings in total, so its final slice is smaller than the usual target.

| Slice | Scope                                                  | Files | Findings |
| ----- | ------------------------------------------------------ | ----: | -------: |
| A1    | App runtime, wallet interactions, and related fixtures |     9 |       20 |
| A2    | App component regressions and relay behavior           |    14 |       21 |
| S1    | All remaining SDK debt                                 |    10 |       16 |

This is a counted ratchet: CI rejects new file/rule pairs and increases within an existing pair. A replacement finding in the same pair with an equal or lower count requires code review. An empty ledger gives full enforcement without allowances.

Source-equality validation used `CI=true`, Node `v20.20.2` for the SDK, Node `v22.22.3` for the app, and npm `10.9.8`. Package gates ran sequentially in fresh processes using the installed dependencies. The explicit `--base-ref origin/main` resolved to the pinned source revision above. Every gate below exited 0.

| Command                                          | app exit code | sdk exit code |
| ------------------------------------------------ | ------------: | ------------: |
| `npm run format:check`                           |             0 |             0 |
| `npm run lint`                                   |             0 |             0 |
| `npm run lint:ratchet -- --base-ref origin/main` |             0 |             0 |
| `npm run typecheck`                              |             0 |             0 |
| `npm run test`                                   |             0 |             0 |
| `npm run build`                                  |             0 |             0 |
| Ratchet unit tests                               |             0 |             0 |
| Ratchet integration tests                        |             0 |             0 |

The manifests remain byte-for-byte unchanged at 41 app findings and 16 SDK findings.

App tests: 29 files and 19,256 tests passed. SDK tests: 14 files and 271 tests passed. `node --test test/scripts/lint-ratchet.test.js` passed all 10 tests under both Node versions, covering manifest validation, pair counts, exact bootstrap equality, non-growth, diagnostics and canonical serialization. It runs in the existing CI scripts job.

`node --test test/lint-ratchet/integration.test.js` runs both installed packages by default; CI selects each package with `LINT_RATCHET_TEST_PACKAGE`. The fixtures freeze source and manifests at the first ledger revision and overlay current lint tooling, so later debt fixes can still exercise bootstrap. All mutations stay in temporary fixtures with read-only Git history and installed dependencies. The app resolves `@qns/sdk` to its fixture's own rebuilt SDK.

Each package exercises unchanged sources with an exact manifest; the round 2 SDK export rename plus an app unsafe-call allowance; a dependency-only source change; new `any` and typed unsafe assignment with allowances; raised and lowered counts, extra and missing pairs in both check and update modes; allowed setup changes; rejected dependency metadata and lockfile changes; deleted, renamed, hidden, ignored, nested and symlinked source files; and existing-ledger growth rejection, debt fixes and regeneration. The suite retains alternate suppression, directive, inline override and repeated typed scan coverage. The rename case first rejects the exact review patch, then completes the app namespace-import rename and rebuilds the fixture SDK, confirming that ordinary lint passes while bootstrap still rejects the changed sources.

Both final integration runs passed all 20 scenarios (21 node:test results including the enclosing test), with exit code 0. Measured command durations were 199.83 seconds for the app and 165.06 seconds for the SDK. Earlier fixture failures were corrected before these full reruns. Tooling formatting and `git diff --check` also exited 0.

The source-equality fix changes the shared checker, its unit and integration tests, and this census. Existing CI jobs already run both integration selections and the unit suite. Application and SDK source, package metadata, and lockfiles are unchanged. Changes remain uncommitted.
