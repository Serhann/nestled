import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'server/dist', '**/node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // ── Tenant isolation guard ────────────────────────────────────────────────
    // The unscoped Prisma client bypasses tenant scoping completely. Request-path
    // code must go through `req.db` (see server/src/db/tenant.ts), so importing
    // the raw client here is an error rather than a judgement call.
    //
    // The allowed importers are listed in db/unscoped.ts: db/, auth/, platform/,
    // billing/ and jobs/ — each of which either builds the scoped client, runs
    // before a workspace is known, or is cross-tenant by definition.
    files: [
      'server/src/routes/**/*.ts',
      'server/src/services/**/*.ts',
      'server/src/realtime/**/*.ts',
      'server/src/lib/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/unscoped', '**/db/unscoped.js'],
              message:
                'Use the tenant-scoped client (req.db) instead. The unscoped client bypasses ' +
                'workspace isolation — see server/src/db/tenant.ts for why, and db/unscoped.ts ' +
                'for the short list of places allowed to import it.',
            },
          ],
        },
      ],
    },
  },
);
