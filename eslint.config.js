import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // Server, daemon, CLI, bots and MCP are all .mjs and were linted by NOTHING.
  // On 2026-07-25 a hand-run no-undef sweep found five live undefined-variable
  // bugs in minutes: every spawn reporting success as failure, the self-review
  // gate dead for every agent, findLanIPv4 used but never imported, and two
  // catch handlers that threw while reporting the error they had caught.
  //
  // Deliberately no-undef ONLY. The recommended set produces thousands of
  // pre-existing findings here, and a lint everyone must ignore is a lint that
  // catches nothing — which is how these five survived.
  {
    files: ['**/*.mjs'],
    ignores: ['server/public/**', 'dist/**', 'node_modules/**', '**/node_modules/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-undef': 'error' },
  },
])
