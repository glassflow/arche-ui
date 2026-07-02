// Seed config for the `tenant-scope` CI job — see ../../docs/15-architectural-guardrails.md
// (job table) and ../../docs/17-workspace-tenancy-model.md (the rules this encodes).
//
// The workspace tenancy model makes `workspaceId` a REQUIRED path segment
// (`/ui-api/w/[workspaceId]/...`) and a REQUIRED service argument — never an
// ambient default read from localStorage the way the first product did it.
// That path prefix is a greppable, AST-visible signature, which is what makes
// "never forget to scope a tenant call" enforceable as a hard gate instead of
// a review-checklist item. This config turns three of doc 17's Rules & gotchas
// into build failures on line N of a diff:
//
//   1. require-workspace-id-arg  — any function that builds a `/ui-api/w/...`
//      URL must have a `workspaceId` parameter (plain or destructured) in its
//      own signature or an enclosing one. Enforces "workspaceId is a required
//      argument on every tenant-scoped service method."
//   2. no-ambient-workspace-scope — bans reading the active tenant from
//      localStorage/sessionStorage (keys matching workspace/tenant/organization)
//      to scope a request. Enforces "the URL is the single source of truth for
//      the active tenant" — this is the exact first-product anti-pattern
//      (`localStorage.getItem("activeOrganization")` threaded per call site).
//   3. proxy-route-must-assert-membership — any proxy route handler under
//      app/ui-api/w/[workspaceId]/** must call `assertMembership(...)` before
//      returning. Enforces "the proxy is the security boundary; every
//      tenant-scoped proxy route verifies membership."
//
// On copy: repoint the `files`/`ignores` globs to your project's actual source
// root, and — if your tenant path prefix or membership-assertion helper is
// named differently — adjust TENANT_PATH_PREFIX and ASSERT_FN below. This
// config defines only the tenancy rules; spread in your project's base
// React/Next.js + typescript-eslint config (which supplies the TS parser)
// alongside it, exactly as the other seed ESLint configs are wired.

// The tenant-scoped API path prefix from docs/17 (`/ui-api/w/[workspaceId]/...`).
const TENANT_PATH_PREFIX = '/ui-api/w/'
// The proxy-layer membership-assertion helper from docs/17 step 5.
const ASSERT_FN = 'assertMembership'
// Storage keys that name a tenant — reading one to scope a request is the
// ambient-active-tenant anti-pattern. Word-ish, case-insensitive.
const TENANT_KEY_REGEX = /workspace|tenant|organi[sz]ation/i

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

// Does a parameter binding (possibly destructured/defaulted/rest) introduce a
// binding named `name`? Handles `workspaceId`, `{ workspaceId }`,
// `{ workspaceId = x }`, `{ a: { workspaceId } }`, `[..., workspaceId]`,
// `workspaceId = x`, `...workspaceId`, and TS parameter properties.
function bindsName(node, name) {
  if (!node) return false
  switch (node.type) {
    case 'Identifier':
      return node.name === name
    case 'AssignmentPattern':
      return bindsName(node.left, name)
    case 'RestElement':
      return bindsName(node.argument, name)
    case 'Property':
      return bindsName(node.value, name)
    case 'ObjectPattern':
      return node.properties.some((p) => bindsName(p, name))
    case 'ArrayPattern':
      return node.elements.some((el) => bindsName(el, name))
    case 'TSParameterProperty':
      return bindsName(node.parameter, name)
    default:
      return false
  }
}

function fnHasParam(fn, name) {
  return Array.isArray(fn.params) && fn.params.some((p) => bindsName(p, name))
}

function getAncestors(context, node) {
  const sc = context.sourceCode ?? (context.getSourceCode && context.getSourceCode())
  if (sc && typeof sc.getAncestors === 'function') return sc.getAncestors(node)
  return context.getAncestors()
}

// Dependency-free recursive AST walk: visit every descendant node of `root`.
function walk(root, visit) {
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node.type !== 'string') continue
    visit(node)
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue
      const val = node[key]
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child && typeof child.type === 'string') stack.push(child)
        }
      } else if (val && typeof val.type === 'string') {
        stack.push(val)
      }
    }
  }
}

