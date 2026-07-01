// Seed config for the `lint` CI job — see ../../docs/15-architectural-guardrails.md
// (job table).
//
// This file intentionally stays minimal: it is the one rule the guardrail
// doc calls out by name (`@typescript-eslint/no-explicit-any: 'error'`) with
// no per-line escape valve by convention. A single `// eslint-disable-next-line`
// on an `any` is a judgment call for a PR description and a Layer 2 review
// comment, not a silent permanent bypass.
//
// On copy: this config composes ON TOP OF your project's standard
// React/Next.js rule set (`eslint-config-next`, `plugin:react/recommended`,
// etc.) — spread those configs into the array below rather than replacing
// them. This file only asserts the one rule the guardrail doc requires as a
// hard gate; it is not a replacement for a full lint setup.

import tseslint from 'typescript-eslint'

export default [
  // Spread your project's base config(s) here, e.g.:
  //   ...compat.extends('next/core-web-vitals'),
  //   ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]
