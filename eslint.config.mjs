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
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs', '**/__tests__/**', '!scripts/**/*.mjs'] },

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
)
