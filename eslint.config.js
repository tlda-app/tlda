import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import awaitFleetStore from './eslint-rules/await-fleet-store.mjs'

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '.claude/**',
    '.daemon/**',
    '.home/**',
    '.playwright*/**',
    '.tlda-dev/**',
    '.tlda-fly/**',
    '.worktrees/**',
    'dist/**',
    'server/public/**',
    'server/projects/**',
    'scratch/**',
    'telemetry/**',
    'tldraw-fork/**',
  ]),
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
  {
    files: [
      'src/shapes/FleetPillShape.tsx',
      'src/shapes/MathNoteShape.tsx',
      'src/shapes/ReadingAssistBarShape.tsx',
      'src/shapes/UnderstandingLineShape.tsx',
    ],
    rules: {
      // TLDraw calls BaseBoxShapeUtil.component(shape) as the render function for
      // one custom shape instance. The React hooks here are top-level in that
      // render method; eslint-plugin-react-hooks only sees a class method named
      // component and misclassifies the whole TLDraw shape-util pattern.
      'react-hooks/rules-of-hooks': 'off',
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
    plugins: { tlda: { rules: { 'await-fleet-store': awaitFleetStore } } },
    // A FleetStore call that returns a Promise must be consumed as one. The
    // store is moving onto a worker thread, so its methods become async one at
    // a time; this is what stops a call site from silently keeping the old
    // synchronous reading. See server/lib/fleet-store-async-methods.mjs for why
    // it enforces a list rather than every method.
    rules: { 'no-undef': 'error', 'tlda/await-fleet-store': 'error' },
  },
])
