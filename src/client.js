/**
 * dsh-session-top — browser half.
 *
 * This file IS the shipped client bundle: the DSH client module system expects
 * `exports["./client"]` to be a self-registering closure factory
 * (`window.__ModuleLoader__.load({id, factory})`). It is hand-authored in that
 * format rather than produced by a bundler, so it has no build step.
 *
 * SELF-CONTAINED BY CONTRACT. The factory takes NO `require` parameter and
 * calls no module loader of any kind: every module it once required off the
 * platform table (react, react-dom/client,
 * @deepseek-ai/dsh-client-ui-primitives) is gone, and the whole visible
 * surface is now plain DOM + CSS injection. The desktop shell materializes
 * this factory while the module system is still coming up; a factory whose
 * body throws synchronously there leaves the entry short of its boot-ready
 * promise, and the shell's 60-second watchdog then drops it into recovery
 * mode. A require against a table that does not hold the word is exactly such
 * a synchronous throw, so requiring nothing is what keeps the boot green. The
 * pinned region, the row affordances and the context menu are therefore built
 * with `document.createElement` / `appendChild` and styled through the
 * stylesheet this file injects.
 *
 * What it does, against the five acceptance points:
 *
 *  1. Active float-up — the durable order itself is re-sorted by the host half
 *     through `insertSessionBefore`, so a session with new activity is above
 *     its inactive neighbours in BOTH the sidebar's "recent" and "manual"
 *     order modes. Here we only keep the flat pinned region in pin order.
 *  2. Right-click to pin — the pin actions are published into the SHARED
 *     session context menu that `@baihejiangnan/dsh-session-context-menu`
 *     renders, so a right-clicked row offers Pin / Unpin next to the host's own
 *     items. That owner's table is keyed on a well-known symbol and is created
 *     and maintained BY THE OWNER; this plugin registers into it, never forks a
 *     second one. When the owner is not on screen, the same two actions are
 *     offered from a small plugin-owned menu instead. Either way the gesture is
 *     claimed only on a positively identified host session row — with the owner
 *     live it is claimed by nobody, because the owner already builds the menu —
 *     and everywhere else the app's own context menu is untouched.
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
 * Degradation contract: every DOM touch is guarded, and the whole init runs
 * inside a try/catch that downgrades to a console warning. If the official
 * sidebar renames `data-row-key`, drops `[role="tree"]`, or changes its
 * layout, the plugin finds nothing and no-ops — the sidebar keeps rendering
 * exactly as it does without the plugin.
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
  factory: () => {
    'use strict'

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
      /**
       * Markers that still identify this sidebar when every group is folded.
       *
       * codex-ui keeps `.dcu-wb-tree[role="tree"]` mounted whatever the groups
       * inside it are doing, so it identifies the sidebar after the last session
       * row unmounts. Plugin-owned rows carry no host marker at all, so they can
       * never satisfy it.
       */
      foldedIdentitySelectors: [
        '.dcu-wb-tree[role="tree"]',
      ],
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
        background: '--dcu-sidebar-background',
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
      /**
       * What still identifies this sidebar when every group is folded.
       *
       * The stock sidebar's own group headers, keyed with the same
       * `workspace:<key>` `data-row-key` vocabulary as everything else it
       * renders (src/core.js restates the prefix as a literal here, and
       * test/core.test.js fails on any drift). This is the load-bearing
       * fallback: it stays mounted when every group is folded and the last
       * `session:` row is unmounted with them, so a fully folded sidebar is
       * still identifiable.
       *
       * What is deliberately NOT here: the list element itself. It used to be
       * accepted as proof, and that is the whole of R19's failure — `[role="tree"]
       * [aria-label]` is the generic shape of a labelled ARIA tree, so a file
       * tree, a search tree, any third-party widget with a role and a label
       * qualified, and the region was injected into its ancestor. No
       * "official container" selector has been invented to replace it: an empty
       * stock sidebar (no groups, no sessions) has no provable marker in the
       * host contract we can read, so it stays unknown and observe-only rather
       * than being guessed at.
       */
      foldedIdentitySelectors: [
        `[${ROW_KEY_ATTR}^="${WORKSPACE_ROW_PREFIX}"]`,
      ],
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
        // The stock sidebar exposes no surface token of its own; the CSS
        // `Canvas` fallback (which tracks the OS light/dark scheme) is correct
        // there, so this indirection stays unresolved and never fires.
        background: undefined,
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
     *
     * Identification is POSITIVE and it is all there is. A flavor is returned
     * only when something the HOST itself renders is on the page:
     *
     *   1. a host SESSION row — codex-ui's `data-dcu-session`, the stock
     *      sidebar's `data-row-key="session:<id>"`;
     *   2. a host marker that survives every group being folded — codex-ui's
     *      own container class, the stock sidebar's `workspace:<key>` headers.
     *
     * What is NOT proof is a generic `[role="tree"][aria-label]`. That shape
     * is what every labelled ARIA tree looks like; a file tree or a search
     * tree carries it, and accepting it is how this plugin used to mount its
     * Pinned region inside an unrelated widget's ancestors
     * (`UNRELATED_TREE_ANCHOR`, 1015.md §2 R19). Unknown is a first-class
     * answer: the reconcile collapses the plugin's contribution, no hide rule
     * is emitted, and the right-click is left to whoever really owns it.
     *
     * Nothing here caches a flavor forever: the markers are host nodes, so a
     * sidebar that is unmounted or replaced stops matching on the next probe
     * and the region is detached as before.
     * @returns {object | null} the flavor, or null when the sidebar is not proven.
     */
    const detectFlavor = () => {
      // (1) A host SESSION row: the most specific thing either rendering puts
      // on the page, and specific about WHICH sidebar this is.
      if (document.querySelector(FLAVOR_CODEX.sessionSelector) !== null) return FLAVOR_CODEX
      if (document.querySelector(FLAVOR_OFFICIAL.sessionSelector) !== null) return FLAVOR_OFFICIAL
      // (2) The folded-state markers. A lone labelled tree satisfies neither.
      for (const flavor of [FLAVOR_CODEX, FLAVOR_OFFICIAL]) {
        for (const selector of flavor.foldedIdentitySelectors) {
          if (document.querySelector(selector) !== null) return flavor
        }
      }
      return null
    }

    /** Every selector that proves a tree belongs to `flavor`'s host. */
    const identitySelectorsOf = (flavor) => [flavor.sessionSelector, ...flavor.foldedIdentitySelectors]

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
     *    this file's sibling test guards against. Only
     *    `@deepseek-ai/dsh-client-runtime` is named there, because that row is
     *    the client core every profile already loads; naming a UI package
     *    instead (the stock ui-sidebar, ui-workspace) can never resolve in the
     *    desktop profile, whose @deepseek-ai scope is not a profile
     *    dependency at all.
     *
     * Every service this plugin uses (`workspaces`, `sessions`, `uiWorkspace`,
     * `locale`) is therefore read defensively at apply time and null-checked,
     * and the bundle requires NO module whatsoever.
     */
    const inject = []

    const PLUGIN_ID = 'dsh-session-top'

    /**
     * Where one document's single-instance coordination lives.
     *
     * `Symbol.for` — not a module-level variable — because the region, the
     * stylesheet tags and the theme tokens are keyed by DOCUMENT, and the
     * document outlives any one evaluation of this file. A module-scoped
     * variable would give a freshly re-evaluated bundle (HMR, a second loader
     * entry) a second "owner" while the DOM it thinks it owns is the same one,
     * which is exactly the duplicate-instance failure this exists to prevent.
     */
    const LEASE_KEY = Symbol.for('dsh-session-top.document-lease')

    /**
     * Claim exclusive ownership of this document's region, styles and tokens.
     *
     * Two entries for the same package can reach `apply` on one page (two
     * bundle rows, a plugin-add row, a brief HMR overlap). Previously each
     * mounted its own region and observer, and BOTH wrote the same shared
     * `<style>` tags — so whichever instance was disposed last blanked the pin
     * rules out from under the survivor and the pinned rows it had been hiding
     * reappeared.
     *
     * The contract, stated so callers can rely on it:
     *
     *   - Claiming supersedes the previous owner: its teardown runs, and from
     *     that moment exactly one instance contributes to the page.
     *   - The lease is per DOCUMENT, so a second window or a second frame is
     *     never blocked by the first.
     *   - `release()` only clears shared resources when the caller still owns
     *     them. An instance disposed AFTER being superseded touches nothing,
     *     which is what stops an old teardown from erasing the new owner's
     *     rules and tokens.
     *   - Releasing does not forbid a later claim: a re-published controller,
     *     an HMR reload or a fresh apply can always take the lease again. The
     *     previous owner is retired, never permanently locked out.
     *
     * @param {Document} doc - the document being claimed.
     * @param {() => void} retire - this instance's teardown, run when a newer
     *   instance supersedes it.
     * @returns {{release: () => boolean}} the lease handle. `release()` reports
     *   whether the caller actually held it, which is what decides whether it
     *   may withdraw the shared stylesheet and theme tokens.
     */
    function acquireDocumentLease(doc, retire) {
      let lease = doc[LEASE_KEY]
      if (lease === undefined || lease === null) {
        lease = { owner: null, ownerToken: 0 }
        try {
          doc[LEASE_KEY] = lease
        } catch {
          // A document that refuses exotic properties (a locked-down renderer)
          // simply gets no cross-instance coordination; it is still a single
          // instance in every scenario that can actually produce this.
        }
      }
      lease.ownerToken += 1
      const token = lease.ownerToken
      // Supersede, never wait: the previous owner tears itself down. The token
      // is bumped BEFORE the old owner runs its teardown, so anything that old
      // owner releases in the meantime is correctly recognised as not-yours.
      const previous = lease.owner
      lease.owner = { token, retire }
      try {
        previous?.retire?.()
      } catch (error) {
        console.warn(`[dsh-session-top] could not retire the previous instance: ${describeError(error)}`)
      }
      return {
        release() {
          // Only the CURRENT owner may withdraw shared resources. Anyone else
          // releasing is a superseded instance whose rules are already gone.
          if (lease.owner?.token !== token) return false
          lease.owner = null
          return true
        },
      }
    }

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
[data-stp-row][aria-current='true'] { background: var(--stp-token-hover, rgba(127,127,127,.16)); }
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
/* The user-facing notice host. It is its OWN element, not the menu anchor: the
   anchor is positioned off-screen with zero size, so anything left inside it is
   off-screen too, and it carries the menu, which positions itself. This one is
   in the viewport with real size, real contrast and no aria-hidden anywhere on
   its ancestry, which is what makes an alert on it actually read out. */
