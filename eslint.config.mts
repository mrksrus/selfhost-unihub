import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "api/dist", ".worker-dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["workers/**/*.ts"],
    languageOptions: { ecmaVersion: 2022, globals: globals.serviceworker },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}", "*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["api/**/*.{ts,cts}"],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      // Modules loaded on first use (import cycles, require.cache swaps in tests)
      // and the `import x = require()` of `export =` route tables.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Fixtures capture setup variables before callbacks initialize them.
    files: ["api/tests/**/*.cts"],
    rules: { "prefer-const": "off" },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["*.mts", "scripts/**/*.mts"],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    // Node strips types from these scripts but does not turn ES modules into
    // CommonJS, so a value import or export fails at run time even though tsc
    // accepts it. Type-only imports and exports are erased and stay allowed.
    files: ["api/scripts/*.cts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "Program > :matches(ImportDeclaration[importKind!='type'], ExportNamedDeclaration[exportKind!='type']:not([declaration.declare=true]), ExportDefaultDeclaration, ExportAllDeclaration[exportKind!='type'])",
        message: "Scripts run as CommonJS: use `require('x') as typeof import('x')`, `import type` and `module.exports`.",
      }],
    },
  },
);
