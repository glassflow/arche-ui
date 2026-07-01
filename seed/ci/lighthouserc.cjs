// Seed config for the `web-vitals` CI job — see ../../docs/15-architectural-guardrails.md
// (job table) and ../../docs/16-multitenant-performance.md (route-class LCP budgets).
//
// Thresholds below are the "shell / list views" route class (LCP 2.0s) —
// the most common route. Heavy data views get a relaxed LCP budget (2.5s)
// per docs/16; if your CI runs Lighthouse per route class, duplicate this
// block with `assertMatrix` per URL and swap the LCP threshold accordingly.
//
// On copy: repoint `url` to your project's actual routes and
// `startServerCommand` to however the app is built/served in CI.

module.exports = {
  ci: {
    collect: {
      // Repoint to the routes you want gated. Multiple URLs run
      // `numberOfRuns` times each and are aggregated per-URL, never averaged
      // across routes — per docs/16, per-route budgets, not an app-wide average.
      url: ['http://localhost:3000/dashboard/tenant-seed'],
      startServerCommand: 'pnpm start',
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        // LCP — largest contentful paint. 2500ms ceiling matches the
        // "shell / list views" route class budget (2.0s target, 2.5s hard
        // ceiling with headroom for CI-runner variance).
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        // CLS — cumulative layout shift. 0.1 is the standard "good" Web
        // Vitals threshold; regressing past it is a hard fail, not a warning.
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        // TBT — total blocking time, used as the CI-measurable proxy for
        // INP (Lighthouse lab runs can't measure real INP). 200ms budget.
        'total-blocking-time': ['error', { maxNumericValue: 200 }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
}
