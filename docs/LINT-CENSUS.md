QNS lint setup and census, 2026-10-23.

The census was taken from source revision `9e678b5eab242e550bfbb8f999668345ae0fdc11` with this lint setup applied. The original lint commands passed in both packages. Application, SDK, and existing test source files remain unchanged. These are findings from the newly enabled rules.

Both package configs apply `strictTypeChecked` and `stylisticTypeChecked` to every `**/*.{ts,tsx,mts,cts}` file. Dedicated lint TypeScript projects include package source, tests, scripts, and configuration files. Existing Prettier compatibility, JavaScript recommended rules, the SDK network-config URL global, and the stricter QNS ban on every TypeScript suppression directive are preserved.

The shared [wallet policy](../scripts/eslint-policy.mjs) adds separate type imports, the double-assertion fence, console restrictions, explicit floating-promise enforcement, and the historical inner-declaration and constant-loop checks. Type assertions are forbidden, with the standard `as const` allowance. Number interpolation remains allowed. The global comment guard uses `no-warning-comments` with `terms: ["@ts-nocheck"]`, `location: "start"`, and `decoration: ["/"]`; [ESLint matches terms without regard to letter case](https://eslint.org/docs/latest/rules/no-warning-comments#options). Inline ESLint configuration is disabled and reported. No dependencies or lockfiles changed.

Each package has one `eslint-ratchet.json`, consumed by `npm run lint` through the explicit `--suppressions-location` option. There are no rule-off debt overrides or second allowance file. The shared [ratchet checker](../scripts/lint-ratchet.mjs) rescans the same files with `applySuppressions: false`, sets `TSESTREE_SINGLE_RUN=false`, and compares exact file/rule counts against both the working ledger and a Git base. Directive findings, ruleless diagnostics, warnings, and parser failures cannot become allowances. Alternate bulk-suppression files cannot hide findings from this scan.

`npm run lint:ratchet` defaults to `origin/main`. Pass `-- --base-ref <ref>` to select a base. Pair additions and count increases fail. Stale entries or counts also fail the check. After fixing debt, `npm run lint:ratchet:update` can only lower counts and remove resolved pairs; it refuses new debt. Historical ledgers are parsed as JSON without executing historical code. The initial migration allows a missing base ledger only at the pinned source revision above; subsequent bases must contain the ledger, including an empty `{}` after completion.

The existing `app` and `sdk` CI jobs retain their names, fetch full history, and explicitly run lint, the ratchet, and typecheck before tests. Pull requests pass `github.event.pull_request.base.sha` to the checker; main pushes use `github.event.before`. The existing format, build, and test gates remain in place.

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

Local validation used Node `v22.22.3` and npm `10.9.8`. Every requested gate passed. The ratchet also passed with `CI=true` and an explicit `--base-ref origin/main`, resolving to the source revision recorded above.

| Command                | app exit code | sdk exit code |
| ---------------------- | ------------: | ------------: |
| `npm ci`               |             0 |             0 |
| `npm run format:check` |             0 |             0 |
| `npm run lint`         |             0 |             0 |
| `npm run lint:ratchet` |             0 |             0 |
| `npm run typecheck`    |             0 |             0 |
| `npm test`             |             0 |             0 |
| `npm run build`        |             0 |             0 |

App tests: 29 files and 19,256 tests passed. SDK tests: 14 files and 271 tests passed. The new `node --test test/scripts/lint-ratchet.test.js` regression suite passed all 9 tests with exit code 0 and runs in the existing CI scripts job. Twelve additional integration checks passed with exit code 0 across the two installed package toolchains: typed coverage outside source directories, repeated CI parses, alternate suppression files, count growth within a pair, inline and TypeScript directives, and CLI refusal to regenerate new debt. Temporary probe files were removed.

The final diff contains lint setup, the census, CI wiring, and ratchet regression tests. Application and SDK source, existing tests, dependency metadata, and lockfiles are unchanged. No commit or push was made.
