/**
 * dsh-session-top — browser half.
 *
 * This file IS the shipped client bundle: the DSH client module system expects
 * `exports["./client"]` to be a self-registering closure factory
 * (`window.__ModuleLoader__.load({id, factory})`), where `require` resolves
 * only platform-frozen modules (react, react-dom, ui-primitives, ui-slots).
 * It is hand-authored in that format rather than produced by a bundler, so it
 * has no build step: `require` calls are the only externals and every one of
 * them is on the platform module table.
 *
 * What it does, against the five acceptance points:
 *
 *  1. Active float-up — the durable order itself is re-sorted by the host half
 *     through `insertSessionBefore`, so a session with new activity is above
 *     its inactive neighbours in BOTH the sidebar's "recent" and "manual"
 *     order modes. Here we only keep the flat pinned region in pin order.
 *  2. Right-click to pin — a delegated `contextmenu` listener opens the
 *     official `Menu` primitive at the cursor, offering Pin / Unpin. The
 *     native menu is suppressed on session rows only; everywhere else the app's
 *     own context menu is untouched.
 *  3. Pin extracts from the group — a pinned session's official row is hidden
 *     (by stylesheet rule, so React re-renders cannot undo it) and re-rendered
 *     in a flat "Pinned" region above the workspace groups. Its workspace group
 *     is folded through the official header toggle.
 *  4. Unpin returns it — the row reappears in its own group at its
 *     activity-sorted position and the group is expanded again so the user can
 *     see where it went.
 *  5. Durability — the pin set is the Host's registry-global
 *     `pinnedSessionIds`, written through the official `workspaces.pinSession`
 *     / `unpinSession` RPCs. Nothing here keeps a private copy, so the state
 *     survives restarts with no plugin-owned persistence to drift.
 *
 * Degradation contract: every DOM touch is guarded. If the official sidebar
 * renames `data-row-key`, drops `[role="tree"]`, or changes its layout, the
 * plugin finds nothing and no-ops — the sidebar keeps rendering exactly as it
 * does without the plugin.
 *
 * On slots: this plugin registers NO slot entry on purpose. The official
 * sidebar already ships a Pin row in `sidebar.workspaces.session.menu.item`
 * (order 100) bound to the same Host pin set this plugin reads, so a second
 * entry would be the same action offered twice. And neither surface the spec
 * asks for has a slot to occupy: the row "..." menu is a button menu rather
 * than a `contextmenu` affordance, and the "Pinned" region is not a hole the
 * official slot map declares — `sidebar.workspaces` is a `single` slot the
 * browser already owns, and hanging the region off `sidebar.footer.action`
 * would put "Pinned" at the sidebar's foot rather than its top. The DOM layer
 * is therefore the right tool here, kept as narrow and as guarded as possible.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-top',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      SESSION_ROW_PREFIX, ROW_KEY_ATTR, WORKSPACE_ROW_PREFIX,
      isFoldableGroup,
    } = (() => {
      // core.js is a host-side ESM module and this bundle must stay a single
      // self-contained factory (the module table has no relative-resolution
      // path for a package-local chunk). The few shared contracts are
      // therefore restated here as literals, and test/core.test.js asserts they
      // stay identical to src/core.js.
      return {
        SESSION_ROW_PREFIX: 'session:',
        WORKSPACE_ROW_PREFIX: 'workspace:',
        ROW_KEY_ATTR: 'data-row-key',
        isFoldableGroup: key => key !== '',
      }
    })()

    /** Escape a value for use inside a double-quoted CSS attribute selector. */
    const cssEscape = (value) => String(value).replace(/["\\]/g, '\\$&')

    /**
     * The two sidebar renderings this plugin supports.
     *
     * A real user desktop runs @michengai/dsh-codex-ui, whose cordis patch
     * disables the official ui-sidebar, so the stock 0.2.0-rc.2 tree
     * (`data-row-key`) is simply absent there. Both renderings ship stable,
     * public attribute/class prefixes, so detection is by attribute
     * *existence*, never by matching a whole class string:
     *
     *   codex    `.dcu-wb-session[data-dcu-session="session-<uuid>"]`
     *            `.dcu-wb-project-head[aria-expanded]`
     *   official `data-row-key="session:<id>"` / `"workspace:<key>"`
     *
     * Both put the session list in a `[role="tree"]`, which is what the pinned
     * region is anchored against.
     */
    const FLAVOR_CODEX = {
      id: 'codex',
      sessionSelector: '[data-dcu-session]',
      /** codex-ui puts the RAW session id here; ids look like `session-<uuid>`. */
      sessionIdOf: (element) => {
        const value = element.getAttribute('data-dcu-session')
        return typeof value === 'string' && value.length > 0 ? value : undefined
      },
      treeSelector: '[role="tree"]',
      /** codex-ui opens its own session menu on right-click (and has no pin in it). */
      nativeContextMenu: true,
      projectClass: '.dcu-wb-project',
      projectHeadClass: '.dcu-wb-project-head',
      hideRule: (id) => `[role='tree'] [data-dcu-session="${cssEscape(id)}"]{display:none !important;}`,
      tokens: {
        hover: '--dcu-sidebar-hover',
        primary: '--dcu-sidebar-primary',
        secondary: '--dcu-sidebar-secondary',
        tertiary: '--dcu-sidebar-tertiary',
        border: '--dcu-sidebar-border',
        font: '--dsw-font-family',
      },
    }

    const FLAVOR_OFFICIAL = {
      id: 'official',
      sessionSelector: '[data-row-key^="session:"]',
      sessionIdOf: (element) => {
        const key = element.getAttribute('data-row-key')
        if (typeof key !== 'string' || !key.startsWith(SESSION_ROW_PREFIX)) return undefined
        const id = key.slice(SESSION_ROW_PREFIX.length)
        return id.length > 0 ? id : undefined
      },
      treeSelector: '[role="tree"][aria-label]',
      /** The stock sidebar's row menu is a "..." button menu, not a context menu. */
      nativeContextMenu: false,
      projectClass: null,
      projectHeadClass: null,
      hideRule: (id) => `[role='tree'] [${ROW_KEY_ATTR}='${SESSION_ROW_PREFIX}${cssEscape(id)}']{display:none !important;}`,
      tokens: {
        hover: '--dsh-sidebar-hover',
        primary: '--dsh-sidebar-primary',
        secondary: '--dsh-sidebar-secondary',
        tertiary: '--dsh-sidebar-tertiary',
        border: '--dsh-sidebar-border',
        font: '--dsh-font-family',
      },
    }

    /** Resolve which sidebar is on screen, or null when neither is present. */
    /**
     * Probe which sidebar is on screen right now.
     *
     * Deliberately a pure, uncached query. Every consumer re-probes: a
     * one-shot decision at mount is wrong, because the sidebar renders after
     * the plugin does — a mount-time probe on a real machine returned `none`
     * while eighteen `[data-dcu-session]` rows were already present by the
     * first right-click, and the plugin then never re-evaluated.
     * @returns {object | null} the flavor, or null when neither is present.
     */
    const detectFlavor = () => {
      if (document.querySelector(FLAVOR_CODEX.sessionSelector) !== null) return FLAVOR_CODEX
      if (document.querySelector(FLAVOR_OFFICIAL.sessionSelector) !== null) return FLAVOR_OFFICIAL
      return null
    }

    /**
     * Probing is a document-wide `querySelector` on every pointer and every
     * reconcile, so results are memoized briefly. The window is short enough
     * that a sidebar which finishes rendering is picked up almost immediately,
     * and long enough that a burst of reconciles costs one probe.
     */
    const FLAVOR_CACHE_MS = 250

    let flavorCache = null
    let flavorCacheAt = 0
    let flavorCacheValid = false

    /**
     * The current flavor, re-probed when the cache has expired.
     * @param {number} now - epoch ms.
     * @returns {object | null} the flavor, or null.
     */
    const currentFlavor = (now) => {
      if (flavorCacheValid && now - flavorCacheAt < FLAVOR_CACHE_MS) return flavorCache
      flavorCache = detectFlavor()
      flavorCacheAt = now
      flavorCacheValid = true
      return flavorCache
    }

    /** Drop the memoized flavor so the next read re-probes immediately. */
    const invalidateFlavor = () => {
      flavorCacheValid = false
    }

    /** Stable cordis plugin name (must equal the package name). */
    const name = 'dsh-session-top'

    /**
     * Services this fiber requires. Deliberately empty — read the comment
     * before changing it.
     *
     * Two distinct things are called "inject" in a dsh client plugin, and
     * conflating them is what broke the first release of this package:
     *
     *  - `inject` HERE (the cordis export) is a list of **Context service
     *    names** (`'slots'`, `'locale'`, …). A name that nothing publishes
     *    leaves the fiber in FiberState.PENDING, and `assertEntriesActive`
     *    then fails the ENTIRE web boot — one plugin must never be able to
     *    stop the app from starting.
     *
     *  - `dsh.client.inject` in package.json is a list of **package rows**
     *    whose factories must arrive before this bundle materializes. A name
     *    that does not resolve as a real package leaves the entry in
     *    FiberState.LOADING — the "web boot: 1 entry did not activate" failure
     *    this file's sibling test guards against. In the desktop profile the
     *    `@deepseek-ai` scope is not a profile dependency at all, so listing
     *    e.g. `@deepseek-ai/dsh-client-ui-sidebar` there can never resolve.
     *
     * Every service this plugin uses (`workspaces`, `sessions`, `uiWorkspace`,
     * `locale`) is therefore read defensively at apply time and null-checked,
     * and the bundle requires only seed-table modules that need no graph row.
     */
    const inject = []

    const PLUGIN_ID = 'dsh-session-top'

    /** How long after the last change we re-run the DOM reconciliation. */
    const RECONCILE_DEBOUNCE_MS = 60

    /** Inject the plugin stylesheet once, keeping the dynamic pin rules separate. */
    const STYLE_TEXT = `
[data-stp-region] {
  display: flex; flex-direction: column; gap: 1px;
  padding: 2px 8px 6px; margin: 0 0 4px;
}
[data-stp-region][hidden] { display: none !important; }
[data-stp-region-header] {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 4px 4px 6px; border-radius: 6px;
  font: 600 11px/16px var(--stp-token-font, inherit);
  color: var(--stp-token-tertiary, currentColor);
  user-select: none;
}
[data-stp-region-count] {
  margin-left: auto; opacity: .8;
  font-variant-numeric: tabular-nums;
}
[data-stp-row] {
  display: flex; align-items: center; gap: 8px;
  min-height: 28px; padding: 2px 8px 2px 10px;
  border-radius: 8px; cursor: pointer; position: relative;
  min-width: 0; box-sizing: border-box;
  font: 400 13px/20px var(--stp-token-font, inherit);
  color: var(--stp-token-primary, inherit);
}
[data-stp-row]:hover, [data-stp-row]:focus-visible {
  background: var(--stp-token-hover, rgba(127,127,127,.10));
  outline: none;
}
[data-stp-row][aria-selected='true'] { background: var(--stp-token-hover, rgba(127,127,127,.16)); }
[data-stp-row-slot] {
  width: 16px; height: 16px; flex: none;
  display: flex; align-items: center; justify-content: center;
  color: var(--stp-token-secondary, currentColor);
}
[data-stp-row-title] {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-stp-row-time] {
  flex: none; color: var(--stp-token-tertiary, currentColor);
  font-size: 12px; font-variant-numeric: tabular-nums;
}
[data-stp-pin-item] {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 0; background: transparent; cursor: pointer; text-align: left;
  padding: 6px 10px; border-radius: 6px;
  font: 400 13px/20px var(--stp-token-font, inherit);
  color: var(--stp-token-primary, inherit);
}
[data-stp-pin-item]:hover, [data-stp-pin-item]:focus-visible {
  background: var(--stp-token-hover, rgba(127,127,127,.12));
  outline: none;
}
[data-stp-anchor] { position: fixed; left: -9999px; top: -9999px; width: 0; height: 0; pointer-events: none; }
`

    /**
       * Inline-pin rules, regenerated per reconcile.
       *
       * Scoped to `[role='tree']` so the plugin's own region rows are never
       * hidden by the rule meant for the copy still living in a workspace group.
       * @param {object | null} flavor - the detected sidebar.
       * @param {readonly string[]} pinnedIds - the registry-global pin set.
       * @returns {string} the stylesheet body.
       */
    function pinRuleCss(flavor, pinnedIds) {
      if (flavor === null || pinnedIds.length === 0) return ''
      return pinnedIds.map(id => flavor.hideRule(id)).join('\n')
    }

/**
     * Inject the plugin stylesheets once.
     *
     * Two separate elements, both driven purely through `textContent`:
     *
     *   - static  : the region/row look, written once
     *   - dynamic : the per-reconcile pin rules, rewritten wholesale
     *
     * Deliberately NO CSSOM (`insertRule`/`deleteRule`). A previous revision
     * cleared `sheet.cssRules` in a loop and re-inserted; on the desktop page
     * `insertRule` throws a DOMException, and the loop had already deleted every
     * static rule — so one failed call left the stylesheet EMPTY and the region
     * rendered completely unstyled. `textContent` cannot fail that way: a
     * rejected assignment leaves the previous value in place.
     *
     * @returns {{static: HTMLStyleElement | null, dynamic: HTMLStyleElement | null}} the two tags.
     */
    function injectStyles() {
      if (typeof document === 'undefined') return { static: null, dynamic: null }
      const head = document.head ?? document.documentElement
      if (head === null || head === undefined) return { static: null, dynamic: null }
      const make = (name, text) => {
        let tag = document.querySelector(`style[data-plugin='${PLUGIN_ID}'][data-stp-sheet='${name}']`)
        if (tag === null) {
          tag = document.createElement('style')
          tag.setAttribute('data-plugin', PLUGIN_ID)
          tag.setAttribute('data-stp-sheet', name)
          head.appendChild(tag)
        }
        if (tag.textContent !== text) tag.textContent = text
        return tag
      }
      return { static: make('static', STYLE_TEXT), dynamic: make('dynamic', '') }
    }

/**
       * Point the stylesheet's `var()` references at the active sidebar's theme
       * tokens. codex-ui exposes `--dcu-sidebar-*`; the stock sidebar exposes the
       * `--dsh-*` family. Each indirection is a real custom property whose value
       * is itself a `var()`, so a sidebar theme switch keeps flowing through.
       * Re-run whenever the flavor changes; unknown tokens resolve to nothing and
       * the stylesheet's own fallbacks apply.
       * @param {object | null} flavor - the detected sidebar, or null.
       */
    const TOKEN_PROPS = ['Hover', 'Primary', 'Secondary', 'Tertiary', 'Border', 'Font']

    function applyStpTokens(flavor) {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (root === null || root === undefined || root.style === undefined) return
      for (const key of TOKEN_PROPS) {
        const prop = `--stp-token-${key.toLowerCase()}`
        const token = flavor === null ? undefined : flavor.tokens[key.toLowerCase()]
        if (token === undefined) root.style.removeProperty(prop)
        else root.style.setProperty(prop, `var(${token})`)
      }
    }

    /** Replace the dynamic stylesheet's contents. Never touches the static sheet. */
    function applyPinRules(tag, flavor, pinnedIds) {
      if (tag === null || tag === undefined) return
      const css = pinRuleCss(flavor, pinnedIds)
      try {
        if (tag.textContent !== css) tag.textContent = css
      } catch (error) {
        // textContent cannot normally fail, but a locked-down renderer might
        // refuse it; report it precisely rather than as "[object DOMException]".
        console.warn(
          `[dsh-session-top] pin rule injection failed: ${describeError(error)}`,
        )
      }
    }

    /**
     * Render an unknown throwable as something a human can act on.
     * `String(err)` on a DOMException is "[object DOMException]", which says
     * nothing; name and message are the actionable parts.
     * @param {unknown} error - the caught value.
     * @returns {string} a readable description.
     */
    function describeError(error) {
      if (error instanceof Error || (error !== null && typeof error === 'object')) {
        const name = typeof error.name === 'string' ? error.name : 'Error'
        const message = typeof error.message === 'string' ? error.message : String(error)
        return `${name}: ${message}`
      }
      return String(error)
    }

    /**
     * Mount the browser half.
     * @param {any} ctx - client cordis context.
     */
    /**
     * Entry point. Deliberately does almost nothing itself.
     *
     * This bundle is prefetched in the bootstrap stage (`immediately: true`),
     * so its fiber can activate BEFORE the Workspace controller has published
     * its `workspaces` service. A previous revision read that service at apply
     * time and returned early when it was absent — which left the plugin
     * permanently silent: no region, no menu graft, and (because the early
     * return also skipped the log) not even a warning on the machine.
     *
     * So the wait is delegated to cordis itself: `ctx.inject(deps, callback)`
     * is shorthand for `ctx.plugin({ inject: deps, apply: callback })`
     * (vendor/cordis/src/registry.ts:300). It starts a CHILD fiber that runs
     * once the dependency is published, while THIS fiber stays ACTIVE — so a
     * controller that never arrives can never strand the entry in LOADING and
     * fail the whole web boot.
     *
     * @param {any} ctx - client cordis context.
     */
    function apply(ctx) {
      const tag = '[dsh-session-top]'
      // console is the channel that actually reaches the desktop err.log the
      // user reads; the host logger is a bonus, not the primary signal.
      const info = (message) => {
        console.info(`${tag} ${message}`)
        try { ctx.get('logger')?.info?.(`${tag} ${message}`) } catch { /* best effort */ }
      }
      const warn = (message) => {
        console.warn(`${tag} ${message}`)
        try { ctx.get('logger')?.warn?.(`${tag} ${message}`) } catch { /* best effort */ }
      }

      if (typeof document === 'undefined') {
        warn('no document: nothing to attach to, staying inert')
        return
      }

      let mounted = false
      info('activated; waiting for the workspaces controller service')

      // The dependency that actually gates everything is the workspace
      // controller: it owns both the durable pin set this plugin renders and the
      // pin/unpin RPCs it writes.
      ctx.inject(['workspaces'], (child) => {
        if (mounted) return
        mounted = true
        try {
          const summary = mount(child, warn)
          info(`active (${summary})`)
        } catch (error) {
          warn(`mount failed, staying inert: ${String(error)}`)
        }
      })

      // A silent plugin is the failure mode this whole revision exists to
      // eliminate, so say so loudly if the controller never shows up. Bounded:
      // one warning, not a poll loop.
      ctx.effect(() => {
        const timer = setTimeout(() => {
          if (!mounted) {
            warn('workspace controller still unpublished after 20s; the pinned region and right-click pin will not appear')
          }
        }, SERVICE_WAIT_TIMEOUT_MS)
        return () => { clearTimeout(timer) }
      }, 'dsh-session-top: service wait diagnostic')
    }

    /** How long before an unpublished `workspaces` service is reported. */
    const SERVICE_WAIT_TIMEOUT_MS = 20000

    /**
     * Everything that needs a live Workspace controller: styles, the pinned
     * region, the context-menu graft and the fold reconciliation.
     *
     * Runs inside the `ctx.inject` child fiber, where `workspaces` is a declared
     * dependency — so it is published by construction and cannot be absent.
     *
     * @param {any} ctx - the child fiber context.
     * @param {(m: string) => void} warn - degradation logger.
     * @returns {string} a one-line capability summary for the boot log.
     */
    function mount(ctx, warn) {
      const sheets = injectStyles()
      const dynamicSheet = sheets.dynamic

      // Read the official services through `ctx.get`, NEVER through `ctx.<name>`.
      //
      // A context is a Proxy: touching an undeclared property throws
      // `cannot get property "uiWorkspace" without inject` (cordis
      // src/reflect.ts). That throw escapes `apply`, cordis logs it, and the
      // fiber is left in FiberState.LOADING — which the boot audit reports as
      // "web boot: 1 entry did not activate". `ctx.get(name)` walks the fiber
      // chain and returns undefined instead, which is what an optional service
      // needs. `ctx.effect` and `ctx.inject` are always available: both are
      // mixins on Context.
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')
      const uiWorkspace = ctx.get('uiWorkspace')
      const locale = ctx.get('locale')

      if (workspaces === undefined) {
        // Defensive only: `mount` runs inside a fiber that declares this
        // dependency, so the service is published by construction.
        warn('workspace controller vanished between inject and mount')
        return 'inert: no workspace controller'
      }

      /** Mutating actions; both are optional so a read-only baseline still renders. */
      const pinSession = typeof workspaces.pinSession === 'function'
        ? (id) => workspaces.pinSession(id)
        : undefined
      const unpinSession = typeof workspaces.unpinSession === 'function'
        ? (id) => workspaces.unpinSession(id)
        : undefined

      /**
       * Open a session through the official navigation seam, falling back to
       * the raw retain call when the ui-workspace service is absent.
       */
      const openSession = (id) => {
        try {
          if (typeof uiWorkspace?.openSession === 'function') {
            uiWorkspace.openSession(id)
            return
          }
        } catch (error) {
          warn(`openSession failed for ${id}: ${String(error)}`)
          return
        }
        try {
          sessions?.retain?.(id, { source: 'gateway' })
        } catch (error) {
          warn(`retain failed for ${id}: ${String(error)}`)
        }
      }

      /** @returns {Set<string>} the registry-global pin set. */
      const pinSet = () => {
        try {
          return new Set((workspaces.list.getSnapshot().pinnedSessionIds ?? []).map(String))
        } catch (error) {
          warn(`pin snapshot unreadable: ${String(error)}`)
          return new Set()
        }
      }

      /**
       * @returns {{workspaceId: string, title: string, sessionIds: string[]}[]} the workspace projection.
       */
      const workspaceItems = () => {
        try {
          return (workspaces.list.getSnapshot().items ?? []).map(item => ({
            workspaceId: String(item.workspaceId),
            title: String(item.title ?? item.workspaceId),
            sessionIds: (item.sessionIds ?? []).map(String),
          }))
        } catch {
          return []
        }
      }

      /** @returns {Record<string, any>} the session summaries by id. */
      const sessionById = () => {
        try {
          return sessions.list.getSnapshot().byId ?? {}
        } catch {
          return {}
        }
      }

      /** @returns {string[]} the currently selected session id, if any. */
      const currentSessionId = () => {
        try {
          for (const summary of Object.values(sessionById())) {
            if ((summary.retainedBy?.mainView ?? 0) > 0) return String(summary.id)
          }
        } catch { /* fall through */ }
        return undefined
      }

      // ---------------------------------------------------------------- DOM

      /**
       * The official sidebar's session list.
       *
       * Anchored on `[role="tree"][aria-label]`, which the official AnimatedRows
       * component sets on the list element. Absent whenever the sidebar is
       * collapsed to the 56px rail or the region has not mounted — both of
       * which mean "nothing to do", not "something broke".
       *
       * The search view renders its own `[role="tree"]`, so when several
       * candidates exist we pick the one that actually carries session rows.
       * That check is a preference, not a requirement: with every workspace
       * group folded there are no `session:` rows left anywhere, and the
       * region must still find its anchor. The discriminator is therefore
       * "the tree that is not the search result list" — identified by the
       * search rows lacking `data-row-key` entirely.
       *
       * @returns {Element | null} the list element, or null.
       */
      const findTree = (flavor) => {
        const candidates = [...document.querySelectorAll(flavor.treeSelector)]
        if (candidates.length === 0) return null
        if (candidates.length === 1) return candidates[0]
        // The stock sidebar's search view renders its own `[role="tree"]`, so
        // prefer the one that actually carries session rows. codex-ui has a
        // single tree, so this only ever matters for the official flavor — and
        // it must stay a preference: with every group folded there are no
        // session rows left anywhere and the region still needs an anchor.
        const withSessionRows = candidates.find(
          candidate => candidate.querySelector(flavor.sessionSelector) !== null,
        )
        if (withSessionRows !== undefined) return withSessionRows
        return candidates.find(
          candidate => candidate.querySelector(`[${ROW_KEY_ATTR}^="${WORKSPACE_ROW_PREFIX}"]`) !== null,
        ) ?? candidates[0]
      }

      /**
       * Walk up from a pointer target to the nearest session row of the active
       * flavor. Pointer events land on the title span or the trailing time
       * cell, never on the row itself, so the search climbs.
       * @param {EventTarget | null} target - the event target.
       * @param {object | null} flavor - the detected sidebar.
       * @returns {{row: Element, id: string} | null} the row and its session id.
       */
      const findSessionRow = (target, flavor) => {
        if (flavor === null || target === null || typeof target !== 'object') return null
        const element = /** @type {Element} */ (target)
        if (typeof element.closest !== 'function') return null
        const row = element.closest(flavor.sessionSelector)
        if (!(row instanceof Element)) return null
        const id = flavor.sessionIdOf(row)
        return id === undefined ? null : { row, id }
      }

      /**
       * The element the pinned region is inserted into: the seat that owns the
       * tree body, one level above the scrollable list.
       *
       * Deliberately OUTSIDE the `[role="tree"]` element. The stock sidebar's
       * AnimatedRows reads *every* `[data-row-key]` inside its list to animate
       * row movement, so region rows reusing that key inside the list would be
       * read as rows that just vanished and get cloned into its exit overlay —
       * the region would visibly dissolve on the next re-render. Sitting above
       * the scroll clip also keeps "Pinned" anchored to the sidebar's top
       * instead of scrolling away with the workspace groups.
       *
       * @param {Element} tree - the session list element.
       * @returns {Element | null} the insertion parent, or null when unmounted.
       */
      const findTreeHost = (tree) => {
        const body = tree.parentElement
        if (body === null) return null
        const host = body.parentElement
        return host instanceof Element ? host : null
      }

      let regionEl = null
      let regionRoot = null
      let anchorEl = null
      let anchorRoot = null

      /** Create (once) the region and context-menu hosts, both plugin-owned. */
      const ensureHosts = () => {
        if (regionEl === null) {
          regionEl = document.createElement('div')
          regionEl.setAttribute('data-stp-region', '')
          regionRoot = createRoot(regionEl)
        }
        if (anchorEl === null) {
          anchorEl = document.createElement('div')
          anchorEl.setAttribute('data-stp-anchor', '')
          anchorEl.setAttribute('aria-hidden', 'true')
          anchorRoot = createRoot(anchorEl)
          document.body.appendChild(anchorEl)
        }
      }

      /** Detach the region element from the sidebar, leaving its React root alive. */
      const detachRegion = () => {
        if (regionEl !== null && regionEl.isConnected) regionEl.remove()
      }

      // ------------------------------------------------------------- render

      const translate = (key, fallback) => {
        try {
          const bound = locale?.bind?.('session-top')
          const value = bound?.(key)
          return typeof value === 'string' && value.length > 0 ? value : fallback
        } catch {
          return fallback
        }
      }

      const PINNED_LABEL = () => translate('region.pinned', '已置顶')

/**
       * Compact relative time, matching the official rows' format through the
       * shared `relativeTime` primitive. Falls back to an empty string when the
       * timestamp is unknown rather than printing an invalid date.
       * @param {unknown} updatedAt - epoch ms.
       * @returns {string} the compact label, possibly empty.
       */
      const timeLabel = (updatedAt) => {
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return ''
        try {
          const relative = primitives.relativeTime(updatedAt, Date.now())
          if (relative === null || relative === undefined) return ''
          if (relative.unit === 'now') return translate('time.now', '刚刚')
          const count = relative.n
          if (typeof count !== 'number') return ''
          return `${count}${unitSuffix(relative.unit)}`
        } catch {
          return ''
        }
      }

      /** Localized unit suffix for the compact relative-time format. */
      function unitSuffix(unit) {
        switch (unit) {
          case 'minute': return translate('time.minute', '分钟')
          case 'hour': return translate('time.hour', '小时')
          case 'day': return translate('time.day', '天')
          default: return translate(`time.${unit}`, '')
        }
      }

      const makeRow = (id, summary, selected) => {
        const title = typeof summary?.displayTitle === 'string' && summary.displayTitle.length > 0
          ? summary.displayTitle
          : id
        const time = timeLabel(summary?.updatedAt)
        return React.createElement(
          'div',
          {
            key: id,
            // Deliberately carries NO flavor marker. A `data-row-key="session:…"`
            // or `data-dcu-session` attribute here would make these rows
            // detectable as a host sidebar, and `detectFlavor` would then pick
            // the WRONG flavor whenever the host's own rows were not mounted
            // (all groups folded, search view, mid-render) — sending
            // right-clicks down the own-menu branch, where stopPropagation
            // kills the host's menu. Own rows are matched by `data-stp-row`.
            'data-stp-row': '',
            'data-stp-session': id,
            role: 'treeitem',
            tabIndex: 0,
            'aria-selected': selected ? 'true' : undefined,
            onClick: (event) => {
              event.stopPropagation()
              openSession(id)
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              openSession(id)
            },
          },
          React.createElement(
            'span',
            { 'data-stp-row-slot': '', 'aria-hidden': 'true' },
            React.createElement(primitives.IconPinFillRegular, { size: 13 }),
          ),
          React.createElement('span', { 'data-stp-row-title': '', title }, title),
          time.length > 0
            ? React.createElement('span', { 'data-stp-row-time': '', 'aria-hidden': 'true' }, time)
            : null,
        )
      }

      /** Render the pinned region for the current pin set. */
      const renderRegion = () => {
        if (regionRoot === null) return
        const pinned = [...pinSet()]
        if (pinned.length === 0) {
          regionRoot.render(null)
          detachRegion()
          return
        }
        const byId = sessionById()
        const current = currentSessionId()
        const rows = []
        for (const id of pinned) {
          const summary = byId[id]
          // A pinned id whose session has not loaded yet still gets a row so
          // the region does not flicker between renders.
          rows.push(makeRow(id, summary, id === current))
        }
        regionRoot.render(
          React.createElement(
            React.Fragment,
            null,
            React.createElement(
              'div',
              { 'data-stp-region-header': '', 'aria-hidden': 'true' },
              React.createElement(
                'span',
                null,
                React.createElement(primitives.IconPinFillRegular, { size: 12 }),
              ),
              React.createElement('span', null, PINNED_LABEL()),
              React.createElement('span', { 'data-stp-region-count': '' }, String(pinned.length)),
            ),
            ...rows,
          ),
        )
      }

      // ------------------------------------------------- group fold / unfold

      /**
       * Per-group record of which members were pinned at the last reconcile.
       * A change in this signature is the only thing that makes the plugin
       * touch a group's expansion.
       */
      const foldSignature = new Map()

      /**
       * Resolved group headers, cached so unpin can re-open a group whose rows
       * are (correctly) not rendered while it is folded.
       * @type {Map<string, Element>}
       */
      const headCache = new Map()

      /**
       * Locate a group's expandable header.
       *
       * The stock sidebar carries the workspace key on the header itself
       * (`data-row-key="workspace:<key>"`). codex-ui does not — its
       * `.dcu-wb-project-head` exposes only `aria-expanded` — so the head is
       * reached by DOM ancestry from one of the group's own session rows, and
       * cached for later re-use.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {string} key - the workspace id.
       * @returns {Element | null} the header element, or null when unresolved.
       */
      const groupHeader = (flavor, key) => {
        if (flavor === null || !isFoldableGroup(key)) return null
        if (flavor === FLAVOR_OFFICIAL) {
          return document.querySelector(
            `[role='tree'] [${ROW_KEY_ATTR}='${WORKSPACE_ROW_PREFIX}${cssEscape(key)}']`,
          )
        }
        const cached = headCache.get(key)
        if (cached !== undefined && cached.isConnected) return cached
        // Ancestry from any rendered member of this workspace.
        for (const item of workspaceItems()) {
          if (item.workspaceId !== key) continue
          for (const id of item.sessionIds) {
            const row = document.querySelector(
              `[role='tree'] [data-dcu-session="${cssEscape(id)}"]`,
            )
            if (row === null) continue
            const project = row.closest(flavor.projectClass)
            if (project === null) continue
            // Direct child scan rather than `:scope >`: same result, and it
            // needs no selector-engine support beyond a class match.
            const head = [...project.children].find(
              child => typeof child.matches === 'function' && child.matches(flavor.projectHeadClass),
            )
            if (head instanceof Element) {
              headCache.set(key, head)
              return head
            }
          }
        }
        return null
      }

      /**
       * Drive a group's expansion through its own header toggle.
       *
       * The expansion state lives in the sidebar's own store, which the plugin
       * cannot (and should not) write directly. Clicking the header is the
       * supported gesture in both renderings, so we click it — but only when the
       * observed `aria-expanded` disagrees with what we want. That check is what
       * makes this idempotent: a header already in the wanted state is never
       * clicked, so a re-render between our read and our click cannot
       * double-toggle.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {string} key - the group key.
       * @param {boolean} wantExpanded - the desired state.
       */
      const setGroupExpanded = (flavor, key, wantExpanded) => {
        const header = groupHeader(flavor, key)
        if (header === null) return
        if ((header.getAttribute('aria-expanded') === 'true') === wantExpanded) return
        try {
          header.click()
        } catch (error) {
          warn(`could not toggle group ${key}: ${String(error)}`)
        }
      }

      // ------------------------------------------------------ reconciliation

      let scheduled = false
      let lastFlavorId = undefined

      const reconcile = () => {
        scheduled = false
        try {
          // Re-probe every reconcile: the sidebar can mount, unmount or swap
          // long after the plugin did. A one-shot decision at mount left the
          // plugin permanently blind.
          invalidateFlavor()
          const flavor = currentFlavor(Date.now())
          const flavorId = flavor === null ? 'none' : flavor.id
          if (flavorId !== lastFlavorId) {
            console.info(`[dsh-session-top] sidebar flavor: ${flavorId}`)
            lastFlavorId = flavorId
          }
          applyStpTokens(flavor)
          const tree = flavor === null ? null : findTree(flavor)
          const host = tree === null ? null : findTreeHost(tree)
          if (host === null) {
            // No recognized sidebar: collapse the plugin's contribution and
            // forget every cached header, so a sidebar swap starts clean.
            detachRegion()
            if (regionRoot !== null) regionRoot.render(null)
            applyPinRules(dynamicSheet, null, [])
            headCache.clear()
            foldSignature.clear()
            return
          }
          const pinned = [...pinSet()]
          ensureHosts()
          applyPinRules(dynamicSheet, flavor, pinned)
          renderRegion()
          if (pinned.length > 0 && regionRoot !== null && regionEl.parentElement !== host) {
            host.insertBefore(regionEl, host.firstChild)
          } else if (pinned.length === 0) {
            detachRegion()
          }
          reconcileGroups(flavor, new Set(pinned))
        } catch (error) {
          // A reconcile failure must never take the sidebar with it.
          warn(`reconcile failed: ${String(error)}`)
        }
      }

      /**
       * Behavior 3/4's fold rule: a group holding a pinned session folds (the
       * spec's "原工作区分组默认折叠"), and expands again once its last pin is
       * gone so the returning session is visible where it went.
       *
       * Driven by a per-group signature of which of its members are pinned, so
       * a reconcile that changed nothing performs no clicks — the plugin never
       * opens or closes a group the user is working in, and the sidebar opens
       * exactly as it would without the plugin.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {ReadonlySet<string>} pinned - the current pin set.
       */
      const reconcileGroups = (flavor, pinned) => {
        const live = new Set()
        for (const workspace of workspaceItems()) {
          if (!isFoldableGroup(workspace.workspaceId)) continue
          if (workspace.sessionIds.length === 0) continue
          const key = workspace.workspaceId
          live.add(key)
          const signature = workspace.sessionIds.map(id => (pinned.has(id) ? '1' : '0')).join('')
          if (foldSignature.get(key) === signature) continue
          // The first sighting applies the spec's default too: a group holding a
          // pinned session folds on load, not only after a live pin. After this,
          // only a signature CHANGE re-touches the group, so a group the user
          // re-opens by hand stays open.
          foldSignature.set(key, signature)
          setGroupExpanded(flavor, key, !signature.includes('1'))
        }
        for (const key of [...foldSignature.keys()]) {
          if (!live.has(key)) foldSignature.delete(key)
        }
      }

      const scheduleReconcile = () => {
        if (scheduled) return
        scheduled = true
        setTimeout(reconcile, RECONCILE_DEBOUNCE_MS)
      }

      // ------------------------------------------------------ context menu

      let menuState = null
      /** Pending graft poll for the host-rendered (codex-ui) menu surface. */
      let augmentTimer = null

      const closeMenu = () => {
        if (anchorRoot !== null) anchorRoot.render(null)
        menuState = null
      }

      /**
       * Open the Pin/Unpin menu at the pointer.
       * @param {string} sessionId - the right-clicked session.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       */
      const openMenu = (sessionId, x, y) => {
        if (anchorRoot === null) return
        const pinned = pinSet().has(sessionId)
        const rect = {
          x, y, left: x, top: y, right: x, bottom: y,
          width: 0, height: 0,
          toJSON() { return this },
        }
        menuState = { sessionId, pinned }
        anchorRoot.render(
          React.createElement(
            primitives.Menu,
            {
              open: true,
              portal: true,
              autoFocus: true,
              onClose: closeMenu,
              getAnchorRect: () => rect,
              anchor: React.createElement('span', { 'data-stp-anchor': '' }),
              items: [
                {
                  id: 'toggle-pin',
                  label: pinned
                    ? translate('menu.unpin', '取消置顶')
                    : translate('menu.pin', '置顶该会话'),
                  icon: React.createElement(
                    pinned ? primitives.IconPinFillRegular : primitives.IconPinOutlineRegular,
                    null,
                  ),
                },
              ],
              onSelect: (id) => {
                if (id !== 'toggle-pin') return
                closeMenu()
                void togglePin(sessionId, !pinned)
              },
            },
          ),
        )
      }

      /**
       * Commit a pin/unpin through the official Host RPC, reporting a refusal
       * rather than leaving the UI silently out of step.
       * @param {string} sessionId - the target session.
       * @param {boolean} want - true to pin, false to unpin.
       */
      const togglePin = async (sessionId, want) => {
        const action = want ? pinSession : unpinSession
        if (action === undefined) {
          warn('this baseline exposes no workspace pin RPC; pinning is unavailable')
          return
        }
        try {
          await action(sessionId)
          scheduleReconcile()
        } catch (error) {
          warn(`${want ? 'pin' : 'unpin'} ${sessionId} rejected: ${String(error)}`)
        }
      }

      /**
       * Right-click on a session row.
       *
       * THE EVENT OWNERSHIP RULE, in one place. The only statement below that
       * may call `preventDefault` / `stopPropagation` is the last one, and it
       * is reachable only when the sidebar has been positively identified as
       * the STOCK sidebar. React delegates its listeners at the root container,
       * so any interruption during document-capture stops a host menu from ever
       * opening — which is how codex-ui's row menu died twice on a real
       * machine. An unrecognised sidebar is therefore OBSERVE-ONLY: no event
       * mutation, no menu of our own, no graft.
       *
       * Preconditions for each outcome:
       *   1. our own region row        → own menu   (we own that row; no host menu there)
       *   2. flavor === null           → observe only
       *   3. flavor.nativeContextMenu  → observe only + graft onto the host's menu
       *   4. flavor === FLAVOR_OFFICIAL→ own menu   (stock sidebar has no context menu)
       *
       * @param {MouseEvent} event - the contextmenu event.
       */
      const onContextMenu = (event) => {
        // (1) The plugin's own rows carry `data-stp-row` and no flavor marker,
        // so they are matched before any flavor detection.
        const ownRow = event.target !== null && typeof event.target === 'object'
          && typeof event.target.closest === 'function'
          ? event.target.closest('[data-stp-row]')
          : null
        if (ownRow instanceof Element) {
          event.preventDefault()
          event.stopPropagation()
          openOwnRowMenu(ownRow, event.clientX, event.clientY)
          return
        }

        const flavor = currentFlavor(Date.now())

        // (2) Unknown sidebar: observe only. Never touch the event.
        if (flavor === null) return

        const found = findSessionRow(event.target, flavor)
        if (found === null) return
        const { id } = found
        if (pinSession === undefined && pinSet().has(id) === false) return

        // (3) A sidebar that brings its own menu: leave the event untouched.
        if (flavor.nativeContextMenu) {
          augmentNativeMenu(id)
          return
        }

        // (4) Positively the stock sidebar: it has no context menu of its own,
        // so owning the gesture is correct — and this is the ONLY place in the
        // whole plugin that suppresses a host menu.
        event.preventDefault()
        event.stopPropagation()
        openMenu(id, event.clientX, event.clientY)
      }

      /**
       * The session id carried by one of the plugin's own region rows.
       * @param {Element} row - a `[data-stp-row]` element.
       * @returns {string | undefined} the session id.
       */
      const ownRowId = (row) => {
        const key = row.getAttribute('data-stp-session')
        return typeof key === 'string' && key.length > 0 ? key : undefined
      }

      /** Open the plugin's own menu for one of its region rows. */
      const openOwnRowMenu = (row, x, y) => {
        const id = ownRowId(row)
        if (id === undefined) return
        openMenu(id, x, y)
      }

      /**
       * Append a Pin/Unpin row to the sidebar's own open menu.
       *
       * Only ever touches a surface that appeared AFTER this right-click: any
       * menu already on screen belongs to someone else (a settings popover, the
       * sidebar nav), and appending a foreign row into an unrelated React-owned
       * menu is exactly the kind of thing that breaks the host.
       *
       * The surface is found by polling rather than with a MutationObserver, so
       * the host keeps its own render/position ordering.
       * @param {string} sessionId - the right-clicked session.
       */
      const augmentNativeMenu = (sessionId) => {
        if (augmentTimer !== null) return
        const preexisting = document.querySelectorAll('[data-menu-material][role="menu"]').length
        let attempts = 0
        const tryAttach = () => {
          augmentTimer = null
          attempts += 1
          const surfaces = [...document.querySelectorAll('[data-menu-material][role="menu"]')]
          // The host menu has not appeared yet, or something else opened first.
          if (surfaces.length <= preexisting) {
            if (attempts < 12) augmentTimer = setTimeout(tryAttach, 40)
            return
          }
          const surface = surfaces[surfaces.length - 1]
          try {
            if (attachPinRow(surface, sessionId)) {
              console.info(`[dsh-session-top] pin row grafted onto the native menu (${sessionId})`)
              return
            }
          } catch (error) {
            console.warn(`[dsh-session-top] pin row graft failed: ${describeError(error)}`)
            return
          }
          if (attempts < 12) augmentTimer = setTimeout(tryAttach, 40)
        }
        augmentTimer = setTimeout(tryAttach, 0)
      }

      /**
       * Insert the Pin/Unpin row into a rendered menu surface.
       *
       * The host renders each row as `<div class=itemWrap><button role=menuitem>`
       * directly inside the surface, so the row is appended as a sibling of the
       * last one. Our node is not owned by the host's reconciler, which is safe
       * for a short-lived menu: it is removed with the portal on close, and the
       * host does not re-render a menu that is merely open and hovered.
       *
       * @param {Element} surface - the menu surface element.
       * @param {string} sessionId - the session the menu belongs to.
       * @returns {boolean} true when the row was attached.
       */
      const attachPinRow = (surface, sessionId) => {
        if (surface.querySelector('[data-stp-pin-item]') !== null) return true
        const pinned = pinSet().has(sessionId)
        const wrap = document.createElement('div')
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.setAttribute('data-stp-pin-item', '')
        button.textContent = pinned
          ? translate('menu.unpin', '取消置顶')
          : translate('menu.pin', '置顶该会话')
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          closeNativeMenu()
          void togglePin(sessionId, !pinned)
        })
        wrap.appendChild(button)
        surface.appendChild(wrap)
        return true
      }

      /** Dismiss a host-rendered menu by pressing Escape / clicking away. */
      const closeNativeMenu = () => {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        } catch {
          document.body.click()
        }
      }

      // -------------------------------------------------------------- mount

      const disposers = []
      ctx.effect(() => {
        document.addEventListener('contextmenu', onContextMenu, true)

        // Re-run on every list/broadcast change: the pin set, the group
        // membership and the session summaries all drive the projection.
        const onWorkspaces = () => { scheduleReconcile() }
        const onSessions = () => { scheduleReconcile() }
        try {
          disposers.push(workspaces.list.subscribe(onWorkspaces))
        } catch (error) {
          warn(`workspace subscription failed: ${String(error)}`)
        }
        try {
          disposers.push(sessions.list.subscribe(onSessions))
        } catch (error) {
          warn(`session subscription failed: ${String(error)}`)
        }

        // React rewrites the whole list on every keystroke of search typing and
        // on every row animation; a mutation observer is the only signal that
        // covers structure we did not subscribe to (fold/unfold, view mode).
        const observer = new MutationObserver(() => { scheduleReconcile() })
        observer.observe(document.body, { childList: true, subtree: true })

        // Dismiss the context menu on any outside interaction.
        const onDismiss = (event) => {
          if (menuState === null) return
          if (event.type === 'keydown' && event.key !== 'Escape') return
          const target = event.target
          if (event.type === 'pointerdown' && target instanceof Element
            && target.closest(`[role='menu'], [data-stp-row]`) !== null) return
          closeMenu()
        }
        document.addEventListener('pointerdown', onDismiss, true)
        document.addEventListener('keydown', onDismiss, true)
        window.addEventListener('blur', onDismiss)
        window.addEventListener('resize', closeMenu)

        scheduleReconcile()

        return () => {
          observer.disconnect()
          document.removeEventListener('contextmenu', onContextMenu, true)
          document.removeEventListener('pointerdown', onDismiss, true)
          document.removeEventListener('keydown', onDismiss, true)
          window.removeEventListener('blur', onDismiss)
          window.removeEventListener('resize', closeMenu)
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch (error) {
              console.error('[dsh-session-top] dispose failed:', error)
            }
          }
          applyPinRules(dynamicSheet, null, [])
          applyStpTokens(null)
          headCache.clear()
          foldSignature.clear()
          if (augmentTimer !== null) {
            clearTimeout(augmentTimer)
            augmentTimer = null
          }
          try {
            regionRoot?.render(null)
            anchorRoot?.render(null)
          } catch { /* the roots are already gone with the document */ }
          detachRegion()
          if (anchorEl?.isConnected === true) anchorEl.remove()
          regionEl = null
          regionRoot = null
          anchorEl = null
          anchorRoot = null
        }
      }, 'dsh-session-top: pinned region and row context menu')

      // The boot log has to say what the plugin can actually do, because
      // "activated" alone cannot distinguish a live plugin from one whose pin
      // RPC or session controller never arrived. The sidebar flavor and the
      // workspace list phase matter too: `pinnedSessionIds` is legitimately
      // empty while the list is still loading, so a "pinned 0" printed at mount
      // time says nothing about the pin state.
      const flavorId = () => {
        const flavor = currentFlavor(Date.now())
        return flavor === null ? 'none' : flavor.id
      }
      const phaseOf = () => {
        try {
          return workspaces.list.getSnapshot().phase ?? 'unknown'
        } catch {
          return 'unknown'
        }
      }
      const summary = () => `flavor ${flavorId()}`
        + `, list ${phaseOf()}`
        + `, pin ${pinSession === undefined ? 'unavailable' : 'ok'}`
        + `, sessions ${sessions === undefined ? 'absent' : 'ok'}`
        + `, uiWorkspace ${uiWorkspace === undefined ? 'absent' : 'ok'}`
        + `, pinned ${pinSet().size}`

      // One extra line once the controller has actually loaded, so the pin
      // count reported at boot is not mistaken for "nothing is pinned".
      let announcedReady = false
      try {
        disposers.push(workspaces.list.subscribe(() => {
          if (announcedReady) return
          if (phaseOf() !== 'ready') return
          announcedReady = true
          console.info(`[dsh-session-top] workspace list ready — ${summary()}`)
        }))
      } catch (error) {
        warn(`could not watch the workspace list: ${describeError(error)}`)
      }

      return summary()
    }

    return { name, inject, apply }
  },
})