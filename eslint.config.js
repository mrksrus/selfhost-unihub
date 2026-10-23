import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { API_FILES_USING_CONSOLE, ROUTES_USING_DB, VIEWS_USING_API_CLIENT } from "./eslint.boundaries.js";

// Settings and policies have one owner (F1): services/settings.ts.
const SETTINGS_FENCE = {
  selector: "Literal[value=/\\b(mail_account_settings|calendar_settings|setting_policies)\\b/]:not(TSLiteralType > Literal), TemplateElement[value.raw=/\\b(mail_account_settings|calendar_settings|setting_policies)\\b/]",
  message: "Read and write settings and policies through services/settings.ts.",
};

export default tseslint.config(
  { ignores: ["dist", "api/dist", ".worker-dist", "tools/ui-regression/.build", "tools/ui-regression/.browsers", "tools/ui-regression/report", "tools/ui-regression/test-results"] },
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
    // Settings and policies have one owner (F1): services/settings.ts. Schema
    // and recovery code name the tables to create, archive and restore them.
    files: ["api/src/**/*.ts"],
    ignores: ["api/src/services/settings.ts", "api/src/services/database.ts", "api/src/services/data-inventory.ts", "api/src/services/backup-catalog.ts", "api/src/services/backup-export.ts", "api/src/services/backup-import.ts"],
    rules: {
      "no-restricted-syntax": ["error", SETTINGS_FENCE],
    },
  },
  // Layering (docs/ARCHITECTURE.md, Layering). Existing exceptions are listed
  // in eslint.boundaries.js and only shrink.
  {
    files: ["api/src/routes/**/*.ts"],
    ignores: ROUTES_USING_DB.files,
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "../state", message: "Routes reach the database through a service in api/src/services/." }] }],
    },
  },
  {
    files: ["api/src/routes/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.property.name='split'] > MemberExpression.callee > MemberExpression.object[property.name='url']",
        message: "Read path parameters from req.params; the boundary matched the route.",
      }, {
        selector: "CallExpression[callee.property.name='split'] > MemberExpression.callee > TSNonNullExpression.object > MemberExpression.expression[property.name='url']",
        message: "Read path parameters from req.params; the boundary matched the route.",
      }, SETTINGS_FENCE],
    },
  },
  {
    files: ["api/src/**/*.ts"],
    ignores: ["api/src/log.ts", ...API_FILES_USING_CONSOLE.files],
    rules: { "no-console": "error" },
  },
  {
    files: ["api/src/security/**/*.ts", "api/src/http/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{
        group: ["../services", "../services/*", "../routes", "../routes/*"],
        message: "security/ and http/ are leaf layers: they do not import services or routes.",
      }] }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/**", "src/test/**", "src/contexts/AuthContext.tsx", "src/utils/service-worker.ts", ...VIEWS_USING_API_CLIENT.files],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{
        regex: "(^@/lib/api$)|(/lib/api$)",
        message: "Call the API through a feature module in src/lib/ (calendar-api.ts, mail-api.ts, ...).",
      }] }],
    },
  },
  {
    // Cleanup hooks and provider doubles read setup variables before the test
    // assigns them; a const there would throw if setup fails first.
    files: ["api/tests/**/*.cts"],
    rules: { "prefer-const": ["error", { ignoreReadBeforeAssign: true }] },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["*.mts", "scripts/**/*.mts"],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    // Node strips types from these scripts and tests but does not turn ES
    // modules into CommonJS, so a value import or export fails at run time even
    // though tsc accepts it. Type-only imports and exports are erased and stay
    // allowed. api/tsconfig.tests.json cannot enforce erasable syntax itself:
    // the tests' typed requires pull in API source that tsc compiles.
    files: ["api/scripts/*.cts", "api/tests/**/*.cts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "Program > :matches(ImportDeclaration[importKind!='type'], ExportNamedDeclaration[exportKind!='type']:not([declaration.declare=true]), ExportDefaultDeclaration, ExportAllDeclaration[exportKind!='type'])",
        message: "Scripts run as CommonJS: use `require('x') as typeof import('x')`, `import type` and `module.exports`.",
      }, {
        selector: "TSEnumDeclaration:not([declare=true]), TSModuleDeclaration:not([declare=true]), TSParameterProperty, TSImportEqualsDeclaration[importKind!='type'], TSExportAssignment",
        message: "Node only strips erasable TypeScript: no enums, namespaces, parameter properties, `import x = require()` or `export =`.",
      }],
    },
  },
);