[data-stp-notice] {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483001;
  display: flex; flex-direction: column; gap: 8px;
  max-width: min(360px, calc(100vw - 32px)); pointer-events: none;
}
[data-stp-alert] {
  pointer-events: auto;
  padding: 10px 12px; border-radius: 8px; box-sizing: border-box;
  border: 1px solid var(--stp-token-border, rgba(127,127,127,.32));
  background: var(--stp-token-bg, Canvas);
  color: var(--stp-token-primary, inherit);
  font: 400 13px/20px var(--stp-token-font, inherit);
  box-shadow: 0 8px 24px rgba(0,0,0,.24);
}
[data-stp-menu] {
  position: fixed; z-index: 2147483000;
  min-width: 148px; max-width: 260px; padding: 4px;
  border: 1px solid var(--stp-token-border, rgba(127,127,127,.32));
  border-radius: 8px; box-sizing: border-box;
  background: var(--stp-token-bg, Canvas);
  color: var(--stp-token-primary, inherit);
  box-shadow: 0 8px 24px rgba(0,0,0,.24);
  font: 400 13px/20px var(--stp-token-font, inherit);
  pointer-events: auto;
}
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
     * The two tags are treated differently on purpose. The static look is
     * constant, so rewriting it is a no-op. The dynamic sheet is NOT: it is
     * shared per document, and it is only ever blanked by `applyPinRules` when
     * the owner genuinely has no pinned sessions to hide. Initialising a fresh
     * mount by writing `''` into it would therefore erase the pin rules of an
     * instance that is still on the page and leave every pinned host row
     * flashing back visible until this instance's first reconcile. So `adopt`
     * only writes when it is the one creating the tag.
     *
     * @returns {{static: HTMLStyleElement | null, dynamic: HTMLStyleElement | null}} the two tags.
     */
    function injectStyles() {
      if (typeof document === 'undefined') return { static: null, dynamic: null }
      const head = document.head ?? document.documentElement
      if (head === null || head === undefined) return { static: null, dynamic: null }
      const locate = (name) => document.querySelector(`style[data-plugin='${PLUGIN_ID}'][data-stp-sheet='${name}']`)
      const make = (name, text) => {
        let tag = locate(name)
        if (tag === null) {
          tag = document.createElement('style')
          tag.setAttribute('data-plugin', PLUGIN_ID)
          tag.setAttribute('data-stp-sheet', name)
          head.appendChild(tag)
        }
        if (tag.textContent !== text) tag.textContent = text
        return tag
      }
      const adopt = name => {
        const existing = locate(name)
        // Existing content is somebody else's until this instance proves it owns
        // the sheet: `applyPinRules` overwrites it on the first reconcile, and
        // `teardown` blanks it on the way out if this instance still holds the
        // document lease. Neither needs a blanking step here.
        if (existing !== null) return existing
        return make(name, '')
      }
      return { static: make('static', STYLE_TEXT), dynamic: adopt('dynamic') }
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
    const TOKEN_PROPS = ['Hover', 'Primary', 'Secondary', 'Tertiary', 'Border', 'Font', 'Background']

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
     * This bundle activates in the same batch as every other plugin row, so
     * its fiber can start BEFORE the Workspace controller has published its
     * `workspaces` service. A previous revision read that service at apply
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

      // Everything below is DOM and service work against surfaces this plugin
      // does not own. The degradation contract is total: an init failure warns
      // once and the plugin stays inert, which is indistinguishable from "not
      // installed" to the user — and, critically, never throws back into
      // cordis, which would strand this fiber in LOADING and fail the web boot.
      try {
        if (typeof document === 'undefined') {
          warn('no document: nothing to attach to, staying inert')
          return
        }

        // NOT a `mounted` flag. A flag held in THIS closure outlives the fiber
        // it describes: cordis deactivates the child when an injected service is
        // revoked and re-runs the same callback when it is published again, so
        // a one-shot boolean set on the first mount made the second activation
        // return immediately and the pinned region never came back — while this
        // parent fiber stayed ACTIVE the whole time, so nothing reported a
        // problem. Dedupe belongs to a generation, and a generation belongs to
        // the fiber that owns it. `mountedOnce` here is only the boot
        // diagnostic's question ("has ANY generation ever mounted?"), never a
        // gate on mounting.
        let mountedOnce = false
        info('activated; waiting for the workspaces controller service')

        // The dependency that actually gates everything is the workspace
        // controller: it owns both the durable pin set this plugin renders and the
        // pin/unpin RPCs it writes.
        //
        // Each activation of this child fiber gets its OWN closure, so a revoked
        // controller leaves nothing behind that could refuse the next one.
        ctx.inject(['workspaces'], (child) => {
          try {
            const summary = mount(child, warn)
            mountedOnce = true
            info(`active (${summary})`)
          } catch (error) {
            // Nothing to reset: this generation owns no state outside its own
            // scope, so the next activation is not blocked by this failure.
            warn(`mount failed, staying inert: ${String(error)}`)
          }
        })

        // `sessions` is OPTIONAL, so it must not join the top-level `inject`
        // edge — a boot-time dependency on it would stop the plugin from
        // activating at all on a host that publishes it late. It gets its OWN
        // top-level child fiber instead, whose whole job is to follow the
        // service: publish -> mount's subscription, revoke -> release it,
        // republish -> take the next one. The PARENT fiber stays ACTIVE
        // throughout, which is the point of using a child rather than
        // `ctx.internal`/`ctx.service` bookkeeping.
        ctx.inject(['sessions'], (child) => {
          child.effect(() => {
            attachSessions(child.get('sessions'))
            // Released when the service is revoked, and nothing else: the next
            // activation of this fiber attaches the next one.
            return () => { attachSessions(undefined) }
          }, 'dsh-session-top: sessions subscription')
        })

        // A silent plugin is the failure mode this whole revision exists to
        // eliminate, so say so loudly if the controller never shows up. Bounded:
        // one warning, not a poll loop.
        ctx.effect(() => {
          const timer = setTimeout(() => {
            if (!mountedOnce) {
              warn('workspace controller still unpublished after 20s; the pinned region and right-click pin will not appear')
            }
          }, SERVICE_WAIT_TIMEOUT_MS)
          return () => { clearTimeout(timer) }
        }, 'dsh-session-top: service wait diagnostic')
      } catch (error) {
        warn(`init failed, staying inert: ${describeError(error)}`)
      }
    }

    /** How long before an unpublished `workspaces` service is reported. */
    const SERVICE_WAIT_TIMEOUT_MS = 20000

    /**
     * The current generation's session-subscription manager, published by
     * `mount` so the top-level `ctx.inject(['sessions'])` child fiber can drive
     * it.
     *
     * It lives HERE rather than inside the init effect on purpose: `mount` is a
     * sibling of that effect, not a closure inside it, so a `let` declared in the
     * effect body is not in `mount`'s scope at all — assigning it from there
     * threw `ReferenceError` in strict mode and every generation died quietly
     * with no region. A no-op until the first generation mounts, which is what
     * keeps the optional service from being "attached" by a fiber that owns no
     * state.
     * @type {(service: any) => void}
     */
    let attachSessions = () => {}

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
      // THE MOUNT GENERATION. One boolean, owned by this mount, flipped first
      // thing on teardown. Every asynchronous continuation in here — a pin RPC
      // that resolves after unmount, a menu hand-off already sitting in a
      // microtask, an alert timer, a reconcile — checks it before touching the
      // DOM. Without it, a pending unpin that resolved after dispose re-created
      // the region on a page that had already torn the plugin down.
      //
      // This says nothing about undoing host work: a pin that already reached
      // the workspace controller stays pinned. It only stops THIS instance from
      // rendering anything afterwards.
      let disposed = false
      /** @returns {boolean} whether this mount may still touch the document. */
      const alive = () => !disposed

      const disposers = []
      // Teardown, factored out of the effect below for two reasons: it must be
      // re-runnable (the document lease calls it directly when a newer instance
      // takes over), and every line in it has to be safe on the second run.
      let torndown = false
      /**
       * Every timer THIS mount has armed and not yet released.
       *
       * The per-site variables (`reconcileTimer`, `sharedMenuTimer`,
       * `timeLabelTimer`) are still where their own paths clear them, but they only
       * ever describe the handle that is current at that instant. A callback that
       * re-armed a timer while teardown was clearing its variable left a live
       * handle behind: measured on a single mount, a 250ms shared-menu retry and a
       * 60ms reconcile were still armed after dispose and only drained because they
       * fired once on their own. The set makes "dispose releases every timer" true by
       * construction instead of by remembering three variables.
       * @type {Set<unknown>}
       */
      const mountTimers = new Set()

      /** Register an armed timer so teardown can release it. */
      const ownTimer = (handle) => {
        mountTimers.add(handle)
        return handle
      }

      /** Release one timer this mount owns. */
      const releaseTimer = (handle) => {
        if (handle === null || handle === undefined) return
        mountTimers.delete(handle)
        clearTimeout(handle)
      }
      /**
       * The full teardown, published only once every binding it closes over
       * exists.
       *
       * `teardown` references eleven `const`s declared hundreds of lines below
       * it, so calling it during mount's own initialization would throw a TDZ
       * ReferenceError instead of cleaning up. That is reachable: the document
       * lease is claimed at the top of `mount`, and anything that fails
       * afterwards leaves an owner whose teardown is not callable yet.
       */
      let fullTeardown = null
      /**
       * What a newer instance calls when it takes this document over.
       *
       * Safe at ANY point in this mount's life, which is the whole point: it
       * only touches bindings declared above it. It always invalidates the
       * generation, and runs the full teardown when one has been published.
       *
       * The two states are different and both are normal:
       *
       *   - Died BEFORE the effect body published a teardown (e.g. while
       *     `injectStyles` was resolving the shared stylesheet): nothing was
       *     registered, so there is genuinely nothing to clean up.
       *   - Died INSIDE the effect body (e.g. a MutationObserver that refuses
       *     to observe): the document listener, the shared-menu registration
       *     and the subscriptions registered so far DO exist, and the body
       *     publishes `teardown` before its first resource for exactly that
       *     reason, so they are reclaimed here rather than left on the document.
       */
      const retire = () => {
        disposed = true
        if (typeof fullTeardown === 'function') fullTeardown()
      }
      const teardown = () => {
        // First, always: every later step is a decision about whether this
        // generation may still act, and it must already be answered "no".
        disposed = true
        if (torndown) return
        torndown = true
        observer?.disconnect()
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
        // Shared resources are withdrawn ONLY while this instance still owns
        // them. A superseded instance disposing late must not blank the pin
        // rules or the theme tokens of the instance that replaced it.
        if (lease.release()) {
          applyPinRules(dynamicSheet, null, [])
          applyStpTokens(null)
        }
        headCache.clear()
        foldSignature.clear()
        if (sharedMenuTimer !== null) {
          releaseTimer(sharedMenuTimer)
          sharedMenuTimer = null
        }
        // Every timer this plugin owns goes with it. A reconcile scheduled one
        // millisecond before teardown would otherwise run once more against a
        // torn-down DOM and re-attach the region the line below just detached.
        if (reconcileTimer !== null) {
          releaseTimer(reconcileTimer)
          reconcileTimer = null
        }
        for (const timer of alertTimers) clearTimeout(timer)
        alertTimers.clear()
        // And the rest, whichever call site armed them and whichever variable
        // happened to be current. Empty afterwards, which is the whole point.
        for (const timer of mountTimers) clearTimeout(timer)
        mountTimers.clear()
        // Leave the owner's table exactly as we found it. A stale entry would
        // keep rendering a dead Pin item in a menu nobody can act on.
        if (releaseSharedMenu !== null) releaseSharedMenu()
        try {
          clearRegion()
          clearChildren(anchorEl)
          clearChildren(noticeEl)
        } catch { /* the hosts are already gone with the document */ }
        detachRegion()
        if (anchorEl?.isConnected === true) anchorEl.remove()
        if (noticeEl?.isConnected === true) noticeEl.remove()
        regionEl = null
        anchorEl = null
        noticeEl = null
        // A fresh mount must be free to render again: the memo still describes
        // nodes that no longer exist.
        renderedRegionSignature = null
        scheduled = false
      }

      // Claimed before the first DOM contribution, so a second `apply` on this
      // document supersedes this one instead of racing it.
      let observer
      let onDismiss
      let dynamicSheet = null

      // THE SHARED STYLES ARE CLAIMED BEFORE THEY ARE TOUCHED.
      //
      // Order matters here. `injectStyles` creates (or adopts) the one dynamic
      // `<style>` tag this package shares per document, and creating it means
      // writing to a tag the PREVIOUS instance is still using. Doing that before
      // taking the lease left a window in which the outgoing owner's rules were
      // already gone and this instance had not yet written its own — a full
      // reconcile debounce (~60 ms) with the pinned host rows unhidden and
      // flashing back. Claiming first retires the old generation; its teardown
      // then declines to withdraw the shared stylesheet (it is no longer the
      // owner), and nothing is blanked between the two.
      //
      // `adopt` is what actually closes that window; this ordering is defence in
      // depth and is not covered by a test of its own.
      const lease = acquireDocumentLease(document, retire)
      const sheets = injectStyles()
      dynamicSheet = sheets.dynamic

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

      /** Pending alert-removal timers, so dispose can cancel every one of them. */
      const alertTimers = new Set()

      /**
       * The `sessions` service this mount is currently subscribed to, and how to
       * let it go.
       *
       * Two recovery paths, because the host has two:
       *
       *   - publish / revoke / republish go through the top-level
       *     `ctx.inject(['sessions'])` child fiber, which cordis activates and
       *     disposes for us;
       *   - a service REPLACED in place (`ctx.set`) produces no notification at
       *     all — no child re-activation, no event — so `refreshSessions` also
       *     compares the object identity on every reconcile and re-points the
       *     subscription itself.
       *
       * One place owns the subscription either way, so the old one is always
       * released before the next is taken: a stale listener on a dead store
       * would reconcile this plugin forever with nothing to show for it.
       */
      let attachedSessions = null
      let releaseSessions = null

      const attachSessionsTo = (service) => {
        if (service === attachedSessions) return
        if (releaseSessions !== null) {
          try {
            releaseSessions()
          } catch (error) {
            warn(`could not release the previous session subscription: ${describeError(error)}`)
          }
          releaseSessions = null
        }
        attachedSessions = service ?? null
        if (service === undefined || service === null) return
        try {
          releaseSessions = service.list.subscribe(() => { scheduleReconcile() })
        } catch (error) {
          warn(`session subscription failed: ${describeError(error)}`)
        }
      }

      attachSessions = attachSessionsTo
      const refreshSessions = () => {
        if (!alive()) return
        try {
          attachSessionsTo(ctx.get('sessions'))
        } catch (error) {
          warn(`sessions lookup failed: ${describeError(error)}`)
        }
      }

      /**
       * Show the user something actionable.
       *
       * This plugin's whole failure surface used to be `console.warn`, which
       * the desktop user never sees — a refused unpin looked exactly like a
       * broken click. A minimal `role="alert"` node makes the refusal visible
       * for a few seconds.
       *
       * It used to be appended to the MENU ANCHOR, which is
       * `position:fixed; left:-9999px; width:0; height:0` with
       * `aria-hidden="true"`. The alert had no positioning of its own, so it
       * stayed off-screen, and its `aria-hidden` ancestor excluded it from the
       * accessibility tree: the promised alert was neither visible nor
       * announced, and a refusal still looked like a click that did nothing.
       * It now goes into `noticeEl`, its own on-screen host (see `ensureHosts`).
       *
       * `reason` is part of the contract, not decoration: `unavailable` is a
       * capability this host does not have, `refused` is a capability that said
       * no. The user can act on those differently, and a test can assert that a
       * SUCCESSFUL action surfaces neither.
       *
       * @param {string} message - what went wrong, in the user's language.
       * @param {'unavailable' | 'refused'} reason - why the action did not happen.
       */
      const surfaceError = (message, reason) => {
        // An error from a generation that is already gone is not something this
        // page should hear about: it would create a new host and a new timer in
        // an instance that no longer owns anything. This check is also what
        // keeps a REJECTED RPC that settles after dispose from rebuilding the
        // DOM a torn-down instance was supposed to leave behind.
        if (!alive()) return
        warn(message)
        try {
          ensureHosts()
          if (noticeEl === null) return
          for (const stale of noticeEl.querySelectorAll('[data-stp-alert]')) stale.remove()
          const box = document.createElement('div')
          box.setAttribute('data-stp-alert', '')
          box.setAttribute('data-stp-alert-reason', reason)
          box.setAttribute('role', 'alert')
          box.textContent = message
          noticeEl.appendChild(box)
          // The removal timer is owned by the plugin, so dispose has to be able
          // to cancel it: a reload that leaves one pending would keep a detached
          // node (and this closure) alive for eight more seconds.
          const timer = setTimeout(() => {
            alertTimers.delete(timer)
            box.remove()
          }, 8000)
          alertTimers.add(timer)
        } catch (error) {
          console.warn(`[dsh-session-top] could not surface the error: ${describeError(error)}`)
        }
      }

      /**
       * Open a session through the official navigation seam.
       *
       * `uiWorkspace.openSession(id)` is the seam the host's own sidebar uses:
       * @michengai/dsh-codex-ui probes the `uiWorkspace` service on every open
       * and calls `uiWorkspace.openSession(id)` with the bare session id
       * (lib/client.js `openHostSession`). That is why the service is resolved
       * FRESH on every click instead of being captured at mount: it is optional,
       * it may be published after this fiber started, and a captured `undefined`
       * would silently disable navigation for the rest of the session.
       *
       * There is deliberately no fallback beyond it. `sessions.open(id)` existed
       * only in an older client-runtime and is NOT part of the live ClientSessions
       * contract (`{ids, byId, phase, projectionsBySession}`), and `retain` is
       * the reference-counted binding API, not navigation. A fallback that does
       * nothing is worse than a visible failure: this reports it on screen.
       * @param {any} ctx - the fiber context, re-read on every call.
       * @param {string} id - the session to open.
       */
      const openSession = (ctx, id) => {
        if (!alive()) return
        let ui = undefined
        try {
          ui = ctx.get('uiWorkspace')
        } catch (error) {
          warn(`uiWorkspace lookup failed: ${describeError(error)}`)
        }
        if (typeof ui?.openSession !== 'function') {
          surfaceError(translate(
            'nav.unavailable',
            '无法打开会话：本机未提供 uiWorkspace 导航服务',
          ), 'unavailable')
          return
        }
        try {
          ui.openSession(id)
        } catch (error) {
          surfaceError(`打开会话失败（${id}）：${describeError(error)}`, 'refused')
          return
        }
        // Matching the host's own chain (@michengai/dsh-codex-ui
        // `openConversation`, lib/client.js:183-199): opening a session also
        // dismisses whatever global panel is showing it — the Explore home, a
        // connector view — otherwise the conversation opens BEHIND the panel and
        // the user sees no change at all. `layout` is an optional service, so it
        // is probed the same way, fresh, and skipped when absent.
        try {
          const layout = ctx.get('layout')
          if (typeof layout?.selectPanel === 'function') layout.selectPanel(null)
        } catch (error) {
          warn(`could not dismiss the global panel: ${describeError(error)}`)
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

      /**
       * The `sessions` service, read FRESH.
       *
       * It used to be captured once here, at mount. A service that arrives
       * after this fiber started, or one that is revoked and later replaced by
       * a different object, then left the plugin reading a dead store for the
       * rest of the page's life: titles, the selection fallback and the summary
       * subscription all stopped tracking the live client.
       * @returns {any} the service, or `undefined` when it is not published.
       */
      const sessionsService = () => {
        try {
          return ctx.get('sessions')
        } catch {
          return undefined
        }
      }

      /** @returns {Record<string, any>} the session summaries by id. */
      const sessionById = () => {
        try {
          return sessionsService()?.list?.getSnapshot?.().byId ?? {}
        } catch {
          return {}
        }
      }

      /**
       * @returns {string | undefined} the currently selected session id.
       *
       * ONLY the two fields the live host actually sets, and nothing invented:
       *
       *   1. `uiWorkspace.mainReference.sessionId` — the main view's own
       *      reference handle, set by `UiWorkspaceService.replaceMain`
       *      (dsh-client-ui-workspace lib/client.js:969-995). This is the exact
       *      value the host's own sidebar highlights against.
       *   2. a summary flagged `retainedBy.mainView`, which is how that same
       *      service's `mainSessionId` finds the current session from the live
       *      ClientSessions snapshot `{ids, byId, phase, projectionsBySession}`
       *      (lib/client.js:259-261).
       *
       * A previous revision read `sessions.list.getSnapshot().current`. That
       * field does not exist on this host, and a test had mocked it into
       * existence, so the plugin's selection state was verified only against a
       * fiction. Both sources here are read fresh per reconcile, and when
       * neither answers the row is simply not highlighted.
       */
      const currentSessionId = () => {
        try {
          const ui = ctx.get('uiWorkspace')
          const reference = ui?.mainReference
          if (typeof reference?.sessionId === 'string' && reference.sessionId !== '') {
            return reference.sessionId
          }
        } catch (error) {
          warn(`uiWorkspace lookup for the current session failed: ${describeError(error)}`)
        }
        try {
          const byId = sessionsService()?.list?.getSnapshot?.().byId ?? {}
          for (const id of Object.keys(byId)) {
            const summary = byId[id]
            if (summary === undefined) continue
            if ((summary.retainedBy?.mainView ?? 0) > 0) {
              return String(summary.id ?? id)
            }
          }
        } catch { /* nothing is selected */ }
        return undefined
      }

      // ---------------------------------------------------------------- DOM

      /**
       * Does this element itself carry, or contain, a marker of `flavor`'s host?
       *
       * A host marker is the only thing that establishes which sidebar a tree
       * belongs to. A lone candidate is not accepted on the strength of its
       * being alone, and several unmarked candidates are not resolved by
       * taking the first.
       *
       * @param {Element} tree - the candidate list element.
       * @param {object} flavor - the detected sidebar.
       * @returns {boolean} true when this tree is provably the host's list.
       */
      const provesSidebar = (tree, flavor) => identitySelectorsOf(flavor).some(
        selector => tree.matches?.(selector) === true || tree.querySelector(selector) !== null,
      )

      /**
       * The official sidebar's session list.
       *
       * Anchored on `[role="tree"][aria-label]`, which the official AnimatedRows
       * component sets on the list element. Absent whenever the sidebar is
       * collapsed to the 56px rail or the region has not mounted — both of
       * which mean "nothing to do", not "something broke".
       *
       * That selector is only the CANDIDATE shape; the choice among candidates
       * is made by host markers, not by position. The stock sidebar's search
       * view renders its own `[role="tree"]`, so among several candidates only
       * one that actually carries host rows (or codex-ui's own container) may
       * be taken — and a candidate set in which none of them does yields
       * `null`, which detaches the region, empties the hide rules and leaves
       * every right-click to its real owner.
       *
       * @returns {Element | null} the list element, or null.
       */
      const findTree = (flavor) => {
        if (flavor === null) return null
        const candidates = [...document.querySelectorAll(flavor.treeSelector)]
        if (candidates.length === 0) return null
        // Document order among PROVEN candidates only — the same preference the
        // search view has always relied on, now restricted to trees that
        // actually carry a host marker.
        return candidates.find(candidate => provesSidebar(candidate, flavor)) ?? null
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
      let anchorEl = null
      let noticeEl = null

      /**
       * Create (once) the region, the context-menu host and the notice host,
       * all plugin-owned.
       *
       * Refused after teardown. This is the single choke point every async
       * continuation used to reach on its way back: a reconcile, a menu
       * hand-off or a rejected pin would find `regionEl === null` and build a
       * fresh one, re-attaching a plugin the page had already released.
       *
       * THREE HOSTS, THREE JOBS. The menu anchor stays off-screen and
       * zero-sized because the menu inside positions ITSELF; it must not carry
       * `aria-hidden` any more, because a `role="menu"` under an `aria-hidden`
       * ancestor is a menu no assistive technology can see. The notice host is
       * the opposite trade: in the viewport, real size, no `aria-hidden`
       * anywhere above it — that is what makes a `role="alert"` on it actually
       * announce, and what the R06 audit was about.
       */
      const ensureHosts = () => {
        if (!alive()) return
        if (regionEl === null) {
          regionEl = document.createElement('div')
          regionEl.setAttribute('data-stp-region', '')
        }
        if (anchorEl === null) {
          anchorEl = document.createElement('div')
          anchorEl.setAttribute('data-stp-anchor', '')
          document.body.appendChild(anchorEl)
        }
        if (noticeEl === null) {
          noticeEl = document.createElement('div')
          noticeEl.setAttribute('data-stp-notice', '')
          document.body.appendChild(noticeEl)
        }
      }

      /**
       * Detach the region element from the sidebar, leaving its content intact
       * so the next reconcile can re-attach it without rebuilding.
       */
      const detachRegion = () => {
        if (regionEl !== null && regionEl.isConnected) regionEl.remove()
      }

      /**
       * Empty a container the plugin owns.
       *
       * The plugin's own DOM only: nothing inside these hosts is rendered by
       * React, so a wholesale rebuild can never disturb a host-owned node.
       *
       * Walks a SNAPSHOT of `children` (it is a live collection in a real
       * document, and removing while iterating it skips nodes) and removes each
       * child with the node's own `remove()`, which every DOM — including the
       * minimal fakes these paths are exercised against — provides.
       *
       * @param {Element | null} el - the container to clear.
       */
      const clearChildren = (el) => {
        if (el === null || el === undefined) return
        try {
          for (const child of [...el.children]) child.remove()
        } catch (error) {
          warn(`could not clear a plugin host: ${describeError(error)}`)
        }
      }

      // ------------------------------------------------------------- render

      /**
       * The locale service's answer for one of our keys, or `fallback`.
       *
       * A MISSING entry commonly comes back as the key itself, which is a miss
       * and not a translation. Accepting it renders the literal string
       * `region.pinned` above the user's sessions, which is worse than the
       * built-in label — and it is the reason two different-looking headers
       * could both claim to be this plugin's region. Anything that is not a
       * non-empty string, or is the key we asked for, is a miss.
       * @param {string} key - the message key.
       * @param {string} fallback - the built-in label.
       * @returns {string} a label the user can read.
       */
      const translate = (key, fallback) => {
        try {
          const bound = locale?.bind?.('session-top')
          const value = bound?.(key)
          if (typeof value !== 'string' || value.length === 0 || value === key) return fallback
          return value
        } catch {
          return fallback
        }
      }

      const PINNED_LABEL = () => translate('region.pinned', '已置顶')

/** Decorative pin glyphs, standing in for the ui-primitives icons. */
      const PIN_GLYPH_FILLED = '\u{1F4CC}'
      const PIN_GLYPH_OUTLINE = '\u{1F4CD}'

      /**
       * Compact relative time, in the same `{unit, n}` shape the official rows
       * use, computed locally because the bundle requires no module. Falls back
       * to an empty string when the timestamp is unknown rather than printing
       * an invalid date.
       * @param {unknown} updatedAt - epoch ms.
       * @returns {string} the compact label, possibly empty.
       */
      const timeLabel = (updatedAt) => {
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return ''
        try {
          const delta = Math.max(0, Date.now() - updatedAt)
          if (delta < 60_000) return translate('time.now', '刚刚')
          const unit = delta < 3_600_000 ? 'minute' : delta < 86_400_000 ? 'hour' : 'day'
          const divisor = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000
          return `${Math.floor(delta / divisor)}${unitSuffix(unit)}`
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

      /**
       * The row's visible fields, derived from whatever summary is loaded.
       *
       * A pinned session with no summary yet still gets the row it had: the
       * title falls back to the id and the time cell is simply absent, which is
       * the stable placeholder the region has always shown.
       *
       * @param {string} id - the session id.
       * @param {object | undefined} summary - the session summary, if loaded.
       * @returns {{title: string, time: string}} the fields to render.
       */
      const rowFields = (id, summary) => ({
        title: typeof summary?.displayTitle === 'string' && summary.displayTitle.length > 0
          ? summary.displayTitle
          : id,
        time: timeLabel(summary?.updatedAt),
      })

      /**
       * Build one plugin-owned row node.
       *
       * Deliberately carries NO flavor marker. A `data-row-key="session:…"` or
       * `data-dcu-session` attribute here would make these rows detectable as a
       * host sidebar, and `detectFlavor` would then pick the WRONG flavor
       * whenever the host's own rows were not mounted (all groups folded,
       * search view, mid-render) — sending right-clicks down the own-menu
       * branch, where stopPropagation kills the host's menu. Own rows are
       * matched by `data-stp-row`.
       *
       * ALSO deliberately NOT `role="treeitem"`, and deliberately never
       * `aria-selected`. The shared owner's row test
       * (`dsh-session-context-menu` lib/client.js:104-109) is
       * `closest('[role="treeitem"]')` plus EITHER an `aria-selected` attribute
       * OR a descendant `button[aria-label]` naming 会话操作 / session action —
       * so a row wearing either marker is a session row as far as the owner is
       * concerned, and `resolveSession` (199-214) then answers from
       * `aria-selected="true"` with `state.current`: the CURRENT session, not
       * the row that was clicked. These rows are the rows where that mistake is
       * invisible, because the plugin's own rows are the only rows in the
       * sidebar that are not the session they name. Keeping them out of the
       * owner's vocabulary is what makes `openOwnRowMenu` able to hand the
       * gesture over deliberately instead of racing for it.
       *
       * `role="button"` with `tabindex` + Enter/Space is the honest role for a
       * clickable row that lives OUTSIDE the `[role="tree"]` (see
       * `findTreeHost`), and `aria-current` marks the active session without
       * borrowing a selection semantic that belongs to another widget.
       *
       * @param {string} id - the session id.
       * @param {object | undefined} summary - the session summary, if loaded.
       * @param {boolean} selected - whether this is the retained session.
       * @returns {Element} the row element.
       */
      const makeRow = (id, summary, selected) => {
        const { title, time } = rowFields(id, summary)

        const row = document.createElement('div')
        row.setAttribute('data-stp-row', '')
        row.setAttribute('data-stp-session', id)
        row.setAttribute('role', 'button')
        row.setAttribute('tabindex', '0')
        if (selected) row.setAttribute('aria-current', 'true')
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          openSession(ctx, id)
        })
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          openSession(ctx, id)
        })

        const slot = document.createElement('span')
        slot.setAttribute('data-stp-row-slot', '')
        slot.setAttribute('aria-hidden', 'true')
        slot.textContent = PIN_GLYPH_FILLED
        row.appendChild(slot)

        const label = document.createElement('span')
        label.setAttribute('data-stp-row-title', '')
        label.setAttribute('title', title)
        label.textContent = title
        row.appendChild(label)

        if (time.length > 0) {
          const cell = document.createElement('span')
          cell.setAttribute('data-stp-row-time', '')
          cell.setAttribute('aria-hidden', 'true')
          cell.textContent = time
          row.appendChild(cell)
        }
        return row
      }

      /**
       * What the region currently shows, as a comparable string.
       *
       * Everything the rendered DOM depends on: the pinned ids in order, each
       * one's title and timestamp, and which row is the active session.
       * @param {readonly string[]} pinned - the pinned ids, in render order.
       * @param {Record<string, any>} byId - the session summaries.
       * @param {string | undefined} current - the active session id.
       * @returns {string} the signature.
       */
      const regionSignature = (pinned, byId, current) => JSON.stringify([
        pinned,
        pinned.map(id => [id, byId[id]?.displayTitle ?? null, byId[id]?.updatedAt ?? null]),
        current ?? null,
      ])

      /** The signature of the last render; `null` until the first one. */
      let renderedRegionSignature = null

      /**
       * The rows currently in the region, keyed by session id, and the order
       * they sit in.
       *
       * This is the identity index that makes a pinned row REUSED rather than
       * rebuilt. The official pin sequence is the only ordering source, so
       * `renderedOrder` mirrors it exactly and nothing here re-sorts anything.
       */
      const renderedRows = new Map()
      let renderedOrder = []

      /** The region header and its label cell, kept across renders. */
      let regionHeaderEl = null
      let regionHeaderLabelEl = null

      /**
       * Write a row's time cell, creating or removing it only as needed.
       *
       * Split out of `updateRow` because the label is also refreshed on its own
       * schedule (see `refreshTimeLabels`), and that refresh must be able to
       * touch the cell without touching anything else on the row.
       *
       * @param {Element} row - the row node.
       * @param {object | undefined} summary - the session summary, if loaded.
       */
      const updateRowTime = (row, summary) => {
        const time = timeLabel(summary?.updatedAt)
        let cell = row.querySelector('[data-stp-row-time]')
        if (time.length === 0) {
          if (cell !== null) cell.remove()
          return
        }
        if (cell === null) {
          cell = document.createElement('span')
          cell.setAttribute('data-stp-row-time', '')
          cell.setAttribute('aria-hidden', 'true')
          cell.textContent = time
          row.appendChild(cell)
          return
        }
        if (cell.textContent !== time) cell.textContent = time
      }

      /**
       * Write a row's mutable fields, touching only what actually changed.
       *
       * Every write here is conditional. An assignment that does not change the
       * value is still a DOM mutation (and still feeds this plugin's own
       * MutationObserver), so "update in place" has to mean "assign when the
       * value differs", not "assign again".
       *
       * @param {Element} row - an existing row node.
       * @param {object | undefined} summary - the session summary, if loaded.
       * @param {boolean} selected - whether this is the retained session.
       */
      const updateRow = (row, summary, selected) => {
        const title = rowFields(row.getAttribute('data-stp-session'), summary).title
        const label = row.querySelector('[data-stp-row-title]')
        if (label !== null) {
          if (label.textContent !== title) label.textContent = title
          if (label.getAttribute('title') !== title) label.setAttribute('title', title)
        }
        updateRowTime(row, summary)
        if (selected) {
          if (row.getAttribute('aria-current') !== 'true') row.setAttribute('aria-current', 'true')
        } else if (row.hasAttribute('aria-current')) {
          row.removeAttribute('aria-current')
        }
      }

      // ---------------------------------------------- relative-time refresh

      /**
       * A relative-time label is derived from `Date.now()`, so it goes stale
       * on its own clock: with nothing else changing, the projection signature
       * never moves and the region keeps printing the label it rendered minutes
       * ago. The fix must NOT be a periodic full re-render — that is the
       * wholesale rebuild R08 just removed — so the refresh is driven by the
       * labels' own display buckets and writes nothing but the label text.
       */
      const TIME_LABEL_MIN_INTERVAL_MS = 1000
      const TIME_LABEL_MAX_INTERVAL_MS = 60000
      let timeLabelTimer = null
      /** Epoch ms the armed timer is due at, so a sooner edge can re-arm it. */
      let timeLabelDeadlineAt = Number.POSITIVE_INFINITY

      /**
       * When this timestamp's compact label next has to change.
       *
       * Exactly the bucket edges `timeLabel` renders: leaving "just now", and
       * crossing into the next minute, hour or day. One line per bucket, no
       * guessed cadence.
       *
       * @param {unknown} updatedAt - epoch ms.
       * @param {number} now - epoch ms, read once.
       * @returns {number} epoch ms of the next label change.
       */
      const nextTimeLabelChangeAt = (updatedAt, now) => {
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
          return now + TIME_LABEL_MAX_INTERVAL_MS
        }
        const delta = Math.max(0, now - updatedAt)
        if (delta < 60_000) return updatedAt + 60_000
        if (delta < 3_600_000) return updatedAt + (Math.floor(delta / 60_000) + 1) * 60_000
        if (delta < 86_400_000) return updatedAt + (Math.floor(delta / 3_600_000) + 1) * 3_600_000
        return updatedAt + (Math.floor(delta / 86_400_000) + 1) * 86_400_000
      }

      /**
       * Re-read every rendered label and write the ones that changed.
       *
       * Row nodes are not recreated, attributes are not touched, and a label
       * that already reads correctly is not written at all — so an idle region
       * costs one pass over its rows per minute and nothing else.
       */
      const refreshTimeLabels = () => {
        if (!alive() || regionEl === null || renderedRows.size === 0) return
        const byId = sessionById()
        for (const [id, row] of renderedRows) updateRowTime(row, byId[id])
      }

      /**
       * Arm the next label refresh, at the earliest bucket edge the region has.
       *
       * Bounded on both ends: never sooner than a second (a wall of rows
       * sitting one millisecond from an edge must not become a loop — and the
       * next edge is at least a bucket away, so a wake cannot immediately
       * re-arm onto the same one), and never later than a minute (a region of
       * rows with no timestamp still gets re-checked when the user comes back
       * to the tab).
       */
      const scheduleTimeLabelRefresh = () => {
        if (!alive()) return
        if (renderedRows.size === 0) {
          stopTimeLabelRefresh()
          return
        }
        const now = Date.now()
        const byId = sessionById()
        let next = now + TIME_LABEL_MAX_INTERVAL_MS
        for (const id of renderedRows.keys()) {
          const at = nextTimeLabelChangeAt(byId[id]?.updatedAt, now)
          if (at < next) next = at
        }
        const delay = Math.min(
          TIME_LABEL_MAX_INTERVAL_MS,
          Math.max(TIME_LABEL_MIN_INTERVAL_MS, next - now),
        )
        // A summary that just arrived can put an edge CLOSER than the one the
        // armed timer is waiting for, so an armed timer is only left alone when
        // it is already due no later than the new deadline.
        const deadline = now + delay
        if (timeLabelTimer !== null && deadline >= timeLabelDeadlineAt) return
        stopTimeLabelRefresh()
        timeLabelDeadlineAt = deadline
        timeLabelTimer = ownTimer(setTimeout(() => {
          mountTimers.delete(timeLabelTimer)
          timeLabelTimer = null
          timeLabelDeadlineAt = Number.POSITIVE_INFINITY
          refreshTimeLabels()
          scheduleTimeLabelRefresh()
        }, delay))
        // A label is a nicety; it must never be the reason a host process
        // stays alive. In a document `setTimeout` returns a number and this is
        // a no-op; where the timer does carry `unref` (a Node-hosted shell,
        // and the test harness), the refresh is detached from the event loop's
        // refcount and fires only while something else is keeping it running.
        timeLabelTimer.unref?.()
      }

      /** Drop the label refresh timer; the rows it served are going with it. */
      const stopTimeLabelRefresh = () => {
        if (timeLabelTimer === null) return
        releaseTimer(timeLabelTimer)
        timeLabelTimer = null
        timeLabelDeadlineAt = Number.POSITIVE_INFINITY
      }

      /**
       * Put one row where the official pin sequence says it belongs.
       *
       * Forward iteration, always inserting before whatever currently occupies
       * the wanted slot. That node is never removed, so each step is well
       * defined whether the row is moving up or down, and the DOM order stays
       * identical to `renderedOrder` at every step — which is what makes the
       * next step's index meaningful.
       *
       * @param {Element} row - the row node.
       * @param {number} index - its index within the official pin sequence.
       * @param {number} firstRowAt - the DOM slot the first row occupies.
       */
      const placeRow = (row, index, firstRowAt) => {
        const id = row.getAttribute('data-stp-session')
        const at = renderedOrder.indexOf(id)
        if (at === index) return
        if (at < 0) renderedOrder.push(id)
        else renderedOrder.splice(at, 1)
        const want = firstRowAt + index
        regionEl.insertBefore(row, regionEl.children[want] ?? null)
        renderedOrder.splice(index, 0, id)
      }

      /**
       * Drop every row and the header, and forget them.
       *
       * Called wherever the region is emptied on purpose (no recognized
       * sidebar, teardown). The identity index MUST go with the nodes it
       * describes: left behind it would claim rows that are no longer in the
       * document, and the next sidebar to appear would find an identical
       * projection and render nothing at all — a session the user had pinned
       * simply never coming back.
       */
      const clearRegion = () => {
        stopTimeLabelRefresh()
        renderedRows.clear()
        renderedOrder = []
        regionHeaderEl = null
        regionHeaderLabelEl = null
        clearChildren(regionEl)
      }

      /**
       * Render the pinned region for the current pin set.
       *
       * KEYED, not rebuilt. The official pin sequence says which rows exist and
       * in what order; an existing row is updated in place and only a session
       * that genuinely entered or left the pin set produces a node. Nothing is
       * written at all when the projection is unchanged.
       *
       * The wholesale rebuild this replaces was not only slow (measured at
       * P=1000: 4004 nodes and 2000 listeners created for one changed
       * `updatedAt`, zero old rows retained). It broke clicks: the browser
       * dispatches `click` on the nearest common ancestor of the pointerdown and
       * pointerup targets, so a row replaced mid-gesture never receives the
       * click, and keyboard focus dies with it. That is why identity is
       * load-bearing here rather than merely nice.
       */
      const renderRegion = () => {
        if (regionEl === null) return
        const pinned = [...pinSet()]
        const byId = sessionById()
        const current = currentSessionId()
        const signature = regionSignature(pinned, byId, current)
        if (signature === renderedRegionSignature) return
        renderedRegionSignature = signature

        // Retire the rows the pin set no longer names.
        const wanted = new Set(pinned)
        for (const [id, row] of [...renderedRows]) {
          if (wanted.has(id)) continue
          renderedRows.delete(id)
          renderedOrder.splice(renderedOrder.indexOf(id), 1)
          row.remove()
        }
        if (pinned.length === 0) {
          clearRegion()
          detachRegion()
          return
        }

        if (regionHeaderEl === null) {
          regionHeaderEl = document.createElement('div')
          regionHeaderEl.setAttribute('data-stp-region-header', '')
          regionHeaderEl.setAttribute('aria-hidden', 'true')
          const headIcon = document.createElement('span')
          headIcon.textContent = PIN_GLYPH_FILLED
          regionHeaderLabelEl = document.createElement('span')
          const headCount = document.createElement('span')
          headCount.setAttribute('data-stp-region-count', '')
          regionHeaderEl.appendChild(headIcon)
          regionHeaderEl.appendChild(regionHeaderLabelEl)
          regionHeaderEl.appendChild(headCount)
          // The header is aria-hidden (it is a visual label), so the GROUP is
          // what carries the name. `role="group"` rather than a tree role on
          // purpose: the region sits outside the sidebar's `[role="tree"]` and
          // its rows are `role="button"` (see `makeRow`).
          regionEl.setAttribute('role', 'group')
          regionEl.appendChild(regionHeaderEl)
        }
        const label = PINNED_LABEL()
        if (regionEl.getAttribute('aria-label') !== label) regionEl.setAttribute('aria-label', label)
        if (regionHeaderLabelEl.textContent !== label) regionHeaderLabelEl.textContent = label
        const count = regionHeaderEl.querySelector('[data-stp-region-count]')
        if (count.textContent !== String(pinned.length)) count.textContent = String(pinned.length)
        // `children` is an HTMLCollection in a real document, so the header's
        // slot is materialized once here rather than per row.
        const firstRowAt = [...regionEl.children].indexOf(regionHeaderEl) + 1

        for (const [index, id] of pinned.entries()) {
          const existing = renderedRows.get(id)
          if (existing === undefined) {
            // A pinned id whose session has not loaded yet still gets a row so
            // the region does not flicker between renders.
            const row = makeRow(id, byId[id], id === current)
            renderedRows.set(id, row)
            placeRow(row, index, firstRowAt)
          } else {
            updateRow(existing, byId[id], id === current)
            placeRow(existing, index, firstRowAt)
          }
        }
        scheduleTimeLabelRefresh()
      }

      // ------------------------------------------------- group fold / unfold

      /**
       * Per-group fold bookkeeping: which pinned-member set is CONFIRMED in the
       * host, and, while one is not, the single click in flight for it.
       *
       * The intent is keyed by WORKSPACE and by the STATE it is trying to
       * reach — never by the header element or by the signature. Both of those
       * are things the host is free to change while a click is in flight, and
       * treating either as a new question is what made a delayed host get
       * toggled twice: one header replacement was enough to look like "a new
       * widget, a new intent". See `reconcileGroups`.
       *
       * @type {Map<string, {
       *   confirmed: string | null,
       *   intent: null | {
       *     wantExpanded: boolean,
       *     before: string | null,
       *     attempts: number,
       *     undelivered: number,
       *   },
       * }>}
       */
      const foldSignature = new Map()

      /**
       * How many extra clicks an intent may get when the click was never
       * DELIVERED at all.
       *
       * This budget is not a refusal protocol, and it deliberately is not built
       * on one. There is no acknowledgement on the host's toggle, so the only
       * thing the plugin can observe is whether calling `header.click()` itself
       * threw — and in a browser that answer is always "no":
       *
       *   - HTML, `HTMLElement.click()`: the algorithm fires a synthetic click
       *     and returns. It has no failure mode to report.
       *   - DOM, "inner invoke": a listener callback that throws is REPORTED as
       *     an uncaught error and SWALLOWED. It never propagates out of
       *     `dispatchEvent()`, so it cannot reach the caller of `click()`.
       *
       * So a listener that blows up is invisible here, and the previous version
       * of this rule — which counted a thrown click as the one host signal that
       * could not be hidden — described a branch no browser can take. What is
       * left is a narrow, honest defence: if `click` is missing, replaced or
       * otherwise unusable, nothing was dispatched, nothing could have toggled,
       * and one more attempt later is safe. Everything else — including a host
       * whose handler throws — gets the S5b treatment: one click, then left
       * alone.
       *
       * `attempts` counts every click issued for the current intent, so
       * `attempts === 1` means "the first click, nothing retried yet";
       * `undelivered` counts how many of them never reached the host. The retry
       * is allowed exactly while `undelivered > 0 && attempts <=
       * CLICK_NOT_DELIVERED_RETRY_LIMIT`, which IS satisfiable: after one
       * undelivered click `attempts` is 1 against a limit of 1; after the retry
       * `attempts` is 2 and nothing more is allowed.
       *
       * Nothing else is a signal — not a read, not a timeout, not a
       * notification. See `reconcileGroups`.
       */
      const CLICK_NOT_DELIVERED_RETRY_LIMIT = 1

      /**
       * The group's PINNED MEMBERS as a set, in a form that does not move when
       * the session list does.
       *
       * Sorted, so `sort()` (stable, and the ids are already strings) makes the
       * signature a function of the member set alone. Session COUNT and session
       * ORDER are deliberately not in it: neither says anything about whether
       * this group still holds something the plugin put there.
       *
       * @param {readonly string[]} sessionIds - the group's members, in host order.
       * @param {ReadonlySet<string>} pinned - the current pin set.
       * @returns {string} the signature; `''` when the group holds no pin.
       */
      const pinnedMembers = (sessionIds, pinned) => sessionIds
        .filter(id => pinned.has(id))
        .sort()
        .join('\u0000')

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
       * Click a group's own header toggle — the only supported way to change a
       * group's expansion.
       *
       * The expansion state lives in the sidebar's own store, which the plugin
       * cannot (and should not) write directly. Both renderings expose the
       * header's own click, so that is what is used, and nothing else.
       *
       * The return value means DELIVERY, not outcome. In a browser it is almost
       * always true: `HTMLElement.click()` fires a synthetic click and returns,
       * and a listener that throws is reported and swallowed inside dispatch
       * rather than propagating out (see `CLICK_NOT_DELIVERED_RETRY_LIMIT`).
       * false therefore means the call never got off the ground at all — `click`
       * missing or replaced — which is the one failure where "nothing was
       * toggled" is genuinely true. It is not, and must not be read as, an
       * acknowledgement of anything the host did with the click.
       *
       * @param {Element} header - the group's header element.
       * @param {string} key - the group key, for the log.
       * @returns {boolean} true when the click was delivered.
       */
      const toggleGroupHeader = (header, key) => {
        try {
          header.click()
          return true
        } catch (error) {
          warn(`could not deliver the toggle click for group ${key}: ${describeError(error)}`)
          return false
        }
      }

      // ------------------------------------------------------ reconciliation

      let scheduled = false
      let lastFlavorId = undefined

      /** The pending debounced reconcile timer, so dispose can cancel it. */
      let reconcileTimer = null

      const reconcile = () => {
        scheduled = false
        if (!alive()) return
        // Consumed here, at the only place that runs: a confirm pass that took
        // an early exit must not make the NEXT reconcile read-only too.
        const confirmOnly = confirmOnlyPass
        confirmOnlyPass = false
        try {
          // Re-probe every reconcile: the sidebar can mount, unmount or swap
          // long after the plugin did. A one-shot decision at mount left the
          // plugin permanently blind.
          // Before anything reads it: a `sessions` service swapped in place
          // notifies nobody, so the only place that can notice is a pass that
          // is already happening.
          refreshSessions()
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
            // The memo AND the row index describe DOM that no longer exists, so
            // they MUST go with the nodes they described. Left in place they
            // described an empty region: the next sidebar to appear found an
            // identical projection, `renderRegion` returned early on the
            // signature, and the region stayed permanently blank — a session the
            // user had pinned, with its header and rows, simply never came back.
            clearRegion()
            renderedRegionSignature = null
            applyPinRules(dynamicSheet, null, [])
            headCache.clear()
            foldSignature.clear()
            return
          }
          const pinned = [...pinSet()]
          ensureHosts()
          applyPinRules(dynamicSheet, flavor, pinned)
          renderRegion()
          if (pinned.length > 0 && regionEl !== null && regionEl.parentElement !== host) {
            host.insertBefore(regionEl, host.firstChild)
          } else if (pinned.length === 0) {
            detachRegion()
          }
          reconcileGroups(flavor, new Set(pinned), confirmOnly)
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
       * Three rules make that rule survivable, each of which was a separate
       * measured failure:
       *
       *  1. THE SIGNATURE IS THE SET OF PINNED MEMBERS. The previous signature
       *     was a positional bitmap of the group's whole session list, so
       *     re-ordering two sessions — or adding one that is not pinned at all —
       *     read as a pin change and re-folded a group the user had opened by
       *     hand (`GROUP_ORDER_ONLY_CHANGE`). A sorted member set is invariant
       *     under exactly those operations and nothing else.
       *  2. FIRST SIGHT WITH NO PIN TOUCHES NOTHING. Such a group is the user's
       *     alone: the plugin has never folded it and has no state to restore,
       *     so expanding it was taking something over (`GROUP_ZERO_PINS_INITIAL`
       *     turned a long-standing `false` into `true`).
       *  3. NOTHING IS BOOKED BEFORE IT HAPPENED. The previous code recorded the
       *     signature BEFORE looking for the header and clicking it, so a header
       *     that had not rendered yet, a click the host ignored and a click that
       *     threw were all remembered as done and never retried
       *     (`GROUP_HEADER_LATE`, `GROUP_TOGGLE_RETRY`). Here a group is marked
       *     confirmed only after its `aria-expanded` has been READ BACK in the
       *     wanted state, and an unanswered click stays answerable.
       *
       * A click in flight is NOT retried on any ordinary signal. There is no
       * acknowledgement contract on the host's toggle: `click()` returns before
       * the state lands, and until it lands the reading is indistinguishable
       * from a click that will never be applied. Any gate made of elapsed time,
       * read counts or notification counts therefore only MOVES the window in
       * which a late host gets toggled twice — it cannot remove it. Measured: a
       * host that applies after 250ms, with one unrelated notification inside
       * that window, received two clicks and two toggles, and the group ended
       * in the opposite of the state the plugin wanted.
       *
       * THE SAME FAILURE HAS A SECOND FORM, and it is not about time at all. The
       * plugin is allowed to remember that it clicked; it is NOT allowed to
       * decide that the click is finished because the world looks different.
       * `groupHeader` is a live `querySelector` per pass, and a host that
       * re-renders its rows hands back a NEW element for the same workspace:
       * measured against a store-backed host whose toggle commits after
       * 300/400/600/1000ms, keying the pending on the header element produced
       * two clicks and two toggles on every one of those delays, with the
       * second click landing before the first had been committed. Element
       * identity is a fact about the DOM, not about the request; the request
       * belongs to the workspace and to the state it is trying to reach.
       *
       * So the rule is one-sided: ONE unconfirmed intent gets ONE click, and it
       * is spent. It is identified by (workspace, wanted state) and released
       * only by the READING MOVING — which is the one thing that proves the
       * in-flight click actually happened. On top of that:
       *
       *  1. an intent is in flight and the reading has NOT moved — this group
       *     belongs to that request, whatever the pin set says now, and the
       *     reached-state test below is NOT reached. Unpinning inside the host's
       *     commit window makes the wanted state equal the current reading, and
       *     booking it there is what used to write a group off while a toggle of
       *     ours was still on its way to it;
       *  2. within that, an intent for the OPPOSITE state is in flight: wait.
       *     The old click cannot be recalled, and clicking now would either
       *     toggle it twice or race the state it is about to change. Nothing is
       *     claimed about cancelling it; when it lands, the reading moves, and
       *     that is what releases it and re-evaluates the new target;
       *  3. the reading HAS moved — the click landed, or somebody else acted.
       *     The intent is spent, and the pass books the reached state or issues
       *     the new request from the new reading;
       *  4. the click could not be DELIVERED at all (`click` missing or
       *     replaced) — nothing reached the host, so nothing could have
       *     toggled, and one bounded retry is safe. See
       *     `CLICK_NOT_DELIVERED_RETRY_LIMIT` for why this is NOT a refusal
       *     signal: no browser reports a listener exception to this caller.
       *
       * What this rule deliberately gives up:
       *
       *   - a host that accepts a click and never applies it is left alone. The
       *     plugin does not fight it, does not toggle it back, and does not
       *     claim to have fixed it — a visible reason for the user is R06's
       *     business (alert host), not something to fake here;
       *   - a signature change that still wants the same state does NOT
       *     re-issue, because nothing about the request changed;
       *   - a header element that never existed yet still takes its first click
       *     when it appears: nothing was booked while it was missing.
       *
       * The withdrawn guarantees are recorded in task-2-report.md.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {ReadonlySet<string>} pinned - the current pin set.
       * @param {boolean} confirmOnly - true when this pass was scheduled by the
       *   plugin to check a click of its own; such a pass may read but not click.
       */
      const reconcileGroups = (flavor, pinned, confirmOnly) => {
        const live = new Set()
        for (const workspace of workspaceItems()) {
          if (!isFoldableGroup(workspace.workspaceId)) continue
          if (workspace.sessionIds.length === 0) continue
          const key = workspace.workspaceId
          live.add(key)
          const signature = pinnedMembers(workspace.sessionIds, pinned)
          let state = foldSignature.get(key)
          if (state === undefined) {
            state = {
              // `null` = "this group still has to reach the wanted state";
              // `''` = "nothing to do, the user's own expansion stands".
              confirmed: signature === '' ? signature : null,
              intent: null,
            }
            foldSignature.set(key, state)
            if (signature === '') continue
          }
          if (state.confirmed === signature) continue
          const wantExpanded = signature === ''
          const header = groupHeader(flavor, key)
          // Not rendered (yet). Nothing is booked, so the next notification
          // tries again.
          if (header === null) continue
          const now = header.getAttribute('aria-expanded')
          const intent = state.intent
          // IN FLIGHT CHECK FIRST, and it gates the booking below.
          //
          // While a click of ours is out and the reading still shows the value
          // it was issued against, that request owns this group. Booking it as
          // "already in the wanted state" first is what wrote off a group the
          // plugin then stopped watching: unpinning during the host's own commit
          // window makes the wanted state equal the CURRENT reading, so the
          // reached-state test fired, the intent was dropped, and the toggle
          // already on its way landed on a group nobody was looking at any more
          // — measured at a 400ms host, `final expanded=false` after the last pin
          // was gone.
          if (intent !== null && now === intent.before) {
            if (intent.wantExpanded !== wantExpanded) {
              // The opposite request, still in flight. It cannot be recalled and
              // nothing here can tell "not applied yet" from "never applied" for
              // it, so this pass waits. When it lands the reading moves, which is
              // what lets the new target be evaluated below.
              continue
            }
            // The same request, still unconfirmed: one click, already spent.
            if (confirmOnly) continue
            // Not a single ordinary notification. Only a click that never got
            // delivered unlocks the retry; see the constant for why that is
            // narrower than it sounds.
            if (intent.undelivered === 0) continue
            if (intent.attempts > CLICK_NOT_DELIVERED_RETRY_LIMIT) continue
            // Retrying in place. Replacing the record with a fresh one would
            // reset the budget on every failure, which is precisely the
            // "click forever" bug the budget exists to stop.
            intent.attempts += 1
          } else {
            // Nothing is in flight, or the reading moved: whatever click was out
            // has landed (or somebody else acted), so the intent is spent.
            state.intent = null
            if ((now === 'true') === wantExpanded) {
              // Reached. Book it, and let go of the intent: from here on an
              // ordinary notification for the SAME signature must not re-issue
              // it.
              state.confirmed = signature
              continue
            }
            state.intent = { wantExpanded, before: now, attempts: 1, undelivered: 0 }
          }
          if (toggleGroupHeader(header, key)) {
            scheduleConfirmPass()
          } else if (state.intent !== null) {
            // The click never reached the host, so nothing could have toggled.
            // Record that, and only that, as the reason a retry is allowed.
            state.intent.undelivered += 1
          }
        }
        for (const key of [...foldSignature.keys()]) {
          if (!live.has(key)) foldSignature.delete(key)
        }
      }

      /**
       * Is this a node the plugin itself owns?
       *
       * The pinned region, the context-menu anchor (and therefore anything inside
       * either), plus the stylesheet tags it injects. Nothing here is a signal
       * about the host, so it must not feed the observer.
       * @param {unknown} node - a node from a mutation record.
       * @returns {boolean} true when the node is plugin-owned.
       */
      const isOwnNode = (node) => {
        if (!(node instanceof Element)) return false
        if (node === regionEl || node === anchorEl) return true
        if (node.getAttribute?.('data-plugin') === PLUGIN_ID) return true
        return node.closest?.('[data-stp-region], [data-stp-anchor], [data-stp-notice]') != null
      }

      /**
       * Is this mutation record something the plugin did to itself?
       * @param {any} record - one MutationRecord.
       * @returns {boolean} true for plugin-owned edits.
       */
      const isOwnMutation = (record) => {
        if (record === undefined || record === null) return false
        if (isOwnNode(record.target)) return true
        for (const node of record.addedNodes ?? []) if (isOwnNode(node)) return true
        for (const node of record.removedNodes ?? []) if (isOwnNode(node)) return true
        return false
      }

      /**
       * Set while a reconcile is one the plugin scheduled to verify a fold
       * click of its own. That pass may READ but must not click: see the
       * guard in `reconcileGroups`.
       */
      let confirmOnlyPass = false

      /** Schedule the read-back that books (or does not book) a fold click. */
      const scheduleConfirmPass = () => {
        confirmOnlyPass = true
        scheduleReconcile()
      }

      const scheduleReconcile = () => {
        if (!alive()) return
        if (scheduled) return
        scheduled = true
        reconcileTimer = ownTimer(setTimeout(() => {
          mountTimers.delete(reconcileTimer)
          reconcileTimer = null
          reconcile()
        }, RECONCILE_DEBOUNCE_MS))
      }

      // ------------------------------------------------------ context menu

      /**
       * The right-click session menu belongs to
       * `@baihejiangnan/dsh-session-context-menu`. Its client half creates a
       * shared extension table on `globalThis` under a well-known symbol, takes
       * a lease on it while it is applied, renders every registered entry into
       * its own `.dshcm-menu`, and calls `visible({session, row})` /
       * `run({session, row, sessions, workspaces, close})` per entry.
       *
       * The table belongs to that owner. This plugin READS it and registers
       * into it; it never creates one. A second table would be an orphan nothing
       * ever renders, and a DOM graft into someone else's menu was what the
       * previous revision did instead — it searched for `[data-menu-material]`
       * surfaces that the owner does not use at all, so it matched zero menus
       * in the row's own timeframe and silently did nothing on every machine.
       */
      const CTX_MENU_KEY = Symbol.for('dsh.session-context-menu.extensions')
      const PIN_ENTRY_ID = 'dsh-session-top.pin'
      const UNPIN_ENTRY_ID = 'dsh-session-top.unpin'
      /** Order within the owner's extension list; the owner appends us after its own items. */
      const ENTRY_ORDER = 50

      /** @returns {{register: Function, list: Function} | undefined} the owner's table, when it exists. */
      const sharedMenuApi = () => {
        try {
          const api = globalThis[CTX_MENU_KEY]
          if (api === undefined || api === null) return undefined
          if (typeof api.register !== 'function' || typeof api.list !== 'function') return undefined
          return api
        } catch {
          return undefined
        }
      }

      /**
       * Are WE in that table right now? Read from the owner's own `list()`
       * rather than remembered from registration time: the owner can dispose
       * and drop its listener while our entry survives, and a plugin that keeps
       * believing it is registered would then hand the menu to nobody.
       * @param {object | undefined} api - the owner's table.
       * @returns {boolean} true when both entries are present.
       */
      const sharedMenuRegistered = (api) => {
        if (api === undefined) return false
        try {
          const ids = new Set(api.list().map(entry => entry?.id))
          return ids.has(PIN_ENTRY_ID) && ids.has(UNPIN_ENTRY_ID)
        } catch {
          return false
        }
      }

      /**
       * Is `session` a pinned one, read from the OFFICIAL pin set?
       *
       * Deliberately not "is this one of our own Pinned rows": a session can be
       * pinned from the host's own Pin row, from the owner's menu, or restored
       * from a previous run, and in every one of those cases the row that must
       * offer "Unpin" is an ordinary host row.
       * @param {unknown} session - the summary the owner resolved, if any.
       * @returns {string | undefined} the session id.
       */
      const sessionIdOfEntry = (session) => {
        const id = session?.id
        return typeof id === 'string' && id.length > 0 ? id : undefined
      }

      /**
       * Commit one shared-menu action: close the owner's menu first (the owner
       * closes it itself before `run`, and `close` is idempotent), then write the
       * pin state through the official workspace RPC.
       * @param {unknown} session - the resolved session.
       * @param {boolean} want - true to pin, false to unpin.
       * @param {(() => void) | undefined} close - the owner's menu closer.
       */
      const runSharedAction = (session, want, close) => {
        // The owner's table can invoke a `run` it was handed one tick before we
        // released it. A released entry must not go on to write.
        if (!alive()) return
        const id = sessionIdOfEntry(session)
        if (id === undefined) return
        try {
          close?.()
        } catch (error) {
          warn(`closing the shared menu failed: ${describeError(error)}`)
        }
        void togglePin(id, want)
      }

      /**
       * The two entries this plugin contributes.
       *
       * Both `visible` predicates are total: the owner calls them while it is
       * building its own menu, so a throw here would take the host's menu down
       * with us. They are mutually exclusive, which is what makes the pair read
       * as one toggle instead of two always-on buttons, and they ask the
       * official pin set — so a session pinned by any other route offers Unpin,
       * and a session this plugin has never seen offers Pin.
       */
      const pinEntry = () => ({
        id: PIN_ENTRY_ID,
        order: ENTRY_ORDER,
        label: translate('menu.pin', '置顶该会话'),
        visible: ({ session } = {}) => {
          try {
            const id = sessionIdOfEntry(session)
            return id !== undefined && pinSet().has(id) === false && pinSession !== undefined
          } catch {
            return false
          }
        },
        run: ({ session, close } = {}) => { runSharedAction(session, true, close) },
      })

      const unpinEntry = () => ({
        id: UNPIN_ENTRY_ID,
        order: ENTRY_ORDER + 1,
        label: translate('menu.unpin', '取消置顶'),
        visible: ({ session } = {}) => {
          try {
            const id = sessionIdOfEntry(session)
            return id !== undefined && pinSet().has(id) === true && unpinSession !== undefined
          } catch {
            return false
          }
        },
        run: ({ session, close } = {}) => { runSharedAction(session, false, close) },
      })

      /** Undo a partial registration: a rejected second entry must not leave the first behind. */
      let releaseSharedMenu = null

      /**
       * (Re)publish the two entries, if the owner's table exists right now.
       *
       * Apply order between two plugins is not guaranteed, so "we ran, therefore
       * the owner ran" is not evidence of anything. Both directions are covered:
       * this is called once at mount, retried on a bounded timer, and retried
       * again during every context menu — so an owner that comes up late still
       * gets the entries, and an owner that goes away and comes back gets them
       * re-published. Success stops the retry immediately.
       * @returns {boolean} true when we are in the table afterwards.
       */
      const registerSharedMenu = () => {
        if (releaseSharedMenu !== null) {
          const api = sharedMenuApi()
          if (sharedMenuRegistered(api)) return true
          // Our entries outlived the owner's table (owner disposed): drop them
          // before re-registering, so a later owner cannot reject the id.
          releaseSharedMenu()
        }
        const api = sharedMenuApi()
        if (api === undefined) return false
        const releases = []
        try {
          releases.push(api.register(pinEntry()))
          releases.push(api.register(unpinEntry()))
        } catch (error) {
          for (const release of releases) {
            try {
              release()
            } catch { /* the owner is already gone; nothing left to undo */ }
          }
          warn(`shared context menu registration rejected: ${describeError(error)}`)
          return false
        }
        releaseSharedMenu = () => {
          releaseSharedMenu = null
          for (const release of releases.splice(0)) {
            try {
              release()
            } catch (error) {
              warn(`shared context menu cleanup failed: ${describeError(error)}`)
            }
          }
        }
        console.info('[dsh-session-top] pin/unpin published into the shared session context menu')
        return true
      }

      /**
       * Bounded retry for a late-initializing owner. Not a poll loop: it stops
       * on the first success and gives up after the budget, leaving the
       * plugin-owned menu as the fallback.
       */
      const SHARED_MENU_RETRY_MS = 250
      const SHARED_MENU_RETRY_BUDGET = 80
      let sharedMenuAttempts = 0
      let sharedMenuTimer = null

      const scheduleSharedMenu = () => {
        if (releaseSharedMenu !== null) return
        if (sharedMenuAttempts >= SHARED_MENU_RETRY_BUDGET) return
        if (sharedMenuTimer !== null) return
        sharedMenuTimer = ownTimer(setTimeout(() => {
          mountTimers.delete(sharedMenuTimer)
          sharedMenuTimer = null
          sharedMenuAttempts += 1
          if (!registerSharedMenu()) scheduleSharedMenu()
        }, SHARED_MENU_RETRY_MS))
      }

      /**
       * Publish the entries if the owner's table is there, and keep the bounded
       * retry alive while it is not.
       *
       * Registration only — this NEVER decides who owns the right-click. The
       * table survives its owner: the owner drops its lease on dispose, but the
       * table is only deleted when it holds no entries either, and our two are
       * still in it. Reading `list()` therefore proves nothing about the owner
       * being alive, and treating it as proof is what made every right-click go
       * silent after the owner unloaded.
       * @returns {boolean} true when our entries are in the table.
       */
      const publishSharedMenu = () => {
        const api = sharedMenuApi()
        if (api === undefined) {
          scheduleSharedMenu()
          return false
        }
        if (sharedMenuRegistered(api)) return true
        return registerSharedMenu()
      }

      /**
       * Run `fn` once the current event dispatch has finished.
       *
       * A microtask is the earliest possible moment, and it is still after the
       * dispatch: the whole dispatch is one synchronous run-to-completion, so
       * every document-capture listener — the shared owner's included — has
       * already run by the time this callback executes.
       * @param {() => void} fn - the deferred work.
       */
      const afterDispatch = (fn) => {
        try {
          if (typeof queueMicrotask === 'function') {
            queueMicrotask(fn)
            return
          }
        } catch { /* fall through to the timer */ }
        setTimeout(fn, 0)
      }

      let menuState = null

      const closeMenu = () => {
        clearChildren(anchorEl)
        menuState = null
      }

      /**
       * Open the Pin/Unpin menu at the pointer.
       *
       * A plugin-owned fixed-position surface inside the anchor host, built the
       * same way the region is: the ui-primitives `Menu` cannot be required (the
       * bundle requires nothing), and a plain node keeps the menu entirely
       * outside the host's React tree, so no host render can clobber it.
       *
       * @param {string} sessionId - the right-clicked session.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       */
      const openMenu = (sessionId, x, y) => {
        // The anchor host is plugin-owned DOM and safe to create on demand: a
        // reconcile that ran before the sidebar existed would otherwise leave a
        // right-click with nowhere to render, silently.
        ensureHosts()
        if (!alive()) return
        if (anchorEl === null) return
        const pinned = pinSet().has(sessionId)
        closeMenu()
        menuState = { sessionId, pinned }

        const surface = document.createElement('div')
        surface.setAttribute('data-stp-menu', '')
        surface.setAttribute('role', 'menu')

        const item = document.createElement('button')
        item.type = 'button'
        item.setAttribute('role', 'menuitem')
        item.setAttribute('data-stp-pin-item', '')
        item.textContent = (pinned ? PIN_GLYPH_OUTLINE : PIN_GLYPH_FILLED)
          + (pinned ? translate('menu.unpin', '取消置顶') : translate('menu.pin', '置顶该会话'))
        item.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          closeMenu()
          if (!alive()) return
          void togglePin(sessionId, !pinned)
        })

        surface.appendChild(item)
        anchorEl.appendChild(surface)
        positionMenu(surface, x, y)
        try {
          item.focus?.()
        } catch { /* focusing is a nicety, not a contract */ }
      }

      /**
       * Place the menu at the pointer, nudged back inside the viewport so a
       * right-click near an edge cannot open it off-screen.
       *
       * @param {Element} surface - the menu surface element.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       */
      const positionMenu = (surface, x, y) => {
        try {
          const style = surface.style
          if (style === undefined || style === null) return
          const width = surface.offsetWidth ?? 0
          const height = surface.offsetHeight ?? 0
          const maxX = Math.max(0, (globalThis.innerWidth ?? width) - width - 4)
          const maxY = Math.max(0, (globalThis.innerHeight ?? height) - height - 4)
          style.setProperty('left', `${Math.max(0, Math.min(x, maxX))}px`)
          style.setProperty('top', `${Math.max(0, Math.min(y, maxY))}px`)
        } catch (error) {
          warn(`could not place the menu: ${describeError(error)}`)
        }
      }

      /**
       * Commit a pin/unpin through the official Host RPC, reporting a refusal
       * rather than leaving the UI silently out of step.
       * @param {string} sessionId - the target session.
       * @param {boolean} want - true to pin, false to unpin.
       */
      const togglePin = async (sessionId, want) => {
        const verb = want ? 'pin' : 'unpin'
        const action = want ? pinSession : unpinSession
        if (action === undefined) {
          surfaceError(translate(
            'pin.unavailable',
            '本机工作区服务未提供置顶接口',
          ), 'unavailable')
          return
        }
        // The RPC itself is NOT cancelled and is not pretended away: it has
        // already been handed to the host, and the host's pin set moves whether
        // or not this page is still listening. What is refused is everything
        // AFTER it — the reconcile that would re-render, and the alert that
        // would re-create hosts on a page this instance no longer serves.
        if (!alive()) return
        try {
          await action(sessionId)
          if (!alive()) return
          scheduleReconcile()
        } catch (error) {
          if (!alive()) return
          // A refusal the user cannot see is indistinguishable from a broken
          // click, so it is reported where they are looking.
          surfaceError(`${want ? '置顶' : '取消置顶'}失败（${sessionId}）：${describeError(error)}`, 'refused')
        }
      }

      /**
       * Right-click on a session row.
       *
       * THE EVENT OWNERSHIP RULE, in one place. React delegates its listeners
       * at the root container, so any interruption during document-capture stops
       * a host menu from ever opening. And ownership is decided by WHAT THE
       * EVENT DOES, never by asking whether the shared owner happens to be
       * loaded:
       *
       *   - the shared owner claims a gesture by handling it — it calls
       *     `preventDefault()` and `stopPropagation()` inside its own
       *     document-capture listener before it builds `.dshcm-menu`;
       *   - we are on the same node in the same phase, so at the moment this
       *     handler runs we cannot know whether its listener already ran or is
       *     still queued ahead of us in registration order.
       *
       * So the fallback is deferred by one microtask, which is after the whole
       * dispatch, and acts only on the observable outcome: an event somebody
       * else prevented is not ours. That holds when the owner is loaded, when it
       * was never loaded, and — the case a registry probe could never get right
       * — when it loaded, unloaded, and our entries are still sitting in its
       * table with nobody left to render them.
       *
       * Preconditions for each outcome:
       *   1. already handled           → observe only (whoever built a menu, wins)
       *   2. our own region row        → hand the gesture to the HOST'S OWN row
       *                                    for this session, at this pointer
       *                                    (`openOwnRowMenu`)
       *   3. flavor === null           → observe only
       *   4. a positively identified host session row, still unhandled → own menu
       *
       * @param {MouseEvent} event - the contextmenu event.
       */
      const onContextMenu = (event) => {
        if (!alive()) return
        // (1) Somebody already handled this one: the shared owner, or anything
        // else that got here first. Opening a second menu on top would leave the
        // user with two.
        if (event.defaultPrevented === true) return

        // (2) The plugin's own rows carry `data-stp-row` and no flavor marker,
        // so they are matched before any flavor detection. Claimed eagerly, and
        // safely: `makeRow` keeps them out of the owner's row vocabulary (no
        // `role="treeitem"`, no `aria-selected`, no action button), so the
        // shared owner cannot mistake one for a session row no matter which of
        // our two document-capture listeners was registered first. What the
        // claim is FOR is the hand-off — the row the user clicked is ours, and
        // the menu that opens on it must still be the host's own, built from the
        // host's own row for the same session.
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

        // (3) Unknown sidebar: observe only. Never touch the event.
        if (flavor === null) return

        const found = findSessionRow(event.target, flavor)
        if (found === null) return
        const { id } = found
        if (pinSession === undefined && pinSet().has(id) === false) return

        // Keep the shared table topped up for an owner that came up late; this
        // says nothing about ownership.
        publishSharedMenu()

        // (4) A real host session row of a recognized sidebar. Both renderings
        // are supported: the stock sidebar has no context menu of its own, and
        // codex-ui's is served by the shared owner, so reaching here with the
        // owner loaded means the dispatch finished unhandled.
        const x = event.clientX
        const y = event.clientY
        afterDispatch(() => {
          // The microtask is already queued by the time teardown can run, and a
          // queued microtask cannot be cancelled. What can be checked is the
          // generation it belongs to: a hand-off scheduled one instant before
          // unmount must not claim the gesture and open a menu afterwards.
          if (!alive()) return
          if (event.defaultPrevented === true) return
          event.preventDefault()
          openMenu(id, x, y)
        })
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

      /**
       * The REAL host row for a session id, if the host still has one mounted.
       *
       * A pinned session's own host row is not unmounted by pinning or by
       * folding its workspace group: the plugin hides it with a stylesheet
       * rule, and codex-ui collapses a group by setting `data-open="false"` plus
       * `inert` on the body (`dcu-wb-project-body`, lib/client.js:3592-3611,
       * :4540) rather than by dropping its children. So the row the host
       * rendered for this very session is still in the document, carrying the
       * host's own `aria-selected`, the host's own `button[aria-label="… 的会话
       * 操作"]` and the host's own ancestry into its workspace group.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {string} id - the session id.
       * @returns {Element | null} the host row, or null when it is not mounted.
       */
      const hostRowFor = (flavor, id) => {
        if (flavor === null || typeof id !== 'string' || id.length === 0) return null
        let rows = null
        try {
          rows = document.querySelectorAll(flavor.sessionSelector)
        } catch (error) {
          warn(`host session rows unreadable: ${describeError(error)}`)
          return null
        }
        for (const row of rows) {
          try {
            if (flavor.sessionIdOf(row) === id) return row
          } catch { /* an unreadable row is not this row; keep scanning */ }
        }
        return null
      }

      /**
       * Re-deliver a contextmenu onto another element, at the pointer the user
       * actually used.
       *
       * This is the whole hand-off. The shared owner listens on `document` in
       * the capture phase, so a dispatched event reaches it exactly as a real
       * one does — same node, same phase, same registration order — and it
       * then runs its own `rowFrom` / `resolveSession` / `officialAction`
       * against the REAL host row. Everything the menu can do (rename, archive,
       * delete, open in explorer, copy working directory, copy session id, fork,
       * refresh) is built and executed by the owner and the host, never
       * re-implemented here, and the `dsh:session-context-menu` event it
       * announces carries the real row so other extensions see the real row too.
       *
       * `cancelable: true` matters: the owner's `preventDefault()` is how the
       * claim becomes observable, both to us and to anything downstream.
       *
       * @param {Element} target - the element to dispatch on.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       * @returns {boolean} true when the event was constructed and dispatched.
       */
      const redispatchContextMenu = (target, x, y) => {
        if (typeof MouseEvent !== 'function') return false
        try {
          const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: globalThis.window,
            clientX: x,
            clientY: y,
            button: 2,
            buttons: 2,
          })
          target.dispatchEvent(event)
          return true
        } catch (error) {
          warn(`could not re-deliver the gesture to the host row: ${describeError(error)}`)
          return false
        }
      }

      /**
       * Open the menu for one of the plugin's own region rows.
       *
       * The pin actions are the owner's, not ours: the gesture is re-delivered
       * to the host's own row for this session and the owner builds its full
       * menu there, which is also where our Pin/Unpin entries are rendered
       * (see `pinEntry` / `unpinEntry`). That is what makes a pinned row offer
       * exactly what an ordinary host row offers, with the same session behind
       * it — instead of a plugin-owned menu holding one item.
       *
       * The plugin-owned menu is the FALLBACK, and it is reached only when
       * there is nothing to hand the gesture to: no host row mounted, or no
       * `MouseEvent` to build the re-delivery with. If the owner is simply
       * absent, this function's dispatch is still enough — our own
       * `onContextMenu` sees the re-delivered event on a host row, finds it
       * unhandled after the dispatch, and opens the fallback itself under the
       * same ownership rule every other gesture uses.
       *
       * @param {Element} row - a `[data-stp-row]` element.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       */
      const openOwnRowMenu = (row, x, y) => {
        const id = ownRowId(row)
        if (id === undefined) return
        const flavor = currentFlavor(Date.now())
        const hostRow = hostRowFor(flavor, id)
        if (hostRow !== null) {
          // Registration only; it says nothing about who owns the gesture.
          publishSharedMenu()
          if (redispatchContextMenu(hostRow, x, y)) return
        }
        openMenu(id, x, y)
      }

      // -------------------------------------------------------------- mount


      ctx.effect(() => {
        // Published HERE, as the first statement of the body and therefore
        // before the first resource is registered.
        //
        // The previous placement — after `ctx.effect` returned — left a hole:
        // the body registers a document listener, a shared-menu registration,
        // two subscriptions and an observer before it returns, so anything that
        // threw in between (a MutationObserver that refuses to observe is a
        // real failure) left those registered with no way to remove them. The
        // next instance's takeover then had nothing to call.
        //
        // Safe to publish this early because `teardown` only closes over
        // bindings that are ALL initialized by the time this body runs: mount's
        // own body has already executed past every `const` it references, and
        // `observer` / `onDismiss` are optional-chained or simply absent.
        fullTeardown = teardown
        document.addEventListener('contextmenu', onContextMenu, true)

        // Publish into the shared context menu as early as possible, then keep
        // trying on a bounded timer while it has not taken: which of the two
        // plugins applies first is not something this bundle can know.
        if (!registerSharedMenu()) scheduleSharedMenu()

        // Re-run on every list/broadcast change: the pin set, the group
        // membership and the session summaries all drive the projection.
        const onWorkspaces = () => { scheduleReconcile() }
        try {
          disposers.push(workspaces.list.subscribe(onWorkspaces))
        } catch (error) {
          warn(`workspace subscription failed: ${String(error)}`)
        }
        // Sessions are attached by `attachSessionsTo`, which the child fiber and
        // the per-reconcile identity check both go through — NOT captured here,
        // because a service object captured here is the one that goes stale.
        attachSessionsTo(sessionsService())

        // React rewrites the whole list on every keystroke of search typing and
        // on every row animation; a mutation observer is the only signal that
        // covers structure we did not subscribe to (fold/unfold, view mode).
        //
        // The plugin's OWN edits are filtered out. They are not a signal about
        // the host, and feeding them back in is what made the region rebuild
        // itself ~16 times a second forever.
        observer = new MutationObserver((records) => {
          if (!alive()) return
          const external = Array.from(records ?? []).filter(record => !isOwnMutation(record))
          if (external.length > 0) scheduleReconcile()
        })
        observer.observe(document.body, { childList: true, subtree: true })

        // Dismiss the context menu on any outside interaction.
        onDismiss = (event) => {
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

        return teardown
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
        + `, menu ${sharedMenuRegistered(sharedMenuApi()) ? 'shared' : 'own'}`
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