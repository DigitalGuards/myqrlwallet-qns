// Common wallet hardening for both QNS packages. Package rules may add coverage.
export const hardenedRules = {
  "no-inner-declarations": [
    "error",
    "functions",
    { blockScopedFunctions: "disallow" },
  ],
  "no-constant-condition": ["error", { checkLoops: true }],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/consistent-type-assertions": [
    "error",
    { assertionStyle: "never" },
  ],
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      prefer: "type-imports",
      fixStyle: "separate-type-imports",
      disallowTypeAnnotations: false,
    },
  ],
  "@typescript-eslint/ban-ts-comment": [
    "error",
    {
      "ts-check": true,
      "ts-ignore": true,
      "ts-expect-error": true,
      "ts-nocheck": true,
    },
  ],
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    { allowNumber: true },
  ],
  "@typescript-eslint/no-floating-promises": "error",
  "no-restricted-syntax": [
    "error",
    {
      selector: "TSAsExpression > TSAsExpression",
      message:
        "Double type assertions are banned. Narrow unknown input with a guard.",
    },
  ],
  "no-console": "error",
};

// TypeScript accepts mixed case and extra leading slashes in this directive.
export const suppressionGuard = {
  linterOptions: {
    noInlineConfig: true,
    reportUnusedDisableDirectives: "error",
  },
  rules: {
    "no-warning-comments": [
      "error",
      { terms: ["@ts-nocheck"], location: "start", decoration: ["/"] },
    ],
  },
};
