// Seed config for the `boundaries` CI job — see ../../docs/15-architectural-guardrails.md
// (job table) and ../../docs/09-component-architecture.md (the rule this encodes).
//
// Layer chain is one-way: ui/ -> common/ -> shared/ -> modules/*.
// A component may only import its own layer or a layer to its left.
// Nothing here judges intent — every rule below is a mechanical graph
// constraint. Judgment calls belong in Layer 2 (review-changes skill), not
// bolted onto this file as a growing exception list.
//
// On copy: repoint the `path` regexes below to your project's actual source
// root if it isn't `src/components` + `src/modules` (e.g. `app/components`).

module.exports = {
  forbidden: [
    {
      name: 'shared-cannot-import-modules',
      comment:
        "shared/ is app-shell infrastructure (sidebar, topbar, layout). It must stay " +
        'ignorant of every feature module so it can be reasoned about without asking ' +
        '"which module does this secretly depend on now?" Push feature-aware behavior ' +
        'into a page or module component and pass shared/ only props/children/slots.',
      severity: 'error',
      from: { path: '^src/components/shared' },
      to: { path: '^src/modules/[^/]+/' },
    },
    {
      name: 'ui-cannot-import-common',
      comment:
        'ui/ primitives (shadcn/Radix) own all visual state themselves via variant props. ' +
        'They must never reach up to common/ — that would invert the one-way dependency chain.',
      severity: 'error',
      from: { path: '^src/components/ui' },
      to: { path: '^src/components/common' },
    },
    {
      name: 'ui-cannot-import-shared',
      comment: 'ui/ must never import shared/ — same one-way chain violation as ui/ -> common/.',
      severity: 'error',
      from: { path: '^src/components/ui' },
      to: { path: '^src/components/shared' },
    },
    {
      name: 'ui-cannot-import-modules',
      comment: 'ui/ must never import modules/* — primitives know nothing about feature domains.',
      severity: 'error',
      from: { path: '^src/components/ui' },
      to: { path: '^src/modules/[^/]+/' },
    },
    {
      name: 'common-cannot-import-shared',
      comment:
        'common/ is domain-neutral and reusable across 2+ features; it sits to the left of ' +
        'shared/ in the chain and must not import app-shell infrastructure.',
      severity: 'error',
      from: { path: '^src/components/common' },
      to: { path: '^src/components/shared' },
    },
    {
      name: 'common-cannot-import-modules',
      comment: 'common/ must never import modules/* — that would leak a domain concept back down.',
      severity: 'error',
      from: { path: '^src/components/common' },
      to: { path: '^src/modules/[^/]+/' },
    },
    {
      name: 'no-cross-module-component-imports',
      comment:
        "A module never imports another module's components/ directly. If two modules " +
        'converge on needing the same component, promote it to common/ (if domain-neutral) — ' +
        'never import sideways between modules.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/components/',
        pathNot: '^src/modules/$1/components/',
      },
    },
    {
      name: 'no-circular',
      comment:
        'Any circular dependency, anywhere in the tree — circular imports make module ' +
        'boundaries impossible to reason about and often hide a layering violation.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
}
