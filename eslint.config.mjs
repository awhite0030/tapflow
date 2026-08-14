import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

const commonRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
}

export default tseslint.config(
  // `!scripts/**` re-includes: a global ignore cannot be undone by a later `files` entry, so the
  // negation has to live here.
  // `typeAssertions.ts` is deliberately outside the protocol package's build tsconfig (it declares
  // values and must not reach `dist`), which puts it outside the typed-lint project service too.
  // It is type-checked by `tsconfig.assertions.json`, which is the only check that file needs.
  // `__tests__` is no longer ignored (#422). It was, and the two exclusions compounded: nothing typed
  // the test tree and nothing linted it, so a double could drift from the interface it doubled with
  // both gates green. Typed lint needs the files in a tsconfig to say anything at all, which is why
  // `src/__tests__/tsconfig.json` had to land first — with the tree outside every project, every rule here
  // failed as a parse error rather than reporting.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs', 'packages/protocol/src/typeAssertions.ts', '!scripts/**'] },

  // Repo tooling under scripts/ is .mjs, which the blanket ignore above covers. It is opted back
  // in because `dev-down` sends SIGKILL to processes it selects — the most destructive code in
  // the repo should not also be the only code nothing checks.
  {
    files: ['scripts/**/*.mjs'],
    ignores: [],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.node, sourceType: 'module' },
    rules: commonRules,
  },

  // Node.js packages — .ts files (excludes dashboard)
  {
    files: ['**/*.ts'],
    ignores: ['packages/dashboard/**'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true },
    },
    rules: {
      ...commonRules,
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // Dashboard — .ts/.tsx files
  {
    files: ['packages/dashboard/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...commonRules,
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // shadcn primitives are generated and re-synced from upstream, and their convention is to export
  // a `*Variants` helper next to the component. That trips the Fast Refresh hint in five files for a
  // structure we do not own and would have to re-fix on every upstream sync. Only that hint is
  // waived — every correctness rule still applies here, which is what caught the `Math.random()`
  // during render in sidebar.tsx.
  //
  // The scope is the directory, not the file's origin, and `ui/` also holds a few of our own
  // components (`search-input`, `tech-label`). They export a single component today so the rule
  // would not fire on them anyway — but the cost of this shortcut is that adding a hand-written
  // file here that exports a component *and* a helper loses the hint silently. Put such a file in
  // `components/` rather than `components/ui/`.
  {
    files: ['packages/dashboard/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
)
