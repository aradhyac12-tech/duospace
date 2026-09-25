import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
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
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-useless-escape": "off",
      // DS-UNKNOWN-001 guard: catches a hook/deps array naming a `const`
      // declared further down the component (TDZ crash in minified builds).
      // variables:false ignores safe references inside closures.
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": ["error", { functions: false, classes: false, variables: false, typedefs: false, ignoreTypeReferences: true }],
      "prefer-const": "off",
    },
  },
);
