import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
import { hardenedRules, suppressionGuard } from "../scripts/eslint-policy.mjs";

export default defineConfig(
  { ignores: ["dist/**", "node_modules/**"] },
  suppressionGuard,
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked, prettier],
    languageOptions: {
      parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: hardenedRules,
  },
);
