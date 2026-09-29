import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Same posture as the token server's config (this is a straight copy of it): `tsc --noEmit` and
 * the test suite already cover types and behaviour, so this only carries rules neither of those
 * can catch. No React here either.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' },
    },
    rules: {
      // postActivity.ts's `content` is a Matrix event's raw JSON body — as loosely and variably
      // shaped as the matrix-js-sdk unions token-server's own `any` casts work around, and not
      // worth a hand-rolled type for the handful of fields read out of it here.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  }
);