const rules = {
  // 1. A function that constructs a tenant-scoped URL must take `workspaceId`.
  'require-workspace-id-arg': {
    meta: {
      type: 'problem',
      docs: { description: 'Tenant-scoped API calls must take a workspaceId argument.' },
      schema: [],
    },
    create(context) {
      const reported = new WeakSet()

      function checkUrlNode(node, text) {
        if (typeof text !== 'string' || !text.includes(TENANT_PATH_PREFIX)) return
        const ancestors = getAncestors(context, node)
        const enclosingFns = ancestors.filter((a) => FUNCTION_TYPES.has(a.type))
        const scoped = enclosingFns.some((fn) => fnHasParam(fn, 'workspaceId'))
        if (scoped) return
        // Report once per innermost enclosing function (or on the URL node
        // itself if it's built at module top level, which is itself suspect).
        const target = enclosingFns.length ? enclosingFns[enclosingFns.length - 1] : node
        if (reported.has(target)) return
        reported.add(target)
        context.report({
          node: target,
          message:
            `Tenant-scoped call builds a "${TENANT_PATH_PREFIX}..." URL but no enclosing ` +
            `function takes a \`workspaceId\` parameter. workspaceId is a required argument ` +
            `on every tenant-scoped service method — it must come from the caller (ultimately ` +
            `the URL path), never an ambient default. See docs/17-workspace-tenancy-model.md.`,
        })
      }

      return {
        Literal(node) {
          checkUrlNode(node, node.value)
        },
        TemplateElement(node) {
          checkUrlNode(node, node.value && (node.value.cooked ?? node.value.raw))
        },
      }
    },
  },

  // 2. Never read the active tenant from web storage to scope a request.
  'no-ambient-workspace-scope': {
    meta: {
      type: 'problem',
      docs: { description: 'The URL is the source of truth for the active tenant, not storage.' },
      schema: [],
    },
    create(context) {
      return {
        CallExpression(node) {
          const callee = node.callee
          if (
            callee.type !== 'MemberExpression' ||
            callee.object.type !== 'Identifier' ||
            (callee.object.name !== 'localStorage' && callee.object.name !== 'sessionStorage') ||
            callee.property.type !== 'Identifier' ||
            callee.property.name !== 'getItem'
          ) {
            return
          }
          const arg = node.arguments[0]
          if (arg && arg.type === 'Literal' && typeof arg.value === 'string' && TENANT_KEY_REGEX.test(arg.value)) {
            context.report({
              node,
              message:
                `Reading "${arg.value}" from ${callee.object.name} to scope a request is the ` +
                `ambient-active-tenant anti-pattern. The active tenant lives in the URL path ` +
                `(\`/w/[workspaceId]\`); storage may seed the "/" landing redirect only. ` +
                `See docs/17-workspace-tenancy-model.md.`,
            })
          }
        },
      }
    },
  },

  // 3. Every tenant-scoped proxy route handler must assert membership.
  'proxy-route-must-assert-membership': {
    meta: {
      type: 'problem',
      docs: { description: 'Proxy routes under /ui-api/w/[workspaceId] must call assertMembership.' },
      schema: [],
    },
    create(context) {
      const HANDLERS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

      function checkHandler(fn, nameNode) {
        let found = false
        walk(fn, (n) => {
          if (
            n.type === 'CallExpression' &&
            n.callee.type === 'Identifier' &&
            n.callee.name === ASSERT_FN
          ) {
            found = true
          }
        })
        if (!found) {
          context.report({
            node: nameNode,
            message:
              `Tenant-scoped proxy route handler does not call \`${ASSERT_FN}(...)\`. Every ` +
              `handler under app/ui-api/w/[workspaceId]/** must verify the session user is a ` +
              `member of the path's workspaceId (with the required capability) before calling ` +
              `the backend — the proxy is the security boundary, not the client's can() check. ` +
              `See docs/17-workspace-tenancy-model.md.`,
          })
        }
      }

      return {
        // export function GET(...) {}
        ExportNamedDeclaration(node) {
          const decl = node.declaration
          if (decl && decl.type === 'FunctionDeclaration' && decl.id && HANDLERS.has(decl.id.name)) {
            checkHandler(decl, decl.id)
          }
          // export const GET = (...) => {}
          if (decl && decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations) {
              if (
                d.id.type === 'Identifier' &&
                HANDLERS.has(d.id.name) &&
                d.init &&
                FUNCTION_TYPES.has(d.init.type)
              ) {
                checkHandler(d.init, d.id)
              }
            }
          }
        },
      }
    },
  },
}

const tenantScopePlugin = { rules }

export default [
  // Rules 1 & 2 apply across all client/service source.
  {
    files: ['src/**/*.{ts,tsx,js,jsx}', 'app/**/*.{ts,tsx,js,jsx}'],
    plugins: { 'tenant-scope': tenantScopePlugin },
    rules: {
      'tenant-scope/require-workspace-id-arg': 'error',
      'tenant-scope/no-ambient-workspace-scope': 'error',
    },
  },
  // Rule 3 applies only to tenant-scoped proxy route handlers.
  {
    files: ['**/app/ui-api/w/**/route.{ts,tsx,js,jsx}'],
    plugins: { 'tenant-scope': tenantScopePlugin },
    rules: {
      'tenant-scope/proxy-route-must-assert-membership': 'error',
    },
  },
]
