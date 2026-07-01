// Seed config for the `token-contract` CI job — see ../../docs/15-architectural-guardrails.md
// (job table) and ../../docs/08-design-tokens.md (the rule this encodes).
//
// Every color is a CSS variable reference (`hsl(var(--token))`) or a variant
// prop (`<Badge variant="error">`) — never a literal. This job turns that
// sentence into a build failure on line N of a diff instead of a review
// checklist item.
//
// Forbidden patterns, matched inside className strings, style objects, and
// template literals:
//   1. Hardcoded hex colors      — e.g. `#e22c2c`, `#FFF`
//   2. rgba()/rgb() literals     — e.g. `rgba(17, 25, 40, 0.25)`
//   3. Raw Tailwind color utils  — e.g. `bg-red-500`, `text-gray-400`, `border-zinc-700`
//
// Exempt everywhere: base.css and theme.css — those two files ARE the token
// definitions, so literal color values are expected and required there.
//
// On copy: repoint `files`/`ignores` globs below to your project's actual
// source root and confirm the exempt filenames match your token files.

const HEX_COLOR_REGEX = '#[0-9a-fA-F]{3,8}\\b'
const RGBA_REGEX = '\\brgba?\\(\\s*\\d'
const RAW_TAILWIND_COLOR_REGEX =
  '\\b(?:bg|text|border|ring|fill|stroke|from|via|to)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|gray|grey|zinc|neutral|stone|slate)-\\d{2,3}\\b'

const FORBIDDEN_LITERAL_MESSAGE =
  'Hardcoded color literal detected. Colors must resolve through a CSS variable ' +
  '(`hsl(var(--token))`) or a component variant prop (e.g. `<Badge variant="error">`), ' +
  'never a hex/rgba literal or a raw Tailwind color utility. See docs/08-design-tokens.md.'

export default [
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['**/base.css', '**/theme.css', '**/*.css'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/" + HEX_COLOR_REGEX + "/], TemplateElement[value.raw=/" + HEX_COLOR_REGEX + "/]",
          message: FORBIDDEN_LITERAL_MESSAGE + ' (hex literal)',
        },
        {
          selector:
            "Literal[value=/" + RGBA_REGEX + "/], TemplateElement[value.raw=/" + RGBA_REGEX + "/]",
          message: FORBIDDEN_LITERAL_MESSAGE + ' (rgba()/rgb() literal)',
        },
        {
          selector:
            "Literal[value=/" +
            RAW_TAILWIND_COLOR_REGEX +
            "/], TemplateElement[value.raw=/" +
            RAW_TAILWIND_COLOR_REGEX +
            "/]",
          message: FORBIDDEN_LITERAL_MESSAGE + ' (raw Tailwind color utility)',
        },
      ],
    },
  },
]

// Companion regex script (for CI runners that prefer a plain grep pass over
// an ESLint pass, or for a pre-merge secondary check): apply the three
// regexes above with `grep -rnE` across the source tree, excluding
// `base.css` and `theme.css`, and exit non-zero on any match. Both routes
// exist to enforce the same rule — pick one, keep it wired to `error`, never
// `warn`.
