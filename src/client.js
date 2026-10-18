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
      //
      // OFFICIAL FIRST, AND THE ORDER IS LOAD-BEARING.
      //
      // Both renderings can be mounted at once. `@michengai/dsh-codex-ui`
      // registers its own `sidebar.workspaces` entry at `priority: -1`, so it
      // WINS that `single` slot against the stock `WorkspaceBrowser` (whose
      // entry sits at the default 0) — `entriesOfSlot` renders only the first
      // live entry per cell (`ui-slots/src/index.ts:1346-1375`). The official
      // browser therefore never mounts, and with it neither its
      // `data-row-key="session:…"` rows nor the tree that carries them.
      //
      // Probing codex first made that the wrong way round for the moment a
      // dcu element survives a codex-ui unload, or a profile mounts the
      // official tree next to a leftover one: the plugin then targets rows the
      // user cannot see and stops addressing the sidebar in front of them.
      // The stock sidebar's own search-results tree cannot cause a false
      // positive here — it renders `SearchResultItem` rows
      // (`WorkspaceBrowser.tsx:792`), and those carry `role="treeitem"` and a
      // hashed class but no `data-row-key` at all (`rows/Rows.tsx:482-500`),
      // so `data-row-key^="session:"` is only ever the official session list.
      if (document.querySelector(FLAVOR_OFFICIAL.sessionSelector) !== null) return FLAVOR_OFFICIAL
      if (document.querySelector(FLAVOR_CODEX.sessionSelector) !== null) return FLAVOR_CODEX
      // (2) The folded-state markers. A lone labelled tree satisfies neither.
      for (const flavor of [FLAVOR_OFFICIAL, FLAVOR_CODEX]) {
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

    // ------------------------------------------------- global-panels region

    /** State hook this plugin puts on the ONE nav it folds. */
    const PANELS_STATE_ATTR = 'data-stp-panels'
    /** The control's own attribute, so it can be found again after a re-render. */
    const PANELS_TOGGLE_ATTR = 'data-stp-panels-toggle'
    /** The id this plugin lends the nav so `aria-controls` has a target. */
    const PANELS_ID = 'dsh-session-top-panels'
    /**
     * The remembered choice. Namespaced to this plugin and to nothing else:
     * a key that collided with a host or another plugin's would let either of
     * them silently decide whether the region is folded.
     */
    const PANELS_STORAGE_KEY = 'dsh-session-top:panels-collapsed'
    /** The host's own nav vocabulary — `SidebarRoot.tsx:280`. */
    const PANELS_NAV_SELECTOR = 'nav[class*="panelList"]'
    /** What the folded control says it is, and what the host calls the region. */
    const PANELS_TOGGLE_LABEL = '全局面板'

    /**
     * Is this element inside the sidebar's collapsed rail?
     *
     * The rail is a whole-sidebar state the HOST owns and renders correctly on
     * its own (its own CSS drops the panel list there, and shows the icons it
     * wants). Folding a region that is not on screen is not "tidier" — it is
     * the plugin's preference applied to a layout the user did not choose, and
     * it fights the expand/collapse toggle they are about to use.
     * @param {Element | null} element - a node inside the sidebar.
     * @returns {boolean} true when the rail is in effect.
     */
    function sidebarRailIn(element) {
      for (let node = element; node != null && typeof node.matches === 'function'; node = node.parentElement) {
        if (typeof node.className === 'string' && node.className.split(/\s+/).some(c => c.includes('collapsed'))) return true
        if (node.getAttribute?.('data-sidebar-collapsed') === 'true') return true
      }
      return false
    }

    /**
     * Read the remembered panels state.
     *
     * Absent, unreadable and "no preference recorded" are the same answer —
     * FOLDED — which is the whole point of the default. Every access is guarded:
     * storage throws in private mode, with site data disabled and on a quota
     * error, and a preference is never worth taking the region down for.
     * @returns {boolean} true when the region should start folded.
     */
    function readPanelsPreference() {
      try {
        const raw = globalThis.localStorage?.getItem?.(PANELS_STORAGE_KEY)
        // Only an explicit "0" is an expanded region. Anything else — absent,
        // a value another version wrote, junk — is the default.
        return raw !== '0'
      } catch {
        return true
      }
    }

    /**
     * Record the user's explicit choice. Best effort, and never fatal.
     * @param {boolean} collapsed - the state the user just chose.
     */
    function writePanelsPreference(collapsed) {
      try {
        globalThis.localStorage?.setItem?.(PANELS_STORAGE_KEY, collapsed === true ? '1' : '0')
      } catch { /* the region still works, it just will not be remembered */ }
    }

    // ------------------------------------------- workspace-directory region

    /**
     * The state hook on the ONE body this plugin folds: the seat the host
     * renders the workspace directory headers AND their sessions into
     * (`WorkspaceBrowser.tsx:669` — `HoverCardGroup` > AnimatedRows + fade).
     */
    const GROUPS_STATE_ATTR = 'data-stp-groups'
    /** The marker, so the rule can only ever reach a body this plugin proved. */
    const GROUPS_BODY_ATTR = 'data-stp-groups-body'
    /** The control's own attribute, so it is found again after a re-render. */
    const GROUPS_TOGGLE_ATTR = 'data-stp-groups-toggle'
    /** The id lent to the body so `aria-controls` has a target. */
    const GROUPS_ID = 'dsh-session-top-groups'
    /**
     * The remembered choice, under this plugin's own key. Only the literal
     * `'1'` folds: an absent key, junk, or another version's value all mean the
     * default, which is EXPANDED — the directories being closed one by one is
     * the tidying that matters, hiding the whole column is the user's call.
     */
    const GROUPS_STORAGE_KEY = 'dsh-session-top:groups-collapsed'
    /** What the folded control says it is, and what the host calls the region. */
    const GROUPS_TOGGLE_LABEL = '工作区目录'

    /** @returns {boolean} the remembered state; the default on any refusal. */
    function readGroupsPreference() {
      try {
        return globalThis.localStorage?.getItem?.(GROUPS_STORAGE_KEY) === '1'
      } catch {
        return false
      }
    }

    /** Record the fold the user just chose. Never fatal. */
    function writeGroupsPreference(collapsed) {
      try {
        globalThis.localStorage?.setItem?.(GROUPS_STORAGE_KEY, collapsed === true ? '1' : '0')
      } catch { /* the fold still works, it just will not be remembered */ }
    }

    // ------------------------------------------------- pinned-region fold

    /**
     * The state hook on the region element, so the stylesheet decides what is
     * hidden and no row is ever removed: a row destroyed and re-created is a
     * different node at the pointerup, and the click then lands on the common
     * ancestor instead.
     */
    const REGION_COLLAPSED_ATTR = 'data-stp-collapsed'

    /**
     * The remembered fold, under this plugin's own key. Only the literal
     * `'1'` means folded; anything else is the default, which is EXPANDED.
     */
    const REGION_COLLAPSED_STORAGE_KEY = 'dsh-session-top:region-collapsed'

    /** @returns {boolean} the remembered state; the default on any refusal. */
    function readRegionCollapsed() {
      try {
        return globalThis.localStorage?.getItem?.(REGION_COLLAPSED_STORAGE_KEY) === '1'
      } catch {
        return false
      }
    }

    /**
     * Record the fold the user just chose. Never fatal.
     * @param {boolean} collapsed - the state the user chose.
     */
    function writeRegionCollapsed(collapsed) {
      try {
        globalThis.localStorage?.setItem?.(REGION_COLLAPSED_STORAGE_KEY, collapsed === true ? '1' : '0')
      } catch { /* the fold still works, it just will not be remembered */ }
    }

    // ------------------------------------------------------- row colours

    /**
     * Per-session background colours, under this plugin's own key. Never the
     * host's settings and never the pin registry: a colour is a local
     * preference and must survive an unpin/repin pair.
     */
    const ROW_COLORS_STORAGE_KEY = 'dsh-session-top:row-colors'

    /**
     * A colour, or null. Strictly six hex digits, so `#000000` is an ordinary
     * colour and never doubles as a "clear it" sentinel, and nothing else
     * reaches the stylesheet.
     * @param {unknown} value - the candidate.
     * @returns {string | null} the normalized colour, or null.
     */
    function normalizeRowColor(value) {
      if (typeof value !== 'string') return null
      return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null
    }

    /** The colour a swatch shows when a row has none of its own. */
    const EMPTY_SWATCH_HEX = '#ffffff'

    /** Presence + value: the row's colour, and what the CSS keys on. */
    const ROW_COLOR_ATTR = 'data-stp-color'
    /** The colour control at a row's trailing edge. */
    const SWATCH_ATTR = 'data-stp-row-color'
    /** On the swatch: it stands for a colour the row actually carries. */
    const SWATCH_SET_ATTR = 'data-stp-row-color-set'

    /**
     * The plugin's own colour dialog: a six-digit hex box with 应用 / 取消 /
     * 恢复默认, a native swatch beside it as a helper, Escape to cancel, Enter
     * to apply, and focus handed back to whatever opened it.
     *
     * Its own element in the viewport, NOT inside `[data-stp-anchor]`: the
     * anchor is off-screen with zero size and carries the menu, which positions
     * itself. A dialog in there would be invisible and outside the tab order's
     * viewport, which is the failure the notice host already had to be split off
     * to avoid.
     */
    const COLOR_DIALOG_ATTR = 'data-stp-color-dialog'
    /** The hex field: the only control that commits. */
    const COLOR_HEX_ATTR = 'data-stp-color-hex'
    /** The native `<input type="color">`, a helper and nothing more. */
    const COLOR_NATIVE_ATTR = 'data-stp-color-native'
    /** 应用 / 取消 / 恢复默认. */
    const COLOR_BUTTON_ATTR = 'data-stp-color-button'
    const COLOR_APPLY_ATTR = 'data-stp-color-apply'
    const COLOR_CANCEL_ATTR = 'data-stp-color-cancel'
    const COLOR_RESET_ATTR = 'data-stp-color-reset'
    const COLOR_ERROR_ATTR = 'data-stp-color-error'

    /* ------------------------------------------------------------- the footer
       Four markers, one per element the compaction rules are allowed to reach.
       They are DOM on HOST nodes, so they are handed back on every teardown and
       whatever else the lease says — a marked node this instance can no longer
       justify must not stay marked. Each is written only onto an element a
       PROVEN lookup found: the balance region and the import control are
       located by their own stable aria-labels inside the sidebar root this
       plugin already proved, and the footer host is the nearest common
       ancestor of those two (never a page-wide sweep for buttons). */
    const FOOTER_ATTR = 'data-stp-footer'
    const FOOTER_BALANCE_ATTR = 'data-stp-footer-balance'
    const FOOTER_IMPORT_ATTR = 'data-stp-footer-import'
    const FOOTER_PIN_ATTR = 'data-stp-footer-pin'
    const ACCOUNT_ATTR = 'data-stp-account'

    /** The stock sidebar's own aria-labels for the footer surfaces. */
    const BALANCE_REGION_LABEL = '简化侧栏显示'
    const IMPORT_CONTROL_LABEL = '导入会话'
    const ACCOUNT_MENU_LABEL = '账号菜单'
      /** The pinned-count entry's own first cell of text, inside the footer host. */
      const FOOTER_PIN_TEXT = '已置顶'
      /** The pinned-count entry's own stable `aria-label`, inside the footer host. */
      const FOOTER_PIN_LABEL = '已置顶的会话'

    /**
     * Marks this plugin has written onto host nodes, newest last.
     *
     * A list rather than a fixed set of variables because each one has to be
     * handed back EXACTLY what was taken and nothing else, and teardown runs
     * them all the same way. Only this plugin's own attributes are ever removed.
     * @type {Array<{el: Element, attr: string}>}
     */
    const hostMarks = []

    /** Put one marker on one host element, remembering it for the hand-back. */
    const markHost = (el, attr) => {
      if (el === null || el === undefined || typeof el.setAttribute !== 'function') return false
      try {
        el.setAttribute(attr, '')
      } catch {
        return false
      }
      hostMarks.push({ el, attr })
      return true
    }

    /** Take every marker back off the host, and forget them. Idempotent. */
    const clearHostMarks = (attr) => {
      for (let i = hostMarks.length - 1; i >= 0; i -= 1) {
        const mark = hostMarks[i]
        if (attr !== undefined && mark.attr !== attr) continue
        hostMarks.splice(i, 1)
        try {
          if (mark.el.getAttribute?.(mark.attr) !== null) mark.el.removeAttribute(mark.attr)
        } catch { /* the element went with its own tree; there is nothing left to own */ }
      }
    }

    /**
     * Marks the ONE tree element this plugin has positively identified as the
     * host's session list.
     *
     * It exists so the typography rules below can reach the host's own rows and
     * titles without ever being able to reach anything else. A document-wide
     * `[role="tree"]` rule would restyle a file tree, a search tree or any other
     * third-party widget; a `[class*="_title"]` rule with no anchor is the same
     * mistake with a different spelling. One attribute, written only onto the
     * element findTree() proved, and removed on every path that un-proves it.
     */
    const TYPOGRAPHY_ATTR = 'data-stp-typography'

    /**
     * Inject the plugin stylesheet once, keeping the dynamic pin rules separate.
     *
     * TYPOGRAPHY IS WRITTEN IN LONGHAND, NEVER IN THE "font" SHORTHAND.
     *
     * Every rule below used to read the shorthand "font: <weight> <size>/<lh>
     * var(--stp-token-font, inherit)". That is invalid CSS: "inherit" is a
     * global keyword, and a shorthand does not accept a global keyword in the
     * family slot, so the declaration as a whole was at-risk and, in the real
     * page, dropped (measured there: CSS.supports('font', '400 13px/20px
     * inherit') === false, and --stp-token-font is empty, so the fallback is
     * always the one being substituted). A dropped declaration is not "the old
     * look" — it is NO declaration, so the whole element fell back to the
     * host's inherited 14px. That is the entire "the pinned rows look smaller
     * than the rest" report: the pinned region was never smaller by design, it
     * was larger by accident of a dropped rule and only just.
     *
     * The four longhands below are each independently valid, so a missing
     * token degrades one property instead of the whole face. Only
     * font-family still reads the token, and var(..., inherit) IS legal there
     * because the substituted "inherit" is then parsed as a font-family value.
     */
    const STYLE_TEXT = `
[data-stp-region] {
  display: flex; flex-direction: column; gap: 0;
  padding: 1px 6px 4px; margin: 0 0 2px;
}
[data-stp-region][hidden] { display: none !important; }
/* Folding the region hides its DIRECT child rows and nothing else — the header
   and its count stay, and no row node is destroyed, so identity (and therefore
   every click, focus and gesture on it) survives the fold. */
[data-stp-region][data-stp-collapsed='true'] > [data-stp-row] { display: none !important; }
[data-stp-region-header] {
  display: flex; align-items: center; gap: 6px;
  /* The disclosure is a click target like any other row. Its 16px line box
     compacted it to 18px, which is under the 24px floor the rest of the
     compaction holds to; 24px restores the target without giving back any
     horizontal space or shrinking the type. */
  min-height: 24px; box-sizing: border-box;
  padding: 1px 4px 1px 6px; border-radius: 6px;
  font-family: var(--stp-token-font, inherit);
  font-size: 12px; font-weight: 600; line-height: 16px;
  color: var(--stp-token-tertiary, currentColor);
  user-select: none; cursor: pointer;
}
[data-stp-region-header]:hover { background: var(--stp-token-hover, rgba(127,127,127,.10)); }
[data-stp-region-header]:focus-visible {
  outline: 2px solid var(--stp-token-primary, currentColor); outline-offset: -2px;
}
[data-stp-region-caret] { flex: none; font-size: 10px; line-height: 1; }
[data-stp-region-count] {
  margin-left: auto; opacity: .8;
  font-variant-numeric: tabular-nums;
}
[data-stp-row] {
  display: flex; align-items: center; gap: 6px;
  min-height: 26px; padding: 0 6px 0 8px;
  border-radius: 8px; cursor: pointer; position: relative;
  min-width: 0; box-sizing: border-box;
  font-family: var(--stp-token-font, inherit);
  font-size: 14px; font-weight: 500; line-height: 20px;
  color: var(--stp-token-primary, inherit);
}
[data-stp-row]:hover, [data-stp-row]:focus-visible {
  background: var(--stp-token-hover, rgba(127,127,127,.10));
  outline: none;
}
[data-stp-row][aria-current='true'] { background: var(--stp-token-hover, rgba(127,127,127,.16)); }
/* A colour the user picked for one session. MIXED, never opaque: the host's own
   text token and its own hover/selected surfaces stay readable on top of it, and
   hover / focus / active each keep their own mix rather than painting it over.
   The value itself arrives as the custom property --stp-row-color on the
   row, so no arbitrary string is ever interpolated into this stylesheet. */
[data-stp-row][data-stp-color] {
  background: color-mix(in srgb, var(--stp-row-color, transparent) 22%, transparent);
}
[data-stp-row][data-stp-color]:hover, [data-stp-row][data-stp-color]:focus-visible {
  background: color-mix(in srgb, var(--stp-row-color, transparent) 34%, var(--stp-token-hover, rgba(127,127,127,.10)));
}
[data-stp-row][data-stp-color][aria-current='true'] {
  background: color-mix(in srgb, var(--stp-row-color, transparent) 42%, var(--stp-token-hover, rgba(127,127,127,.16)));
}
/* The colour point: a 24px hit area carrying a 14px visual. The area is the
   element (so focus lands on something big enough to hit) and the swatch is its
   ::after, which keeps the border and the fill off the transparent padding. */
[data-stp-row-color] {
  flex: none; box-sizing: content-box; position: relative;
  width: 14px; height: 14px; padding: 5px;
  border: 0; background: transparent; cursor: pointer;
}
[data-stp-row-color]::after {
  content: ''; position: absolute; left: 5px; top: 5px;
  width: 14px; height: 14px; border-radius: 4px;
  border: 1px solid var(--stp-token-border, rgba(127,127,127,.45));
  background: transparent;
}
[data-stp-row-color][data-stp-row-color-set]::after { background: var(--stp-row-color, transparent); }
[data-stp-row-color]:hover::after { border-color: var(--stp-token-primary, currentColor); }
[data-stp-row-color]:focus-visible {
  outline: 2px solid var(--stp-token-primary, currentColor); outline-offset: 1px;
}
/* The real <input type="color"> behind the swatch. Rendered (display:none
   makes a programmatic click() a no-op) and invisible, and it never takes a
   pointer or a tab stop of its own. */
[data-stp-color-input] {
  position: absolute; left: 0; top: 0;
  width: 1px; height: 1px; padding: 0; border: 0; margin: 0;
  opacity: 0; pointer-events: none;
}
[data-stp-row-slot] {
  width: 14px; height: 14px; flex: none;
  display: flex; align-items: center; justify-content: center;
  color: var(--stp-token-secondary, currentColor);
}
[data-stp-row-title] {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-stp-row-time] {
  flex: none; color: var(--stp-token-tertiary, currentColor);
  font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums;
}
[data-stp-pin-item] {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 0; background: transparent; cursor: pointer; text-align: left;
  padding: 6px 10px; border-radius: 6px;
  font-family: var(--stp-token-font, inherit);
  font-size: 13px; font-weight: 400; line-height: 20px;
  color: var(--stp-token-primary, inherit);
}
[data-stp-pin-item]:hover, [data-stp-pin-item]:focus-visible {
  background: var(--stp-token-hover, rgba(127,127,127,.12));
  outline: none;
}
/* The controls for the two regions this plugin folds — the global-panels nav
   and the workspace directories. Deliberately the size of one host row and
   styled from the same tokens, so folding a region does not change the
   sidebar's rhythm. The 24px hit area is kept: only the margin around it and
   the line box inside it are tightened. */
[data-stp-panels-toggle], [data-stp-groups-toggle] {
  display: flex; align-items: center; gap: 6px; box-sizing: border-box;
  min-height: 24px; width: calc(100% - 4px); margin: 0 2px 2px;
  padding: 0 8px; border: 0; border-radius: 6px;
  background: transparent; cursor: pointer; text-align: left;
  font-family: var(--stp-token-font, inherit);
  font-size: 11px; font-weight: 400; line-height: 16px;
  color: var(--stp-token-tertiary, currentColor);
}
[data-stp-panels-toggle]:hover, [data-stp-groups-toggle]:hover { background: var(--stp-token-hover, rgba(127,127,127,.10)); }
[data-stp-panels-toggle]:focus-visible, [data-stp-groups-toggle]:focus-visible {
  outline: 2px solid var(--stp-token-primary, currentColor); outline-offset: -2px;
}
[data-stp-panels-caret], [data-stp-groups-caret] { flex: none; font-size: 10px; line-height: 1; }
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
  font-family: var(--stp-token-font, inherit);
  font-size: 13px; font-weight: 400; line-height: 20px;
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
  font-family: var(--stp-token-font, inherit);
  font-size: 13px; font-weight: 400; line-height: 20px;
  pointer-events: auto;
}
/* The two items this plugin contributes to its own fallback menu. One rule for
   both, so the colour entry cannot read as a different kind of row from the pin
   entry sitting directly above it. */
[data-stp-menu] [data-stp-pin-item],
[data-stp-menu] [data-stp-color-item] {
  display: block; box-sizing: border-box; width: 100%;
  min-height: 24px; margin: 0; padding: 2px 8px;
  border: 0; border-radius: 6px; background: transparent; color: inherit;
  font-family: var(--stp-token-font, inherit);
  font-size: 13px; font-weight: 400; line-height: 20px;
  text-align: start; cursor: pointer;
}
[data-stp-menu] [data-stp-pin-item]:hover,
[data-stp-menu] [data-stp-color-item]:hover {
  background: var(--stp-token-hover, rgba(127,127,127,.10));
}
[data-stp-menu] [data-stp-pin-item]:focus-visible,
[data-stp-menu] [data-stp-color-item]:focus-visible {
  outline: 2px solid var(--stp-token-primary, currentColor); outline-offset: -2px;
}
/* ---------------------------------------------------------------------------
   HOST TYPOGRAPHY — the sidebar rows this plugin re-weights so the pinned
   region reads as the LARGER surface and the workspace below it recedes.

   Scope is the marker attribute plus the host's OWN row vocabulary. Three
   things have to hold together:

   1. The marker attribute is written only onto the tree findTree() proved,
      so a file tree, a search tree or another plugin's list can never match —
      the selector cannot reach them even though they carry the same shape.
   2. The two data-row-key prefixes are the stock sidebar's own vocabulary
      (restated from src/core.js), and the dcu-wb-* classes are codex-ui's
      own (@michengai/dsh-codex-ui lib/client.js). Both are addressed, because
      both hosts render a session list and the marker decides which one is
      actually on screen. When this block shipped with the data-row-key
      selectors alone, every rule here was dead on a codex-ui profile: its rows
      carry data-dcu-session and a dcu-wb-session class, never
      data-row-key, so the marker was written onto .dcu-wb-tree and not one
      of the rules below could match a row inside it.
   3. [class*="_title"] is Rows.module.css's exported _title, whose hashed
      build class keeps the readable _title segment (measured on the running
      app: qCniVq_title). It is matched only UNDER a marked tree, and a
      session row's own siblings (rowActions, iconButton) do not contain
      that segment, so the trailing controls are not restyled. codex-ui's
      equivalents are named outright — .dcu-wb-session-title,
      .dcu-wb-project-title, .dcu-wb-collection-label — because it ships
      no hashed build class to match on a readable segment.

   What it DOES set is deliberately bounded: the glyph size, the line box, and
   — in the ROW RHYTHM block below — the vertical padding, margin and a 24px
   minimum height of the host's own rows. No row is hidden or removed, no icon
   is resized, and nothing outside a proven tree can match, so hit areas, the
   narrow rail and the host's own ellipsis clipping keep working. The pinned
   region above stays the LARGER surface (14px over the workspace's 12px),
   which is the whole point of the complaint this section answers.
   --------------------------------------------------------------------------- */
[data-stp-typography] [data-row-key^='workspace:'] [class*='_title'],
[data-stp-typography] [data-row-key^='session:'] [class*='_title'],
[data-stp-typography] .dcu-wb-project-title,
[data-stp-typography] .dcu-wb-collection-label,
[data-stp-typography] .dcu-wb-session-title {
  font-size: 12px; font-weight: 400; line-height: 16px;
}
/* The inline rename input sits where the title was and must stay readable at
   the SAME size, or renaming a session visibly reflows its own row. */
[data-stp-typography] [data-row-key^='workspace:'] input,
[data-stp-typography] [data-row-key^='session:'] input {
  font-family: var(--stp-token-font, inherit);
  font-size: 12px; font-weight: 400; line-height: 16px;
}
/* ROW RHYTHM. The same compaction on the host's own rows, so more of them fit
   on screen. Scope is the marker plus the host's own row vocabulary, exactly as
   the typography above is: nothing outside a PROVEN tree can match, no row is
   hidden, and nothing is removed — only the space between rows and inside them
   is taken back. min-height keeps a 24px hit area. */
[data-stp-typography] { gap: 0; padding-top: 0; padding-bottom: 0; }
/* An explicit height, not only min-height. The host sets a FIXED height on both
   of its row kinds (.projectRow 34px, .sessionRow 32px in rows/Rows.module.css),
   and a fixed height wins over a minimum: on the live page the padding landed
   and the directory row stayed at 34px. The height has to be stated to be taken
   back. 26px keeps the row a comfortable click target and is still the compact
   value the acceptance asked for. border-box keeps the padding inside it. */
[data-stp-typography] [data-row-key^='workspace:'],
[data-stp-typography] [data-row-key^='session:'],
[data-stp-typography] [data-dcu-session],
[data-stp-typography] .dcu-wb-project-head,
[data-stp-typography] .dcu-wb-collection-head,
[data-stp-typography] .dcu-wb-section-head,
/* ...and the LABELS those two heads hold. codex-ui sizes them independently of
   the head (.dcu-wb-collection-label min-height:32px + 4px padding;
   .dcu-wb-section-label min-height:24px + 2px padding, lib/client.js CSS
   table), so compacting only the head leaves a 32-40px child centred in a 26px
   box — it overflows both edges and drags its click area outside the header it
   belongs to. border-box makes the stated height the total, so the padding can
   no longer add to it. */
[data-stp-typography] .dcu-wb-collection-label,
[data-stp-typography] .dcu-wb-section-label {
  height: 26px; min-height: 24px; box-sizing: border-box;
  margin-top: 0; margin-bottom: 0;
  padding-top: 1px; padding-bottom: 1px;
}
/* codex-ui's own rename field sits where the session title was, at 14px/20px
   (.dcu-wb-rename-input, lib/client.js CSS table). Leaving it at 14px while
   its row collapses to 26px is the same visible reflow the stock sidebar's
   inline input rule above exists to prevent. */
[data-stp-typography] .dcu-wb-rename-input {
  font-family: var(--stp-token-font, inherit);
  font-size: 12px; font-weight: 400; line-height: 16px;
}
/* A colour chosen for a session the HOST renders in its own group. Same map,
   same attribute and the same mix as a pinned row's; only the address changes,
   and it is still the proven tree plus the host's own row vocabulary. */
[data-stp-typography] [data-row-key^='session:'][data-stp-color],
[data-stp-typography] [data-dcu-session][data-stp-color] {
  background: color-mix(in srgb, var(--stp-row-color, transparent) 22%, transparent);
}
[data-stp-typography] [data-row-key^='session:'][data-stp-color]:hover,
[data-stp-typography] [data-dcu-session][data-stp-color]:hover {
  background: color-mix(in srgb, var(--stp-row-color, transparent) 34%, var(--stp-token-hover, rgba(127,127,127,.10)));
}
/* ---------------------------------------------------------------------------
   THE PLUGIN'S OWN COLOUR DIALOG. Needed because a hidden
   <input type="color"> is not something a person can drive: the six-digit hex
   box is the control, and the native swatch beside it is the helper. The
   dialog is its own on-screen element — never inside the off-screen menu anchor
   — and it is placed by JS, so nothing here depends on a percentage offset.
   --------------------------------------------------------------------------- */
[data-stp-color-dialog] {
  position: fixed; left: 0; top: 0; z-index: 2147483002;
  box-sizing: border-box; display: flex; flex-direction: column; gap: 8px;
  min-width: 248px; max-width: min(360px, calc(100vw - 32px));
  padding: 12px; border-radius: 10px;
  border: 1px solid var(--stp-token-border, rgba(127,127,127,.32));
  background: var(--stp-token-bg, Canvas);
  color: var(--stp-token-primary, inherit);
  box-shadow: 0 8px 24px rgba(0,0,0,.24);
  font-family: var(--stp-token-font, inherit);
  font-size: 13px; font-weight: 400; line-height: 20px;
}
[data-stp-color-dialog-title] { font-weight: 600; }
[data-stp-color-dialog-field] { display: flex; align-items: center; gap: 8px; }
[data-stp-color-hex] {
  flex: 1 1 auto; min-width: 0; box-sizing: border-box;
  padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--stp-token-border, rgba(127,127,127,.45));
  background: transparent; color: inherit;
  font-family: var(--stp-token-font, inherit);
  font-size: 13px; font-weight: 400; line-height: 20px;
}
[data-stp-color-hex][aria-invalid='true'] { outline: 2px solid currentColor; outline-offset: 1px; }
[data-stp-color-native] {
  flex: none; box-sizing: border-box; width: 24px; height: 24px;
  padding: 0; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--stp-token-border, rgba(127,127,127,.45));
  background: transparent;
}
[data-stp-color-dialog-actions] { display: flex; align-items: center; gap: 6px; }
[data-stp-color-button] {
  min-height: 24px; padding: 0 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--stp-token-border, rgba(127,127,127,.45));
  background: transparent; color: inherit;
  font-family: var(--stp-token-font, inherit);
  font-size: 12px; font-weight: 400; line-height: 20px;
}
[data-stp-color-button]:focus-visible {
  outline: 2px solid var(--stp-token-primary, currentColor); outline-offset: 1px;
}
/* ---------------------------------------------------------------------------
   THE SIDEBAR FOOTER. Compaction only — no rule here hides anything, and every
   one hangs off a marker this plugin wrote onto an element it PROVED (see
   reconcileFooter below): the common host of the balance region and the import
   control, the import control itself, the pinned-count entry inside that host,
   and the account menu. A host whose markup moves simply stops matching, which
   is the same degrade-to-nothing every other scoped rule here has.
   --------------------------------------------------------------------------- */
[data-stp-footer] { gap: 0; }
/* The balance stack measured 74.91px before and 65.14px after the markers landed.
   Same cascade story as the controls below: the host sets these cells' padding
   and line-height from its own rules, so the declarations that must win are
   !important. Scoped to this plugin's marker plus the host's own readable class
   segments, nothing hidden, and each cell keeps its content. */
[data-stp-footer-balance] { margin-top: 0 !important; margin-bottom: 0 !important; }
[data-stp-footer-balance] [class*='cm-simple-summary'],
[data-stp-footer-balance] [class*='cm-foot'],
[data-stp-footer-balance] [class*='cm-peak-strip'] {
  margin-top: 0 !important; margin-bottom: 0 !important; min-height: 0 !important;
  padding-top: 2px !important; padding-bottom: 2px !important;
  line-height: 16px !important; box-sizing: border-box !important;
}
[data-stp-footer-balance] [class*='cm-simple-summary'] { height: 20px !important; }
[data-stp-footer-balance] [class*='cm-foot'] { height: 24px !important; }
[data-stp-footer-balance] [class*='cm-peak-strip'] { height: 18px !important; padding-top: 1px !important; padding-bottom: 1px !important; }
/* The import control measured 42px and the pinned entry 28px AFTER their markers
   landed, so this is a CASCADE problem, not a missing rule — read off the live
   CSSOM:
     - import carries the host's INLINE height (42px). No stylesheet rule,
       however specific, can beat an inline declaration without !important.
     - the pinned entry is styled "button.__dsh-session-pin-footer__" after an
       "all: unset", which outranks a single-attribute selector.
   So the declarations that must win state !important. Scope is unchanged and
   stays on this plugin's own markers, nothing else is touched, and no host
   inline style is edited. */
[data-stp-footer-import] {
  height: 28px !important; min-height: 28px !important; box-sizing: border-box !important;
  padding: 0 8px !important; margin: 0 !important; line-height: 20px !important;
}
[data-stp-footer-pin] {
  height: 24px !important; min-height: 24px !important; box-sizing: border-box !important;
  padding: 0 6px !important; margin: 0 !important; line-height: 16px !important;
  font-size: 11px !important;
}
[data-stp-account] { height: 32px; min-height: 32px; padding: 3px 8px; box-sizing: border-box; }
[data-stp-account] > span { line-height: 18px; }
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
     * The fold rule for the global-panels region.
     *
     * Scoped twice over: to the host's own nav vocabulary (`panelList`, the
     * readable segment its hashed CSS-module class keeps) AND to the state
     * attribute this plugin puts on that one element. Nothing else in the
     * document can match, so no other nav is ever hidden — the "don't broadly
     * hide other navs" rule is enforced by the selector, not by care at the
     * call site.
     *
     * @param {boolean} collapsed - whether the region is folded right now.
     * @returns {string} the rule, or '' when it is expanded.
     */
    function panelsRuleCss(collapsed) {
      if (collapsed !== true) return ''
      return `nav[class*='panelList'][${PANELS_STATE_ATTR}='collapsed']{display:none !important;}`
    }

    /**
     * The fold rule for the workspace-directory region.
     *
     * Scoped TWICE over, and the second half is the load-bearing one: to the
     * marker this plugin puts on the body it proved by walking up from the
     * identified session list, AND to the state attribute on that same body. A
     * selector that matched the host's hashed `treeBody` class instead would be
     * a global sweep — it would hide a look-alike seat the host renders
     * elsewhere, which is exactly the mistake the pinned rules are scoped to
     * avoid. Nothing in the document can match unless this plugin marked it.
     *
     * @param {boolean} collapsed - whether the region is folded right now.
     * @returns {string} the rule, or '' when it is expanded.
     */
    function groupsRuleCss(collapsed) {
      if (collapsed !== true) return ''
      return `[${GROUPS_BODY_ATTR}][${GROUPS_STATE_ATTR}='collapsed']{display:none !important;}`
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
    function applyPinRules(tag, flavor, pinnedIds, panelsCollapsed = false, groupsCollapsed = false) {
      if (tag === null || tag === undefined) return
      const css = [...pinRuleCss(flavor, pinnedIds).split('\n').filter(Boolean),
        panelsRuleCss(panelsCollapsed), groupsRuleCss(groupsCollapsed)].filter(Boolean).join('\n')
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
     * Other plugins' slot entries whose pin count and pin list are re-sourced
     * from the official pin set, and whether the entry's workspace section is
     * part of that count.
     *
     * Matching is by exact slot name and entry id: the shadow sits on the same
     * cell one priority lower and reuses the original component untouched.
     */
    const OFFICIAL_COUNT_SLOTS = [
      { name: 'sidebar.footer.action', id: 'dsh-session-pin', pureSessionCount: true },
      { name: 'shell.overlay', id: 'dsh-session-pin-panel', pureSessionCount: false },
    ]

    /** Marks the entries this plugin registers, so it never shadows itself. */
    const SHADOW_REGISTRANT = 'dsh-session-top: official pin count'

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
        // The borrowed anchor row and the group this plugin may have opened for
        // it go back here, before anything else can act on a dead generation.
        restoreOfficialAnchor()
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
        // The panels control and the fold attribute are DOM on host nodes, so
        // they are handed back by the same walk that hands back the region —
        // regardless of whether this instance still owns the lease, because a
        // control nobody renders is not a shared resource.
        try {
          clearPanels()
        } catch (error) {
          console.error('[dsh-session-top] panels teardown failed:', error)
        }
        try {
          clearDirectoryRegion()
        } catch (error) {
          console.error('[dsh-session-top] directory-region teardown failed:', error)
        }
        // The footer markers and the host-row colours are DOM on HOST nodes, so
        // they are handed back on every teardown and regardless of the lease: a
        // marked footer or a tinted row this instance can no longer justify must
        // not stay that way. The dialog is plugin-owned and simply goes.
        try {
          clearFooter()
        } catch (error) {
          console.error('[dsh-session-top] footer teardown failed:', error)
        }
        try {
          clearHostRowColors()
        } catch (error) {
          console.error('[dsh-session-top] host row colour teardown failed:', error)
        }
        try {
          closeColorDialog()
        } catch (error) {
          console.error('[dsh-session-top] colour dialog teardown failed:', error)
        }
        // The typography marker is DOM on a HOST node, so it is handed back on
        // every teardown and regardless of the lease: a marked tree this
        // instance can no longer justify must not stay marked. Only this
        // plugin's own attribute comes off.
        try {
          markTypography(null)
        } catch (error) {
          console.error('[dsh-session-top] typography teardown failed:', error)
        }
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

      /** Frozen stand-in for "no workspace pins", so the reference never moves. */
      const NO_WORKSPACE_PINS = Object.freeze([])

      /**
       * The official pinned session ids, reference-stable while the set is
       * unchanged: `useSyncExternalStore` compares snapshots by identity, so a
       * fresh array per read would re-render every subscriber forever.
       * @returns {readonly string[]} the pinned ids, in official order.
       */
      // Seeded with a real array, because an unpublished list answers
      // `undefined` — the same value this cache holds before its first read,
      // so an unseeded `ids` would be handed to callers as `null`.
      const officialPinCache = { snapshot: undefined, ids: NO_WORKSPACE_PINS }
      const officialPinnedIds = () => {
        let snapshot
        try {
          snapshot = workspaces.list.getSnapshot()
        } catch (error) {
          warn(`official pin snapshot unreadable: ${describeError(error)}`)
          return NO_WORKSPACE_PINS
        }
        if (snapshot !== officialPinCache.snapshot) {
          officialPinCache.snapshot = snapshot
          const raw = Array.isArray(snapshot?.pinnedSessionIds)
            ? snapshot.pinnedSessionIds.map(String)
            : []
          const previous = officialPinCache.ids
          officialPinCache.ids = previous.length === raw.length
            && previous.every((id, index) => id === raw[index])
            ? previous
            : raw
        }
        return officialPinCache.ids
      }

      /**
       * Write a pin through the official RPC and report a refusal. No optimistic
       * update and no private-store fallback: the official list subscription is
       * what repaints the surfaces.
       * @param {string} id - the session.
       * @param {boolean} want - true to pin, false to unpin.
       * @returns {Promise<{ok: boolean}>} what the host said.
       */
      const applyOfficialPin = async (id, want) => {
        const action = want ? pinSession : unpinSession
        if (action === undefined) {
          surfaceError(translate(
            'pin.unavailable',
            '本机工作区服务未提供置顶接口',
          ), 'unavailable')
          return { ok: false }
        }
        try {
          await action(id)
          return { ok: true }
        } catch (error) {
          if (alive()) {
            surfaceError(`${want ? '置顶' : '取消置顶'}失败（${id}）：${describeError(error)}`, 'refused')
          }
          return { ok: false }
        }
      }

      /** One facade per foreign pin controller, per shadow variant. */
      const pinAdapters = new WeakMap()

      /**
       * A live view of a foreign pin face: official membership, official
       * writes, the other controller's own store for everything else.
       *
       * The proxy forwards every other read to the ORIGINAL object and binds its
       * methods to it, so row colours, tags and the workspace section keep
       * resolving against live state, and nothing this facade does can write
       * back into a store this plugin does not own.
       * @param {any} pin - the foreign pin face.
       * @param {boolean} pureSessionCount - true where the badge counts sessions only.
       * @returns {any} the facade.
       */
      const makePinAdapter = (pin, pureSessionCount) => {
        if (pin === null || typeof pin !== 'object') return pin
        let variants = pinAdapters.get(pin)
        if (variants === undefined) pinAdapters.set(pin, variants = {})
        const variant = pureSessionCount ? 'count' : 'full'
        if (variants[variant] !== undefined) return variants[variant]
        const binds = new Map()
        const overrides = {
          getPinned: () => officialPinnedIds(),
          isPinned: (id) => officialPinnedIds().includes(String(id)),
          setPinned: (id, next) => applyOfficialPin(String(id), next !== false),
          toggle: (id) => applyOfficialPin(
            String(id),
            !officialPinnedIds().includes(String(id)),
          ),
          // Merged, because the original controller also carries state of its
          // own that its own surface must keep hearing about.
          subscribe: (listener) => {
            const stops = []
            const attach = (source) => {
              try {
                const stop = source.subscribe(listener)
                if (typeof stop === 'function') stops.push(stop)
              } catch (error) {
                warn(`could not merge a pin subscription: ${describeError(error)}`)
              }
            }
            if (typeof pin.subscribe === 'function') attach(pin)
            attach(workspaces.list)
            let released = false
            return () => {
              if (released) return
              released = true
              for (const stop of stops) {
                try {
                  stop()
                } catch (error) {
                  warn(`could not release a merged pin subscription: ${describeError(error)}`)
                }
              }
            }
          },
        }
        if (pureSessionCount) overrides.getWorkspacePinned = () => NO_WORKSPACE_PINS
        const adapter = new Proxy(pin, {
          get(target, prop) {
            if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop]
            const value = Reflect.get(target, prop, target)
            if (typeof value !== 'function') return value
            let bound = binds.get(prop)
            if (bound === undefined) {
              bound = value.bind(target)
              binds.set(prop, bound)
            }
            return bound
          },
          set(_target, prop, value) {
            overrides[prop] = value
            return true
          },
        })
        variants[variant] = adapter
        return adapter
      }

      /**
       * Shadow the known foreign pin entries so their counts and lists read the
       * official pin set. Registration, not mutation: the original entries are
       * left exactly as they are, and every shadow is released on teardown.
       */
      const shadowOfficialCounts = () => {
        let registry = undefined
        try {
          registry = ctx.get('slots')
        } catch (error) {
          warn(`slot registry lookup failed: ${describeError(error)}`)
        }
        if (registry === undefined) {
          warn('no slot registry: foreign pin surfaces keep their own pin count')
          return
        }
        if (typeof registry.register !== 'function'
          || typeof registry.entries !== 'function'
          || typeof registry.subscribe !== 'function') {
          warn('slot registry has no public surface; foreign pin surfaces keep their own pin count')
          return
        }
        const shadows = new Map()
        let syncing = false
        let resync = false
        // Releasing a shadow notifies the registry, and a notify that lands
        // while teardown is halfway through would re-register what teardown is
        // releasing. Latched for the rest of this generation.
        let disposing = false

        /** @returns {object | undefined} the foreign entry this shadow belongs to. */
        const findOriginal = (target) => {
          let entries
          try {
            entries = registry.entries(target.name)
          } catch (error) {
            warn(`could not read slot "${target.name}": ${describeError(error)}`)
            return undefined
          }
          return entries?.find(entry => entry?.options?.id === target.id
            && entry.registrant !== SHADOW_REGISTRANT)
        }

        const release = (name) => {
          const current = shadows.get(name)
          if (current === undefined) return
          shadows.delete(name)
          try {
            current.release()
          } catch (error) {
            warn(`could not release the "${name}" shadow: ${describeError(error)}`)
          }
        }

        const sync = () => {
          if (disposing) return
          // Registering notifies, and this is called from that notification.
          if (syncing) {
            resync = true
            return
          }
          syncing = true
          try {
            do {
              resync = false
              for (const target of OFFICIAL_COUNT_SLOTS) {
                const original = findOriginal(target)
                const current = shadows.get(target.name)
                if (original === undefined) {
                  release(target.name)
                  continue
                }
                if (current !== undefined && current.original === original) continue
                release(target.name)
                if (typeof original.inject !== 'function') continue
                // `children` / `store` are deliberately not copied: re-declaring
                // them on a second entry is a load-time throw, and neither of
                // these two entries declares one.
                const options = {
                  name: target.name,
                  id: original.options.id,
                  order: original.options.order,
                  priority: (original.options.priority ?? 0) - 1,
                  registrant: SHADOW_REGISTRANT,
                  inject: (...args) => {
                    const props = original.inject(...args)
                    return { ...props, pin: makePinAdapter(props.pin, target.pureSessionCount) }
                  },
                }
                try {
                  shadows.set(target.name, {
                    original,
                    release: registry.register(options, original.component),
                  })
                } catch (error) {
                  warn(`could not shadow "${target.name}": ${describeError(error)}`)
                }
              }
            } while (resync)
          } finally {
            syncing = false
          }
        }

        const unsubscribes = OFFICIAL_COUNT_SLOTS.map((target) => {
          try {
            return registry.subscribe(target.name, sync)
          } catch (error) {
            warn(`could not watch slot "${target.name}": ${describeError(error)}`)
            return () => {}
          }
        })
        disposers.push(() => {
          disposing = true
          for (const unsubscribe of unsubscribes.splice(0)) {
            try {
              unsubscribe()
            } catch (error) {
              warn(`could not release a slot watch: ${describeError(error)}`)
            }
          }
          for (const name of [...shadows.keys()]) release(name)
        })
        sync()
      }

      shadowOfficialCounts()

      /**
       * Add ONE item to the stock sidebar's own session-row menu.
       *
       * The stock sidebar serves that menu from
       * `sidebar.workspaces.session.menu.item` (`rows/Rows.tsx:681-685`), and
       * the host registers its Pin item there as `{name, id: 'pin', order:
       * 100, locale, inject, component}` (ui-sidebar `index.ts:285-289`). That
       * is the ONLY place a colour entry can exist for an ordinary unpinned row
       * on this host: there is no `contextmenu` surface to claim and the
       * plugin-owned fallback only opens where no host menu can be borrowed.
       *
       * WHAT IT IS NOT. The host's Pin entry is not mutated, shadowed or
       * replaced — it is left exactly as registered, and a SECOND, namespaced id
       * is added next to it. The adapter reuses the host's own component and the
       * host's own `inject` verbatim, so every hook, prop and behaviour is the
       * host's; the adapter only swaps two functions and one label:
       *
       *   - `pinSession` AND `unpinSession` both become "open the colour dialog
       *     for this session". The host's component calls `setMenuOpen(false)`
       *     first and then whichever of the two applies, so overriding both is
       *     what makes the item mean the same thing whichever state the row is
       *     in. Neither business RPC is reachable from this item, by construction.
       *   - `t` maps the two menu keys onto this plugin's own label and
       *     delegates everything else to the host's translator, so no other item
       *     in the same menu can be affected.
       *
       * The label override sits in the PROPS layer rather than in the locale
       * namespace on purpose: the slot framework re-resolves `locale` last, so a
       * translation injected at the entry level would win over ours and the item
       * would say 置顶该会话.
       *
       * Degrades to nothing at all when the slot, the entry or a usable component
       * is missing: the shared table and the row's own colour point are then the
       * whole surface, which is what they were before.
       *
       * @returns {boolean} true when the item is registered right now.
       */
      const OFFICIAL_ROW_MENU_SLOT = 'sidebar.workspaces.session.menu.item'
      const OFFICIAL_COLOR_ENTRY_ID = 'dsh-session-top.row-color'
      /** Well after the host's own items, so it reads last.
       The stock sidebar ships four of them — pin 100, rename 200, fork 300,
       archive 400 (`ui-workspace/src/client/index.ts:286-289`, stepping by 100
       precisely "so a plugin entry can land between them"). 450 would have been
       past all four; 500 is the value the slot contract's own registration
       example uses (`contract/slots.ts:153`), which leaves room for a host item
       the contract already shows how to add at 450 without this entry having to
       win a tie on registration order. */
      const OFFICIAL_COLOR_ORDER = 500
      const OFFICIAL_COLOR_REGISTRANT = 'dsh-session-top: official row colour'

      /** @returns {string} this plugin's colour item label. */
      const COLOR_MENU_LABEL = () => translate('menu.color', '自定义行背景颜色…')

      /**
       * A translator that owns exactly two keys and delegates the rest.
       * @param {unknown} base - the host's own translator.
       * @returns {(key: string, ...rest: unknown[]) => string} the adapter.
       */
      const colorMenuT = (base) => (key, ...rest) => {
        if (key === 'menu.pinSession' || key === 'menu.unpinSession') return COLOR_MENU_LABEL()
        try {
          if (typeof base === 'function') {
            const value = base(key, ...rest)
            if (typeof value === 'string' && value.length > 0) return value
          }
        } catch { /* an untranslatable key falls through to itself, as the host does */ }
        return String(key)
      }

      /**
       * The element focus should go back to when the colour dialog closes.
       *
       * A menu closes by handing focus to whatever opened it, so a dialog opened
       * from a menu that then vanishes has nothing to return to and focus lands
       * on `<body>` — the keyboard user is dropped at the top of the page. Two
       * candidates, in order: whatever currently holds focus (that IS the opener
       * for every path that has one, because the host focused it to open the
       * menu), and the host's own row for this session, reached through the
       * proven tree rather than by a page-wide sweep.
       *
       * A row the host has already re-rendered is refused downstream by the
       * `isConnected` check in `closeColorDialog`, which is the safe degradation.
       *
       * @param {string} id - the session whose colour is being edited.
       * @returns {Element | null} a connected focus target, or null.
       */
      const openerFor = (id) => {
        try {
          const active = document.activeElement
          if (active != null && active.isConnected !== false
            && typeof active.focus === 'function'
            && active.getAttribute?.(COLOR_DIALOG_ATTR) === null) return active
        } catch { /* no document, or no focus model: the row lookup still stands */ }
        try {
          const tree = findTree(currentFlavor(Date.now()))
          if (tree == null) return null
          const row = tree.querySelector(`[data-row-key="session:${id}"]`)
          if (row == null) return null
          return row.isConnected === false ? null : row
        } catch {
          return null
        }
      }

      /**
       * Open the dialog for a session the host's menu just closed.
       *
       * Deferred one tick on purpose: the host's component has just closed its own
       * menu, and a menu closing hands focus back to the row it was opened from —
       * a dialog that focused its own field a tick earlier would lose it again.
       * @param {string} id - the session.
       */
      const openColorDialogAfterMenuClose = (id) => {
        afterDispatch(() => {
          if (!alive()) return
          if (typeof id !== 'string' || id.length === 0) return
          openColorDialog(id, openerFor(id))
        })
      }

      /**
       * (Re)publish the colour item whenever the host's own Pin entry appears,
       * changes or goes away.
       *
       * Same lifecycle as `shadowOfficialCounts` for the same reasons: apply
       * order is not knowable, registration notifies, and a notify that lands
       * while this is mid-sync is latched rather than re-entered.
       * @returns {boolean} true when the item is in the slot afterwards.
       */
      const registerOfficialColorMenu = () => {
        let registry = undefined
        try {
          registry = ctx.get('slots')
        } catch (error) {
          warn(`slot registry lookup failed: ${describeError(error)}`)
        }
        // No slot registry at all is a host without the surface, not a failure:
        // the shared table and the colour point keep working.
        if (registry === undefined) return false
        if (typeof registry.register !== 'function'
          || typeof registry.entries !== 'function'
          || typeof registry.subscribe !== 'function') return false

        const releases = new Map()
        let syncing = false
        let resync = false
        let disposing = false

        /** The host's own Pin entry, never this plugin's own registrations. */
        const findPinEntry = () => {
          let entries
          try {
            entries = registry.entries(OFFICIAL_ROW_MENU_SLOT)
          } catch (error) {
            warn(`could not read slot "${OFFICIAL_ROW_MENU_SLOT}": ${describeError(error)}`)
            return undefined
          }
          return entries?.find(entry => entry?.options?.id === 'pin'
            && entry.registrant !== SHADOW_REGISTRANT
            && entry.registrant !== OFFICIAL_COLOR_REGISTRANT)
        }

        const release = (key) => {
          const releaseOne = releases.get(key)
          if (releaseOne === undefined) return
          releases.delete(key)
          try {
            releaseOne()
          } catch (error) {
            warn(`could not release the official row-colour item: ${describeError(error)}`)
          }
        }

        const sync = () => {
          if (disposing) return
          if (syncing) {
            resync = true
            return
          }
          syncing = true
          try {
            do {
              resync = false
              const original = findPinEntry()
              if (original === undefined
                || typeof original.component !== 'function'
                || typeof original.inject !== 'function') {
                for (const key of [...releases.keys()]) release(key)
                continue
              }
              if (releases.has(original)) continue
              for (const key of [...releases.keys()]) release(key)
              // `children` / `store` are deliberately not re-declared: doing that
              // is a load-time throw, and this entry declares neither.
              const options = {
                name: OFFICIAL_ROW_MENU_SLOT,
                id: OFFICIAL_COLOR_ENTRY_ID,
                order: OFFICIAL_COLOR_ORDER,
                locale: original.options?.locale,
                registrant: OFFICIAL_COLOR_REGISTRANT,
                inject: (...args) => {
                  const props = original.inject(...args)
                  const openColor = (id) => { openColorDialogAfterMenuClose(id) }
                  return { ...props, pinSession: openColor, unpinSession: openColor }
                },
              }
              try {
                releases.set(original, registry.register(options, function DshSessionTopRowColor(props) {
                  return original.component({ ...props, t: colorMenuT(props?.t) })
                }))
              } catch (error) {
                warn(`could not register the official row-colour item: ${describeError(error)}`)
              }
            } while (resync)
          } finally {
            syncing = false
          }
        }

        const unsubscribes = [OFFICIAL_ROW_MENU_SLOT].map((slotName) => {
          try {
            const one = registry.subscribe(slotName, sync)
            return typeof one === 'function' ? one : () => {}
          } catch (error) {
            warn(`could not watch slot "${slotName}": ${describeError(error)}`)
            return () => {}
          }
        })
        disposers.push(() => {
          disposing = true
          for (const unsubscribe of unsubscribes.splice(0)) {
            try {
              unsubscribe()
            } catch (error) {
              warn(`could not release the row-colour slot watch: ${describeError(error)}`)
            }
          }
          for (const key of [...releases.keys()]) release(key)
        })
        sync()
        return releases.size > 0
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
       * The tree element currently carrying `TYPOGRAPHY_ATTR`, or null.
       *
       * The single source of truth for "what this plugin marked", so clearing
       * can never reach an element it did not mark. A host node that was never
       * marked has nothing to remove, and a host node that IS removed is
       * skipped by the `isConnected` guard below.
       */
      let typographyMarked = null

      /**
       * Take the typography marker back off whatever element this plugin put it
       * on.
       *
       * Removes only its OWN attribute — never a node, never a class, never
       * anything else the host rendered — so a sidebar that unmounted, swapped
       * or collapsed is left byte-for-byte as it was found.
       */
      const clearTypography = () => {
        if (typographyMarked === null) return
        const el = typographyMarked
        typographyMarked = null
        if (typeof el?.removeAttribute !== 'function') return
        try {
          if (el.getAttribute?.(TYPOGRAPHY_ATTR) !== null) el.removeAttribute(TYPOGRAPHY_ATTR)
        } catch { /* the element went with its tree; there is nothing left to own */ }
      }

      /**
       * Mark the identified tree — or unmark, when there is none.
       *
       * Three properties this must have, all of them load-bearing:
       *
       *   - IDEMPOTENT. An unchanged tree is a no-op return, not a rewrite. The
       *     observer watches childList only, so a repeated attribute write
       *     would not loop — but "assign when the value differs" is the same
       *     rule the rest of this file already follows for rendered rows, and
       *     an idle pass that touches the DOM is a pass that can be the reason
       *     the next one is needed.
       *   - EXCLUSIVE. Switching trees clears the previous one in the same
       *     call, so two trees are never marked at once and a sidebar swap
       *     leaves no orphan marker behind.
       *   - HANDS BACK. Called with null on every path that un-proves the
       *     sidebar (unknown flavor, no tree, unmounted host) and from
       *     `teardown`, so "marked" never outlives "identified".
       *
       * @param {Element | null} tree - the proven tree element, or null.
       */
      const markTypography = (tree) => {
        if (typographyMarked === tree) return
        clearTypography()
        if (tree === null || tree === undefined) return
        try {
          tree.setAttribute(TYPOGRAPHY_ATTR, '')
          typographyMarked = tree
        } catch {
          // A tree that refuses attributes is one the rules must not address.
          // Leaving it unmarked keeps the scope honest instead of widening it.
        }
      }

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
       * What this mount last saw in storage, by session.
       *
       * A CACHE, never the truth. The same preference is normally open in two
       * windows of the same origin, and each of them filled this map when it
       * mounted — so whichever mounted first has been holding a stale copy ever
       * since. Nothing is written out of this map directly: freshness is
       * re-established from storage at every settled write, and from another
       * window's `storage` event in between.
       */
      const rowColors = new Map()
      let rowColorsLoaded = false

      /**
       * Colours a picker is dragging RIGHT NOW, by session.
       *
       * A native colour input fires `input` per pixel of the drag. Those are
       * previews, not choices: painting them is the whole point of the control,
       * persisting them is a synchronous storage write per pixel. The id is
       * dropped the moment the drag settles, which is also what lets a foreign
       * window's `storage` event repaint every OTHER row without yanking the
       * colour out from under the pointer.
       */
      const previewRowColors = new Map()

      /**
       * The validated colour map, read from storage RIGHT NOW.
       *
       * Every entry goes through `normalizeRowColor`, so nothing unvalidated
       * can reach the stylesheet. Bad JSON, an array, a non-object, a refused
       * storage — all of them answer "no colours", which is the same answer as
       * an empty map and never a failure to report.
       * @returns {Map<string, string>} a FRESH map, which the caller owns.
       */
      const readRowColors = () => {
        const colors = new Map()
        try {
          const raw = globalThis.localStorage?.getItem?.(ROW_COLORS_STORAGE_KEY)
          if (typeof raw !== 'string' || raw.length === 0) return colors
          const parsed = JSON.parse(raw)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return colors
          for (const [id, value] of Object.entries(parsed)) {
            const color = normalizeRowColor(value)
            if (color !== null) colors.set(id, color)
          }
        } catch { /* not a colour map, not a failure */ }
        return colors
      }

      /** Replace the cache with what storage holds at this instant. */
      const adoptRowColors = () => {
        rowColors.clear()
        for (const [id, color] of readRowColors()) rowColors.set(id, color)
      }

      /**
       * Fill the cache once, for the first paint.
       *
       * Deliberately read-once: a reconcile repaints every row, so re-reading
       * storage per row per reconcile would turn an ordinary redraw into a
       * storage read storm. Freshness is re-established at the two points that
       * actually matter instead — a settled write, and another window's
       * `storage` event.
       */
      const loadRowColors = () => {
        if (rowColorsLoaded) return
        rowColorsLoaded = true
        adoptRowColors()
      }

      /**
       * Persist the whole map, under this plugin's key only.
       *
       * Reports whether the write actually LANDED. A browser that refuses
       * storage (private mode, disabled site data, quota) is a normal state and
       * the colour still shows — but "shows until reload" is not the promise the
       * dialog makes, so the caller is told rather than left to guess.
       * @returns {boolean} true when the map is now in storage.
       */
      const writeRowColors = () => {
        try {
          const store = globalThis.localStorage
          if (store === undefined || store === null || typeof store.setItem !== 'function') return false
          store.setItem(ROW_COLORS_STORAGE_KEY, JSON.stringify(Object.fromEntries(rowColors)))
          return true
        } catch {
          return false
        }
      }

      /**
       * Settle a colour for one session and persist it.
       *
       * The merge is the whole point. This used to put the in-memory map back
       * verbatim, so two windows on one origin — each holding the map it loaded
       * at mount — meant the second write erased the first one's colour. That
       * is the ordinary case of the same preference open twice, not a rare
       * race. So the latest validated map is read from storage AGAIN here, only
       * THIS id is changed on it, and that is what gets written; the in-memory
       * copy is refreshed from the result rather than from the gesture.
       *
       * What this does NOT do is pretend localStorage has a transaction. Two
       * contexts that write the same key in the same instant are still
       * last-writer-wins and nothing at this level can change that; what is
       * fixed here is the far more common case of a map that was ALREADY stale
       * when the gesture began.
       *
       * @param {string} id - the session.
       * @param {unknown} value - the chosen colour, or anything invalid.
       */
      const commitRowColor = (id, value) => {
        const next = readRowColors()
        const color = normalizeRowColor(value)
        // A clear deletes THIS id and nothing else, so no session's colour is
        // ever thrown away because another one was cleared.
        if (color === null) next.delete(id)
        else next.set(id, color)
        rowColors.clear()
        for (const [entryId, entryColor] of next) rowColors.set(entryId, entryColor)
        return writeRowColors()
      }

      /**
       * Record a colour (or the absence of one) for one session and repaint it.
       *
       * Every caller is a SETTLED gesture — the picker's `change`, a
       * Shift-click, a Delete. A drag still in progress goes through
       * `previewRowColor` instead and never reaches storage.
       * @param {Element} row - the row that owns the control.
       * @param {string} id - the session.
       * @param {unknown} value - the chosen colour, or anything invalid.
       */
      const setRowColor = (row, id, value) => {
        previewRowColors.delete(id)
        commitRowColor(id, value)
        paintRowColor(row, id)
        // The same colour also belongs on the HOST's row for this session, which
        // is where an unpinned session actually lives.
        reconcileHostRowColors(currentFlavor(Date.now()))
      }

      /**
       * Show the colour the user is still choosing. Nothing is persisted.
       * @param {Element} row - the row that owns the control.
       * @param {string} id - the session.
       * @param {unknown} value - the colour under the pointer right now.
       */
      const previewRowColor = (row, id, value) => {
        const color = normalizeRowColor(value)
        if (color === null) previewRowColors.delete(id)
        else previewRowColors.set(id, color)
        paintRowColor(row, id)
      }

      /**
       * Another window on this origin changed our colours. Repaint.
       *
       * Without this the two windows only ever agree on a reload, which is not
       * agreement — the user picks a colour in one, watches the other keep the
       * old one, and picks again.
       *
       * Three things it deliberately does NOT do:
       *
       *   - answer with a write. Handling a foreign write by writing is how a
       *     `storage` listener becomes an echo, and an echo storm between two
       *     windows is worse than being one reconcile stale.
       *   - touch a row whose picker is open. That row is showing a colour
       *     nobody has committed yet; overwriting it mid-drag takes the colour
       *     out from under the pointer. Its session's stored value is still
       *     read, so the write that ends the drag merges correctly.
       *   - care about any other key. Another plugin's preferences, the host's,
       *     this host's own storage — none of them are ours to interpret, and
       *     none of them are ours to write to.
       *
       * @param {StorageEvent} event - the foreign write.
       */
      const onRowColorsStorage = (event) => {
        if (!alive()) return
        if (event?.key !== ROW_COLORS_STORAGE_KEY) return
        adoptRowColors()
        for (const [id, row] of renderedRows) {
          if (previewRowColors.has(id)) continue
          paintRowColor(row, id)
        }
        reconcileHostRowColors(currentFlavor(Date.now()))
      }

      /**
       * Put a session's colour onto its row, in place.
       *
       * The value travels as a custom property the stylesheet mixes, and the
       * presence attribute selects the coloured rules — no string is ever
       * interpolated into CSS. Every write is guarded: an assignment that does
       * not change the value is still a mutation this plugin's observer sees.
       *
       * @param {Element} row - the row node.
       * @param {string} id - the session.
       */
      const paintRowColor = (row, id) => {
        // A drag in progress wins over the stored value: it is what the user is
        // looking at right now, and it is not committed yet.
        const color = previewRowColors.has(id)
          ? previewRowColors.get(id)
          : (rowColors.get(id) ?? null)
        try {
          const wanted = color ?? EMPTY_SWATCH_HEX
          if ((row.style?.getPropertyValue?.('--stp-row-color') ?? '').trim() !== wanted) {
            row.style.setProperty('--stp-row-color', wanted)
          }
        } catch { /* a renderer that refuses the property still gets the attribute */ }
        if (color === null) {
          if (row.hasAttribute(ROW_COLOR_ATTR)) row.removeAttribute(ROW_COLOR_ATTR)
        } else if (row.getAttribute(ROW_COLOR_ATTR) !== color) {
          row.setAttribute(ROW_COLOR_ATTR, color)
        }
        const swatch = row.querySelector?.('[data-stp-row-color]')
        if (swatch === null || swatch === undefined) return
        if (color === null) {
          if (swatch.hasAttribute(SWATCH_SET_ATTR)) swatch.removeAttribute(SWATCH_SET_ATTR)
        } else if (swatch.hasAttribute(SWATCH_SET_ATTR) !== true) {
          swatch.setAttribute(SWATCH_SET_ATTR, '')
        }
        // The native input is the picker: it must open on what the row actually
        // carries, or a reload hands the user a stale or blank swatch.
        const input = swatch.querySelector?.('[data-stp-color-input]')
        if (input !== null && input !== undefined) {
          const wanted = color ?? EMPTY_SWATCH_HEX
          if (input.value !== wanted) input.value = wanted
        }
        // A plain click always PICKS, so the name says that in both states; the
        // way back to the default is named too.
        const label = color === null
          ? '设置背景颜色（Shift+点击或按 Delete 恢复默认）'
          : `设置背景颜色，当前 ${color}（Shift+点击或按 Delete 恢复默认）`
        if (swatch.getAttribute('aria-label') !== label) swatch.setAttribute('aria-label', label)
      }

      /**
       * Host rows this mount has painted, so every mark can be handed back — on a
       * colour that was cleared, on a row the host unmounted, and on teardown.
       * @type {Set<Element>}
       */
      const hostPaintedRows = new Set()

      /** The dialog this mount has open, or null. At most one, ever. */
      let colorDialog = null

      /** @returns {string} the dialog's own name. */
      const COLOR_DIALOG_LABEL = () => translate('color.dialog', '自定义行背景颜色')
      /** @returns {string} the hex field's own name. */
      const COLOR_HEX_LABEL = () => translate('color.hex', '六位十六进制颜色，例如 #1a2b3c')

      /**
       * Put a session's colour on the HOST's own row, or take it off.
       *
       * The same `rowColors` map, the same attribute, the same custom property
       * and therefore the same stylesheet rule as a pinned row's — the only
       * difference is which element carries them. Nothing is written for a row
       * that has no colour, so an idle sidebar is left exactly as the host drew
       * it, and every write is compare-and-set so a repeated pass is silent.
       *
       * @param {Element} row - a host session row.
       * @param {string} id - the session.
       */
      const paintHostRowColor = (row, id) => {
        const color = rowColors.get(id) ?? null
        try {
          const current = (row.style?.getPropertyValue?.('--stp-row-color') ?? '').trim()
          if (color === null) {
            if (current !== '') row.style.removeProperty('--stp-row-color')
          } else if (current !== color) {
            row.style.setProperty('--stp-row-color', color)
          }
        } catch { /* the attribute alone still selects the coloured rules */ }
        try {
          if (color === null) {
            if (row.hasAttribute?.(ROW_COLOR_ATTR) === true) row.removeAttribute(ROW_COLOR_ATTR)
          } else if (row.getAttribute?.(ROW_COLOR_ATTR) !== color) {
            row.setAttribute(ROW_COLOR_ATTR, color)
            hostPaintedRows.add(row)
          }
        } catch { /* a row that refuses attributes keeps the host's own look */ }
        if (color === null) hostPaintedRows.delete(row)
      }

      /** Hand one host row back, in place, whatever it had of ours. */
      const unpaintHostRow = (row) => {
        try {
          if (row.getAttribute?.(ROW_COLOR_ATTR) !== null) row.removeAttribute(ROW_COLOR_ATTR)
          if ((row.style?.getPropertyValue?.('--stp-row-color') ?? '') !== '') {
            row.style.removeProperty('--stp-row-color')
          }
        } catch { /* nothing of ours is left on it */ }
        hostPaintedRows.delete(row)
      }

      /** Take every host-row mark back. Called on dispose and on no-proof paths. */
      const clearHostRowColors = () => {
        for (const row of [...hostPaintedRows]) unpaintHostRow(row)
        hostPaintedRows.clear()
      }

      /**
       * Repaint every host session row of the current sidebar from the map.
       *
       * Scoped twice, exactly like every other host rule in this plugin: the
       * rows are looked up with the DETECTED flavor's own selector and then
       * under the ONE tree `findTree` proved, so a search tree, a file tree or
       * any third-party list that happens to share the shape is never touched.
       * No colour is written for a row that has none.
       *
       * @param {object | null} flavor - the detected sidebar, or null.
       */
      const reconcileHostRowColors = (flavor) => {
        if (flavor === null) {
          clearHostRowColors()
          return
        }
        const tree = findTree(flavor)
        if (tree === null) {
          clearHostRowColors()
          return
        }
        let rows = null
        try {
          rows = tree.querySelectorAll(flavor.sessionSelector)
        } catch (error) {
          warn(`host session rows unreadable: ${describeError(error)}`)
          return
        }
        loadRowColors()
        const live = new Set()
        for (const row of rows) {
          let id = null
          try { id = flavor.sessionIdOf(row) } catch { continue }
          if (id === undefined) continue
          live.add(row)
          paintHostRowColor(row, id)
        }
        for (const row of [...hostPaintedRows]) {
          if (live.has(row) !== true) unpaintHostRow(row)
        }
      }

      /**
       * Repaint one session's colour everywhere it is on screen — its pinned row
       * and the host's own row for the same session. Used by the menu paths,
       * which name a session and may not have a row of ours in hand at all.
       * @param {string} id - the session.
       */
      const paintSessionColor = (id) => {
        loadRowColors()
        const own = renderedRows.get(id)
        if (own !== undefined) paintRowColor(own, id)
        reconcileHostRowColors(currentFlavor(Date.now()))
      }

      /**
       * The plugin's own colour dialog: one element, one session, opened from the
       * row's colour point OR from any menu entry that names a session id.
       *
       * WHY IT EXISTS. `input[type=color].click()` is a gesture, not an interface:
       * it cannot be driven from a menu, it cannot be typed into, and it gives a
       * person no way to see or correct a value. So the six-digit hex box is the
       * control and the native swatch is the helper, and both commit through the
       * SAME `commitRowColor` the old path used — one data source, one validation,
       * one merge.
       *
       * NOTHING IS STORED UNTIL 应用 OR 恢复默认. Typing moves the helper swatch
       * only; Escape, 取消 and clicking away all store nothing at all.
       *
       * A refused storage is NOT swallowed here: the colour is painted, the
       * dialog closes, and the user is told it will not survive a reload. A
       * silent "applied" that forgets itself is the one outcome this plugin's own
       * degradation contract exists to avoid.
       *
       * @param {string} sessionId - the session being coloured.
       * @param {Element | null} [opener] - what gets focus back on close.
       * @returns {Element | null} the dialog element, or null when it could not open.
       */
      const openColorDialog = (sessionId, opener = null) => {
        if (!alive()) return null
        if (typeof sessionId !== 'string' || sessionId.length === 0) return null
        closeColorDialog()
        loadRowColors()
        const initial = rowColors.get(sessionId) ?? EMPTY_SWATCH_HEX

        const el = document.createElement('div')
        el.setAttribute(COLOR_DIALOG_ATTR, '')
        el.setAttribute('role', 'dialog')
        el.setAttribute('aria-modal', 'false')
        el.setAttribute('aria-label', COLOR_DIALOG_LABEL())
        // `data-plugin` is what the plugin's own observer filter recognises, so
        // building this surface cannot schedule a reconcile of its own.
        el.setAttribute('data-plugin', PLUGIN_ID)
        el.setAttribute('data-stp-session', sessionId)

        const title = document.createElement('div')
        title.setAttribute('data-stp-color-dialog-title', '')
        title.textContent = COLOR_DIALOG_LABEL()
        el.appendChild(title)

        const field = document.createElement('div')
        field.setAttribute('data-stp-color-dialog-field', '')
        const hex = document.createElement('input')
        hex.setAttribute(COLOR_HEX_ATTR, '')
        hex.setAttribute('type', 'text')
        hex.setAttribute('inputmode', 'text')
        hex.setAttribute('autocomplete', 'off')
        hex.setAttribute('spellcheck', 'false')
        hex.setAttribute('aria-label', COLOR_HEX_LABEL())
        hex.value = initial
        const native = document.createElement('input')
        native.setAttribute(COLOR_NATIVE_ATTR, '')
        native.setAttribute('type', 'color')
        native.setAttribute('aria-hidden', 'true')
        native.setAttribute('tabindex', '-1')
        try { native.value = initial } catch { /* the helper is optional by design */ }
        field.appendChild(hex)
        field.appendChild(native)
        el.appendChild(field)

        const error = document.createElement('div')
        error.setAttribute(COLOR_ERROR_ATTR, '')
        error.setAttribute('role', 'status')
        error.setAttribute('hidden', '')
        el.appendChild(error)

        /** Say what is wrong, in the field itself, without closing anything. */
        const showError = (message) => {
          if (error.textContent !== message) error.textContent = message
          try {
            if (message === '') error.setAttribute('hidden', '')
            else error.removeAttribute('hidden')
          } catch { /* the message is still readable either way */ }
          hex.setAttribute('aria-invalid', message === '' ? 'false' : 'true')
        }

        const actions = document.createElement('div')
        actions.setAttribute('data-stp-color-dialog-actions', '')
        const button = (attr, label) => {
          const node = document.createElement('button')
          node.setAttribute(COLOR_BUTTON_ATTR, '')
          node.setAttribute(attr, '')
          node.setAttribute('type', 'button')
          node.setAttribute('data-plugin', PLUGIN_ID)
          node.textContent = label
          return node
        }
        const applyBtn = button(COLOR_APPLY_ATTR, translate('color.apply', '应用'))
        const cancelBtn = button(COLOR_CANCEL_ATTR, translate('color.cancel', '取消'))
        const resetBtn = button(COLOR_RESET_ATTR, translate('color.reset', '恢复默认'))
        actions.appendChild(resetBtn)
        actions.appendChild(cancelBtn)
        actions.appendChild(applyBtn)
        el.appendChild(actions)

        // The one settle path every button, Escape and Enter goes through.
        const commit = (value) => {
          // A dialog that outlived its mount must not write: `closeColorDialog`
          // removed the node, and nothing on this page is listening any more.
          if (!alive()) return
          const color = normalizeRowColor(value)
          if (color === null && value !== null) {
            showError(translate('color.invalid', '请输入六位十六进制颜色，例如 #1a2b3c'))
            return
          }
          const stored = commitRowColor(sessionId, color)
          previewRowColors.delete(sessionId)
          paintSessionColor(sessionId)
          closeColorDialog()
          if (!alive()) return
          if (stored !== true) {
            surfaceError(translate(
              'color.unavailable',
              '本机浏览器拒绝写入本地存储，颜色只在本次生效',
            ), 'unavailable')
          }
        }

        applyBtn.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          commit(hex.value)
        })
        resetBtn.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          commit(null)
        })
        cancelBtn.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          closeColorDialog()
        })
        // The native swatch is a helper for the same value: it drives the box,
        // never storage.
        native.addEventListener('input', (event) => {
          event.stopPropagation()
          hex.value = native.value
          showError('')
        })
        native.addEventListener('change', (event) => {
          event.stopPropagation()
          hex.value = native.value
          showError('')
        })
        el.addEventListener('keydown', (event) => {
          // This surface is outside the sidebar's own key handling, and the host
          // listens in the capture phase, so nothing here can be relied on to
          // stop at this node: only stopping it ourselves closes the question.
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            closeColorDialog()
            return
          }
          if (event.key === 'Enter') {
            // ONLY from the hex field or the native swatch. The dialog has three
            // buttons, and Enter on 取消 or 恢复默认 is the keyboard way to press
            // THAT button — swallowing it and committing the colour instead made
            // the keyboard cancel and reset silently save. A focused button keeps
            // its own native activation, which is what Enter already does.
            const target = event.target
            const tag = target?.tagName
            if (tag !== undefined && tag !== null && String(tag).toUpperCase() === 'BUTTON') return
            event.preventDefault()
            commit(hex.value)
          }
        })
        // The dialog is appended to `body`, never to a row, but a click inside
        // it must never reach the sidebar's own row handlers either.
        el.addEventListener('click', (event) => { event.stopPropagation() })

        try {
          document.body?.appendChild(el)
        } catch (error) {
          warn(`could not open the colour dialog: ${describeError(error)}`)
          return null
        }
        placeDialog(el)
        colorDialog = { el, opener: opener ?? null }
        try { hex.focus?.() } catch { /* focus is a nicety, not a contract */ }
        return el
      }

      /**
       * Close the dialog, if one is open, and hand focus back to its opener.
       * Safe from anywhere and any number of times.
       */
      const closeColorDialog = () => {
        const open = colorDialog
        if (open === null) return
        colorDialog = null
        try { open.el.remove() } catch { /* already gone with the document */ }
        const opener = open.opener
        // Only a focus that is still in the document can be given back; a row the
        // host re-rendered is not a target.
        if (opener === null || opener === undefined) return
        if (opener.isConnected === false) return
        try { opener.focus?.() } catch { /* focus is a nicety, not a contract */ }
      }

      /**
       * Put the dialog in the middle of the viewport.
       *
       * Percentages are avoided deliberately: the menu's own placement is a
       * measured pixel nudge for the same reason, and a dialog placed by
       * transform cannot be measured by anything that is not a browser.
       * @param {Element} surface - the dialog element.
       */
      const placeDialog = (surface) => {
        try {
          const style = surface.style
          if (style === undefined || style === null) return
          const width = surface.offsetWidth ?? 0
          const height = surface.offsetHeight ?? 0
          const viewportWidth = globalThis.innerWidth ?? 0
          const viewportHeight = globalThis.innerHeight ?? 0
          const left = viewportWidth > 0 ? Math.max(0, Math.round((viewportWidth - width) / 2)) : 80
          const top = viewportHeight > 0 ? Math.max(0, Math.round((viewportHeight - height) / 2)) : 80
          style.setProperty('left', `${left}px`)
          style.setProperty('top', `${top}px`)
        } catch (error) {
          warn(`could not place the colour dialog: ${describeError(error)}`)
        }
      }

      /**
       * The colour point at a row's trailing edge, and the native control
       * behind it.
       *
       * A `span[role="button"]`, never a `<button>`: the shared owner recognises
       * a session row by a `button[aria-label]` descendant, so a real button
       * here would make it resolve the CURRENT session instead of the clicked
       * one. The input is `aria-hidden` and off the tab order, so the accessible
       * control is the swatch and there is exactly one.
       *
       * @param {Element} row - the row the swatch belongs to.
       * @param {string} id - the session this row is for.
       * @returns {Element} the swatch.
       */
      const makeColorSwatch = (row, id) => {
        const swatch = document.createElement('span')
        swatch.setAttribute(SWATCH_ATTR, '')
        swatch.setAttribute('role', 'button')
        swatch.setAttribute('tabindex', '0')
        swatch.setAttribute('title', '背景颜色：点击选择，Shift+点击或按 Delete 恢复默认')

        const input = document.createElement('input')
        input.setAttribute('data-stp-color-input', '')
        input.setAttribute('type', 'color')
        input.setAttribute('aria-hidden', 'true')
        input.setAttribute('tabindex', '-1')
        input.setAttribute('value', EMPTY_SWATCH_HEX)
        try { input.value = EMPTY_SWATCH_HEX } catch { /* the attribute carries it */ }
        swatch.appendChild(input)

        /** Open the plugin's own colour dialog for this session. */
        const pick = () => { openColorDialog(id, swatch) }
        swatch.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.shiftKey === true) setRowColor(row, id, null)
          else pick()
        })
        swatch.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Delete' && event.key !== 'Backspace') return
          event.preventDefault()
          event.stopPropagation()
          if (event.shiftKey === true) setRowColor(row, id, null)
          else if (event.key === 'Delete' || event.key === 'Backspace') setRowColor(row, id, null)
          else pick()
        })
        // The input lives INSIDE the row, so every event it produces has to be
        // stopped on the way out or it opens the session behind the picker.
        input.addEventListener('click', (event) => { event.stopPropagation() })
        input.addEventListener('keydown', (event) => { event.stopPropagation() })
        // `input` fires once per pixel of a drag: paint it, remember nothing.
        // `change` is the gesture that ends, and it is the one that persists.
        input.addEventListener('input', (event) => {
          event.stopPropagation()
          previewRowColor(row, id, input.value)
        })
        input.addEventListener('change', (event) => {
          event.stopPropagation()
          setRowColor(row, id, input.value)
        })
        return swatch
      }

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
          // A key aimed at a control INSIDE the row belongs to that control;
          // without this, a Delete on the colour swatch opens the session.
          if (event.target !== row) return
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
        // The colour point is last, and painted from storage on the FIRST
        // render: a colour chosen in a previous session is on screen at once.
        loadRowColors()
        row.appendChild(makeColorSwatch(row, id))
        paintRowColor(row, id)
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
       * The remembered fold for this mount, or `null` until a header exists.
       *
       * Read once, then the user's. It is deliberately NOT in
       * `regionSignature`: a fold is a preference, and a reconcile that
       * re-applied the default would slam the region shut on them.
       */
      let regionCollapsed = null

      /** Push the fold onto the region and its control. Idempotent. */
      const applyRegionFold = () => {
        if (regionEl === null || regionHeaderEl === null) return
        const collapsed = regionCollapsed === true
        if (regionEl.getAttribute(REGION_COLLAPSED_ATTR) !== String(collapsed)) {
          regionEl.setAttribute(REGION_COLLAPSED_ATTR, String(collapsed))
        }
        if (regionHeaderEl.getAttribute('aria-expanded') !== String(!collapsed)) {
          regionHeaderEl.setAttribute('aria-expanded', String(!collapsed))
        }
        const caret = regionHeaderEl.querySelector('[data-stp-region-caret]')
        const glyph = collapsed === true ? '▸' : '▾'
        if (caret !== null && caret.textContent !== glyph) caret.textContent = glyph
      }

      /**
       * The user's fold. Stopped on the way out: this gesture belongs to this
       * control alone and can never open a session or touch the pin set.
       * @param {Event} event - the activating event.
       */
      function onRegionHeaderActivate(event) {
        if (!alive() || regionHeaderEl === null) return
        event.preventDefault()
        event.stopPropagation()
        regionCollapsed = regionCollapsed !== true
        writeRegionCollapsed(regionCollapsed)
        applyRegionFold()
      }

      /**
       * Enter and Space on the header. It is a `role="button"`, not a native
       * `<button>`, so nothing synthesizes these clicks for us.
       * @param {Event} event - the key event.
       */
      function onRegionHeaderKey(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return
        onRegionHeaderActivate(event)
      }

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
          // Ahead of the trailing colour point, exactly where a first render
          // puts it: appending here would land the time AFTER it on the rows
          // whose summary arrived without a timestamp.
          row.insertBefore(cell, row.querySelector(`[${SWATCH_ATTR}]`) ?? null)
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
        const id = row.getAttribute('data-stp-session')
        const title = rowFields(id, summary).title
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
        // Repainted from the map, never from a stale DOM read, so an update
        // can neither lose a colour nor invent one. Writes are guarded inside.
        loadRowColors()
        paintRowColor(row, id)
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
          // An uncommitted picker drag belongs to the ROW, and the row is going
          // away. Left behind it would resurface on the next render of this
          // session as a colour the user never committed — a preview outliving
          // the thing it was previewing.
          previewRowColors.delete(id)
          renderedOrder.splice(renderedOrder.indexOf(id), 1)
          row.remove()
        }
        if (pinned.length === 0) {
          clearRegion()
          detachRegion()
          return
        }

        if (regionHeaderEl === null) {
          if (regionCollapsed === null) regionCollapsed = readRegionCollapsed()
          regionHeaderEl = document.createElement('div')
          regionHeaderEl.setAttribute('data-stp-region-header', '')
          // A control, not a label: the user folds this region by hand, so it
          // must be focusable, operable from the keyboard and self-describing.
          // NOT `<button>`, which would synthesize a click for Enter/Space on
          // top of the key handling below.
          regionHeaderEl.setAttribute('role', 'button')
          regionHeaderEl.setAttribute('tabindex', '0')
          regionHeaderEl.setAttribute('aria-label', PINNED_LABEL())
          const caret = document.createElement('span')
          caret.setAttribute('data-stp-region-caret', '')
          caret.setAttribute('aria-hidden', 'true')
          regionHeaderEl.appendChild(caret)
          const headIcon = document.createElement('span')
          headIcon.setAttribute('aria-hidden', 'true')
          headIcon.textContent = PIN_GLYPH_FILLED
          regionHeaderLabelEl = document.createElement('span')
          const headCount = document.createElement('span')
          headCount.setAttribute('data-stp-region-count', '')
          regionHeaderEl.appendChild(headIcon)
          regionHeaderEl.appendChild(regionHeaderLabelEl)
          regionHeaderEl.appendChild(headCount)
          regionHeaderEl.addEventListener('click', onRegionHeaderActivate)
          regionHeaderEl.addEventListener('keydown', onRegionHeaderKey)
          // The GROUP still carries the name for the rows, and stays a group
          // rather than a tree: the region is outside the sidebar's
          // `[role="tree"]` and its rows are `role="button"` (see `makeRow`).
          regionEl.setAttribute('role', 'group')
          regionEl.appendChild(regionHeaderEl)
        }
        const label = PINNED_LABEL()
        if (regionEl.getAttribute('aria-label') !== label) regionEl.setAttribute('aria-label', label)
        if (regionHeaderEl.getAttribute('aria-label') !== label) regionHeaderEl.setAttribute('aria-label', label)
        if (regionHeaderLabelEl.textContent !== label) regionHeaderLabelEl.textContent = label
        applyRegionFold()
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
       * `initial` is the one-time "this directory has not been closed yet"
       * initialization, which is a question of its OWN and not the pin rule
       * wearing a hat. While it is set the target is CLOSED whatever the pin
       * set says, so the default fold can never be followed — one reconcile
       * later, after it has landed — by the pin rule's "no pin means expand".
       * `tried` records that the initialization has actually asked for it, so a
       * group the USER opens afterwards is handed over rather than re-closed.
       *
       * An intent carries the signature it was ISSUED against, because the
       * signature can move while the click is in flight and the reading the
       * click lands on has to be booked against the question that was asked —
       * not against the one that arrived in the meantime.
       *
       * @type {Map<string, {
       *   confirmed: string | null,
       *   initial: boolean,
       *   tried: boolean,
       *   intent: null | {
       *     wantExpanded: boolean,
       *     signature: string,
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

      // ------------------------------------------------------ panels region

      /**
       * The panels region this mount currently owns, and the state it is in.
       *
       * `nav` / `toggle` are the live nodes (they change when the sidebar
       * re-mounts); `addedId` records whether the id on the nav is OURS, so
       * teardown removes exactly what it added and never a host id it found.
       */
      const panels = { nav: null, toggle: null, addedId: false, collapsed: null }

      /**
       * The panels region this plugin may fold: the host's panel-list nav that
       * sits in the SAME sidebar column as the session list it has already
       * positively identified.
       *
       * "Same column" is decided by the nearest common ancestor carrying the
       * host root's own class (`css.root`, hashed but readable) — NOT by merely
       * sharing an ancestor, which every node on the page does with `body` and
       * would adopt an unrelated nav.
       */
      const panelsNavFor = (tree) => {
        if (tree == null) return null
        let candidates = null
        try {
          candidates = document.querySelectorAll(PANELS_NAV_SELECTOR)
        } catch (error) {
          warn(`panel navigation unreadable: ${describeError(error)}`)
          return null
        }
        for (const nav of candidates) {
          // A session list is never a panel region, and folding one hides rows.
          if (nav.closest('[role="tree"]') !== null) continue
          const root = sidebarRootSharedWith(nav, tree)
          if (root === null) continue
          if (sidebarRailIn(root)) continue
          return nav
        }
        return null
      }

      /**
       * The nearest ancestor both nodes hang from, when it is the sidebar root.
       * @returns {Element | null} the sidebar root, or null when they are not
       *   in one sidebar (or the shared ancestor is only the document).
       */
      const sidebarRootSharedWith = (nav, tree) => {
        const above = new Set()
        for (let node = tree; node != null; node = node.parentElement) above.add(node)
        for (let node = nav.parentElement; node != null; node = node.parentElement) {
          if (!above.has(node)) continue
          if (node === document.body || node === document.documentElement) return null
          return hasSidebarRootClass(node) === true ? node : null
        }
        return null
      }

      /** Does this element carry the host sidebar root's own class? */
      const hasSidebarRootClass = (element) =>
        typeof element.className === 'string'
        && element.className.split(/\s+/).some(token => token.includes('root'))

      /** Build (or adopt) the control, and put it directly above the nav. */
      const ensurePanelsToggle = (nav) => {
        const existing = document.querySelector(`[${PANELS_TOGGLE_ATTR}]`)
        const toggle = existing instanceof Element ? existing : document.createElement('button')
        toggle.setAttribute(PANELS_TOGGLE_ATTR, '')
        toggle.setAttribute('type', 'button')
        // `data-plugin` marks it ours, which keeps its own insertion from
        // coming back through the observer as host news.
        toggle.setAttribute('data-plugin', PLUGIN_ID)
        toggle.setAttribute('aria-label', PANELS_TOGGLE_LABEL)
        // Built ONCE. An idle pass that rebuilt the children would mutate the
        // sidebar on every notification and feed its own observer.
        if (toggle.children.length === 0) {
          const caret = document.createElement('span')
          caret.setAttribute('data-stp-panels-caret', '')
          caret.setAttribute('aria-hidden', 'true')
          caret.textContent = '▸'
          toggle.appendChild(caret)
          const label = document.createElement('span')
          label.setAttribute('data-stp-panels-label', '')
          label.textContent = PANELS_TOGGLE_LABEL
          toggle.appendChild(label)
        }
        const parent = nav.parentElement
        if (parent !== null && toggle.nextElementSibling !== nav) parent.insertBefore(toggle, nav)
        // Bound once per ELEMENT, not once per pass: a reconcile that re-ran
        // this would otherwise stack a listener per pass on the same node.
        if (toggle.hasAttribute('data-stp-panels-bound') !== true) {
          toggle.setAttribute('data-stp-panels-bound', '')
          toggle.addEventListener('click', onPanelsToggle)
        }
        return toggle
      }

      /** The user's click: flip the state, remember it, and repaint the sheet. */
      function onPanelsToggle() {
        if (!alive()) return
        if (panels.collapsed === null) panels.collapsed = readPanelsPreference()
        panels.collapsed = panels.collapsed !== true
        writePanelsPreference(panels.collapsed)
        // Painted immediately, not on the next pass: the label says one thing
        // and the region does another for 60ms is a visible stutter on a
        // control whose whole job is to be immediate.
        applyPanelsState()
        writeDynamicSheet()
      }

      /** Push the current state onto the nav and the control. */
      const applyPanelsState = () => {
        const { nav, toggle } = panels
        if (nav == null || toggle == null) return
        const collapsed = panels.collapsed === true
        nav.setAttribute(PANELS_STATE_ATTR, collapsed === true ? 'collapsed' : 'expanded')
        toggle.setAttribute('aria-expanded', collapsed === true ? 'false' : 'true')
        const caret = toggle.querySelector('[data-stp-panels-caret]')
        const glyph = collapsed === true ? '▸' : '▾'
        if (caret != null && caret.textContent !== glyph) caret.textContent = glyph
      }

      /**
       * Fold the panels region, or hand it back.
       *
       * Called from every reconcile and therefore deliberately IDEMPOTENT: it
       * applies the state this mount is in and never re-reads the default over
       * the user's choice. The preference is consulted exactly once, when a nav
       * is first seen.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {Element | null} tree - the identified session list.
       */
      const reconcilePanels = (flavor, tree) => {
        const nav = flavor === FLAVOR_OFFICIAL ? panelsNavFor(tree) : null
        if (nav === null) {
          clearPanels()
          return
        }
        if (panels.collapsed === null) panels.collapsed = readPanelsPreference()
        // A different nav means the sidebar re-mounted: give the old one back
        // before adopting the new one, or the previous column keeps a control
        // and a fold attribute it has no owner for.
        if (panels.nav !== null && panels.nav !== nav) releasePanels()
        const toggle = ensurePanelsToggle(nav)
        if (panels.nav !== nav) {
          // Lend the nav an id ONLY if it has none, and remember whether that
          // one is ours — a host id is left alone on the way out.
          panels.addedId = nav.getAttribute('id') === null
          if (panels.addedId === true) nav.setAttribute('id', PANELS_ID)
        }
        if (toggle.getAttribute('aria-controls') !== nav.getAttribute('id')) {
          toggle.setAttribute('aria-controls', nav.getAttribute('id') ?? '')
        }
        panels.nav = nav
        panels.toggle = toggle
        applyPanelsState()
      }

      /**
       * Write the one dynamic stylesheet: the pin rules and the panels fold.
       *
       * Single writer, so the two can never disagree about what is in force.
       * @param {object | null} [flavor] - an already-probed flavor, if the caller has one.
       */
      const writeDynamicSheet = (flavor = currentFlavor(Date.now())) => {
        applyPinRules(dynamicSheet, flavor, flavor === null ? [] : [...pinSet()],
          panels.collapsed === true, directory.collapsed === true)
      }

      /** Undo exactly what `reconcilePanels` did to the DOM. */
      const clearPanels = () => {
        releasePanels()
        panels.collapsed = null
      }

      const releasePanels = () => {
        const { nav, toggle } = panels
        if (nav != null) {
          if (panels.addedId === true && nav.getAttribute('id') === PANELS_ID) nav.removeAttribute('id')
          nav.removeAttribute(PANELS_STATE_ATTR)
        }
        if (toggle != null && toggle.isConnected !== false) toggle.remove()
        panels.nav = null
        panels.toggle = null
        panels.addedId = false
      }

      // ------------------------------------------- workspace-directory region

      /**
       * The workspace-directory region this mount currently owns.
       * Same shape and same reasons as `panels`.
       */
      const directory = { body: null, toggle: null, addedId: false, collapsed: null }

      /**
       * The ONE body this plugin may fold, reached from the PROVEN tree instead
       * of searched for by name.
       *
       * `tree.parentElement` is the seat the host renders the directory headers
       * AND their sessions into (`WorkspaceBrowser.tsx:669`), and it is already
       * the element `findTreeHost` climbs past to seat the pinned region above
       * it. Reaching it from the identified tree is what keeps the fold honest:
       * a selector on the host's hashed `treeBody` class would be a global
       * sweep, and a look-alike seat rendered anywhere else on the page would be
       * hidden with it.
       *
       * Two things are required before it is adopted, both about honesty rather
       * than caution:
       *
       *   - it actually holds a `workspace:` header, so "the workspace
       *     directories" is what would be hidden. The stock sidebar's FLAT view
       *     renders no directories at all, and a control labelled 工作区目录 over
       *     a plain session list would be a claim this build cannot make.
       *   - the sidebar is not in the host's narrow rail, which is a whole-column
       *     state the host renders correctly on its own.
       *
       * codex-ui gets no answer here on purpose: it renders one
       * `.dcu-wb-project` per workspace with no single seat holding them all, so
       * there is no provable seam to fold. Its per-DIRECTORY default fold needs
       * no such seam and still runs.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {Element | null} tree - the identified session list.
       * @returns {Element | null} the body, or null when there is nothing proven.
       */
      const directoryBodyFor = (flavor, tree) => {
        if (flavor !== FLAVOR_OFFICIAL || tree == null) return null
        const body = tree.parentElement
        if (body == null) return null
        if (sidebarRailIn(body)) return null
        if (body.querySelector(`[${ROW_KEY_ATTR}^="${WORKSPACE_ROW_PREFIX}"]`) === null) return null
        return body
      }

      /** Build (or adopt) the control, and put it directly above the body. */
      const ensureDirectoryToggle = (body) => {
        const existing = document.querySelector(`[${GROUPS_TOGGLE_ATTR}]`)
        const toggle = existing instanceof Element ? existing : document.createElement('button')
        toggle.setAttribute(GROUPS_TOGGLE_ATTR, '')
        toggle.setAttribute('type', 'button')
        toggle.setAttribute('data-plugin', PLUGIN_ID)
        toggle.setAttribute('aria-label', GROUPS_TOGGLE_LABEL)
        // Built ONCE, for the same reason the panels control is: an idle pass
        // that rebuilt the children would mutate the sidebar on every
        // notification and feed its own observer.
        if (toggle.children.length === 0) {
          const caret = document.createElement('span')
          caret.setAttribute('data-stp-groups-caret', '')
          caret.setAttribute('aria-hidden', 'true')
          caret.textContent = '▸'
          toggle.appendChild(caret)
          const label = document.createElement('span')
          label.setAttribute('data-stp-groups-label', '')
          label.textContent = GROUPS_TOGGLE_LABEL
          toggle.appendChild(label)
        }
        // ABOVE the body it folds, never inside it: a control inside the body
        // disappears with the very fold it controls.
        const parent = body.parentElement
        if (parent !== null && toggle.nextElementSibling !== body) parent.insertBefore(toggle, body)
        // Bound once per ELEMENT, not once per pass.
        if (toggle.hasAttribute('data-stp-groups-bound') !== true) {
          toggle.setAttribute('data-stp-groups-bound', '')
          toggle.addEventListener('click', onDirectoryToggle)
        }
        return toggle
      }

      /** The user's click: flip the state, remember it, and repaint the sheet. */
      function onDirectoryToggle() {
        if (!alive()) return
        if (directory.collapsed === null) directory.collapsed = readGroupsPreference()
        directory.collapsed = directory.collapsed !== true
        writeGroupsPreference(directory.collapsed)
        // Painted immediately: a control whose label and region disagree for
        // 60ms reads as a control that dropped the click.
        applyDirectoryState()
        writeDynamicSheet()
      }

      /** Push the current state onto the body and the control. */
      const applyDirectoryState = () => {
        const { body, toggle } = directory
        if (body == null || toggle == null) return
        const collapsed = directory.collapsed === true
        const next = collapsed === true ? 'collapsed' : 'expanded'
        if (body.getAttribute(GROUPS_STATE_ATTR) !== next) body.setAttribute(GROUPS_STATE_ATTR, next)
        const expanded = collapsed === true ? 'false' : 'true'
        if (toggle.getAttribute('aria-expanded') !== expanded) toggle.setAttribute('aria-expanded', expanded)
        const caret = toggle.querySelector('[data-stp-groups-caret]')
        const glyph = collapsed === true ? '▸' : '▾'
        if (caret != null && caret.textContent !== glyph) caret.textContent = glyph
      }

      /**
       * Fold the directory region, or hand it back.
       *
       * Idempotent by construction, exactly like `reconcilePanels`: it applies
       * the state this mount is in and never re-reads the default over the
       * user's choice. The preference is consulted exactly once, when a body is
       * first seen. Nothing here removes or re-parents a host node — the fold is
       * one stylesheet rule, so every group's own expansion is exactly where the
       * user left it when the region comes back.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {Element | null} tree - the identified session list.
       */
      const reconcileDirectoryRegion = (flavor, tree) => {
        const body = directoryBodyFor(flavor, tree)
        if (body === null) {
          clearDirectoryRegion()
          return
        }
        if (directory.collapsed === null) directory.collapsed = readGroupsPreference()
        // A different body means the sidebar re-mounted: give the old one back
        // before adopting the new one.
        if (directory.body !== null && directory.body !== body) releaseDirectoryRegion()
        const toggle = ensureDirectoryToggle(body)
        if (directory.body !== body) {
          directory.addedId = body.getAttribute('id') === null
          if (directory.addedId === true) body.setAttribute('id', GROUPS_ID)
        }
        if (toggle.getAttribute('aria-controls') !== body.getAttribute('id')) {
          toggle.setAttribute('aria-controls', body.getAttribute('id') ?? '')
        }
        directory.body = body
        directory.toggle = toggle
        if (body.getAttribute(GROUPS_BODY_ATTR) === null) body.setAttribute(GROUPS_BODY_ATTR, '')
        applyDirectoryState()
      }

      /** Undo exactly what `reconcileDirectoryRegion` did to the DOM. */
      const clearDirectoryRegion = () => {
        releaseDirectoryRegion()
        directory.collapsed = null
      }

      const releaseDirectoryRegion = () => {
        const { body, toggle } = directory
        if (body != null) {
          if (directory.addedId === true && body.getAttribute('id') === GROUPS_ID) body.removeAttribute('id')
          body.removeAttribute(GROUPS_STATE_ATTR)
          body.removeAttribute(GROUPS_BODY_ATTR)
        }
        if (toggle != null && toggle.isConnected !== false) toggle.remove()
        directory.body = null
        directory.toggle = null
        directory.addedId = false
      }

      // --------------------------------------------------------- sidebar footer

      /**
       * The sidebar column this plugin will look for the footer surfaces in.
       *
       * Derived from the TREE, not from a class name: walk up from the proven
       * session list and take the FIRST ancestor that actually contains one of
       * the footer surfaces. That is a positive proof on both ends — the tree
       * says which column this is, and the anchor says the footer is here — and
       * it needs no guess about what the host calls its own wrapper.
       *
       * The earlier version asked for an ancestor whose class token contained
       * "root", which is a GUESS about the host's markup, and on the shipped
       * page it simply never matched: `root` came back null, every footer mark
       * was skipped, and the whole footer compaction silently did nothing while
       * every test stayed green, because the fixture agreed with the guess.
       *
       * `<body>` is refused for the same reason it always was — "everything is
       * under body" is not a column — so the walk can never become a page-wide
       * sweep; it stops at the first ancestor that holds the footer.
       *
       * @param {Element | null} tree - the identified session list.
       * @returns {Element | null} the column, or null when there is none.
       */
      const footerScopeFor = (tree) => {
        if (tree == null) return null
        for (let node = tree.parentElement; node != null; node = node.parentElement) {
          if (node === document.body || node === document.documentElement) return null
          try {
            if (node.querySelector(`[role="region"][aria-label="${BALANCE_REGION_LABEL}"]`) !== null) return node
          } catch {
            return null
          }
        }
        return null
      }

      /**
       * The same walk, keyed on the account menu's own `aria-label`.
       *
       * The account trigger lives in its OWN root, which the live page proved is
       * NOT the footer's: looking for it only inside the footer scope found
       * nothing and the account row stayed 44px. Reached the same bounded way —
       * up from the proven tree, never above `<body>` — so a sidebar that does
       * not render one simply gets no mark.
       *
       * @param {Element | null} tree - the identified session list.
       * @returns {Element | null} the account trigger, or null.
       */
      const accountMenuFor = (tree) => {
        if (tree == null) return null
        for (let node = tree.parentElement; node != null; node = node.parentElement) {
          if (node === document.body || node === document.documentElement) return null
          try {
            const found = node.querySelector(`[aria-label="${ACCOUNT_MENU_LABEL}"]`)
            if (found !== null) return found
          } catch {
            return null
          }
        }
        return null
      }

      /**
       * The nearest common ancestor of two elements, or null.
       *
       * `document` itself is refused: "everything is under <body>" is not a host,
       * and marking it would put the compaction rules on the whole page.
       *
       * @param {Element | null} a - one element.
       * @param {Element | null} b - the other.
       * @returns {Element | null} the shared ancestor.
       */
      const closestCommonAncestor = (a, b) => {
        if (a == null || b == null) return null
        const above = new Set()
        for (let node = a; node != null; node = node.parentElement) above.add(node)
        for (let node = b; node != null; node = node.parentElement) {
          if (!above.has(node)) continue
          if (node === document.body || node === document.documentElement) return null
          return node
        }
        return null
      }

      /**
       * The pinned-count entry inside the already-proven footer host.
       *
       * By its own stable `aria-label` first, then by the visible text as a
       * fallback. The label is the stronger of the two anchors and the text is
       * what the old version used alone — and on the live page the text alone
       * matched nothing, because the entry's own label is 已置顶的会话 and the
       * text sits on a child. Text is kept only as the second try so a host that
       * ships the shorter label still compacts; neither path can reach outside
       * the one footer host derived from two proven regions.
       *
       * @param {Element} root - the proven footer host.
       * @returns {Element | null} the entry, or null when there is none.
       */
      const pinnedFooterEntryFor = (root) => {
        try {
          const labelled = root.querySelector(`[aria-label="${FOOTER_PIN_LABEL}"]`)
          if (labelled !== null) return labelled
        } catch {
          return null
        }
        return deepestTextMatch(root, FOOTER_PIN_TEXT)
      }

      /**
       * The DEEPEST element under `root` whose own text starts with `text`.
       *
       * Deepest is the load-bearing half: both the wrapper and the control
       * inside it carry the label, and only the control is the row. Bounded to
       * the ONE footer host already derived from two proven regions.
       *
       * @param {Element} root - the container to search.
       * @param {string} text - the label the entry starts with.
       * @returns {Element | null} the element, or null when nothing matches.
       */
      const deepestTextMatch = (root, text) => {
        let found = null
        try {
          for (const node of root.querySelectorAll('*')) {
            const own = typeof node.textContent === 'string' ? node.textContent.trim() : ''
            if (own === '' || (own !== text && own.startsWith(text) === false)) continue
            found = node
          }
        } catch (error) {
          warn(`footer entry unreadable: ${describeError(error)}`)
          return null
        }
        return found
      }

      /**
       * The footer surfaces this mount currently marks, so a pass that changes
       * nothing writes nothing.
       */
      const footerMarks = {
        host: null, balance: null, importer: null, pinned: null, account: null,
      }

      /**
       * Mark the four footer surfaces the compaction rules may reach — or give
       * them all back.
       *
       * Identification is POSITIVE and derived, never searched for by guessing:
       *
       *   1. the balance region and the import control are found by their own
       *      stable `aria-label`s, INSIDE the sidebar root this plugin already
       *      proved from the session list;
       *   2. the footer host is their nearest common ancestor — so it is a host,
       *      not a candidate, and a sidebar whose footer renders nothing simply
       *      has no common ancestor to claim;
       *   3. the pinned-count entry is the deepest text match inside that host;
       *   4. the account menu is found by its own `aria-label` in the same root.
       *
       * The rail is left to the host, exactly as the panels and directory regions
       * are. Nothing is hidden and no business handler is touched: these markers
       * exist only to give the stylesheet four proven anchors.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {Element | null} tree - the identified session list.
       */
      const reconcileFooter = (flavor, tree) => {
        let next = { host: null, balance: null, importer: null, pinned: null, account: null }
        const root = flavor === FLAVOR_OFFICIAL ? footerScopeFor(tree) : null
        if (root !== null && sidebarRailIn(root) === false) {
          let balance = null
          let importer = null
          let account = null
          try {
            balance = root.querySelector(`[role="region"][aria-label="${BALANCE_REGION_LABEL}"]`)
            importer = root.querySelector(`[aria-label="${IMPORT_CONTROL_LABEL}"]`)
            account = accountMenuFor(tree)
          } catch (error) {
            warn(`footer surfaces unreadable: ${describeError(error)}`)
          }
          const host = closestCommonAncestor(balance, importer)
          if (host !== null) {
            next.host = host
            next.balance = balance
            next.importer = importer
            next.pinned = pinnedFooterEntryFor(host)
            next.account = account
          }
        }
        const same = footerMarks.host === next.host
          && footerMarks.balance === next.balance
          && footerMarks.importer === next.importer
          && footerMarks.pinned === next.pinned
          && footerMarks.account === next.account
        if (same) return
        clearHostMarks()
        markHost(next.host, FOOTER_ATTR)
        markHost(next.balance, FOOTER_BALANCE_ATTR)
        markHost(next.importer, FOOTER_IMPORT_ATTR)
        markHost(next.pinned, FOOTER_PIN_ATTR)
        markHost(next.account, ACCOUNT_ATTR)
        Object.assign(footerMarks, next)
      }

      /** Hand every footer mark back, whatever it was on. Idempotent. */
      const clearFooter = () => {
        if (footerMarks.host === null
          && footerMarks.balance === null
          && footerMarks.importer === null
          && footerMarks.pinned === null
          && footerMarks.account === null) return
        clearHostMarks()
        Object.assign(footerMarks, { host: null, balance: null, importer: null, pinned: null, account: null })
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
            // Same contract for the typography marker: nothing is proven, so
            // nothing stays marked.
            markTypography(null)
            // The memo AND the row index describe DOM that no longer exists, so
            // they MUST go with the nodes they described. Left in place they
            // described an empty region: the next sidebar to appear found an
            // identical projection, `renderRegion` returned early on the
            // signature, and the region stayed permanently blank — a session the
            // user had pinned, with its header and rows, simply never came back.
            clearRegion()
            renderedRegionSignature = null
            clearPanels()
            clearDirectoryRegion()
            clearFooter()
            clearHostRowColors()
            applyPinRules(dynamicSheet, null, [])
            headCache.clear()
            foldSignature.clear()
            return
          }
          const pinned = [...pinSet()]
          ensureHosts()
          // The tree is proven and its host is mounted, so it — and only it —
          // is the one element the host-typography rules are allowed to reach.
          markTypography(tree)
          // Before the sheet is written: the panels fold lives in it, and this
          // is where the user's remembered state is read (once).
          reconcilePanels(flavor, tree)
          reconcileDirectoryRegion(flavor, tree)
          reconcileFooter(flavor, tree)
          applyPinRules(dynamicSheet, flavor, pinned, panels.collapsed === true, directory.collapsed === true)
          renderRegion()
          // After the region is placed, so a colour chosen for a PINNED session
          // lands on the host row it is hiding and on ours at the same pass.
          reconcileHostRowColors(flavor)
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
       * Behavior 3/4's fold rule: a foldable directory is CLOSED once when it is
       * first seen (the spec's "原工作区目录默认折叠"), a group holding a pinned
       * session folds on every pin change, and a group that has lost its last pin
       * expands again so the returning session is visible where it went.
       *
       * Four rules make that rule survivable, each of which was a separate
       * measured failure:
       *
       *  1. THE SIGNATURE IS THE SET OF PINNED MEMBERS. The previous signature
       *     was a positional bitmap of the group's whole session list, so
       *     re-ordering two sessions — or adding one that is not pinned at all —
       *     read as a pin change and re-folded a group the user had opened by
       *     hand (`GROUP_ORDER_ONLY_CHANGE`). A sorted member set is invariant
       *     under exactly those operations and nothing else.
       *  2. FIRST SIGHT IS AN INITIALIZATION, NOT A PIN DECISION. It is its own
       *     state (`initial`), it targets CLOSED whatever the pin set says, and
       *     it ends the moment the group is read closed — a target that flipped
       *     to "expand" the pass after the click was issued would wait for the
       *     fold to land and then open the group right behind it.
       *  3. AFTERWARDS THE GROUP IS THE USER'S. A group the user opens by hand
       *     is booked as reached and no notification, title change, reorder or
       *     unrelated pin re-closes it. That is the defect the withdrawn
       *     "first sight with no pin touches nothing" rule was protecting
       *     (`GROUP_ZERO_PINS_INITIAL` turned a long-standing `false` into
       *     `true`), and it survives the new default by becoming a handover
       *     rather than a first-sight exemption.
       *  4. NOTHING IS BOOKED BEFORE IT HAPPENED. The previous code recorded the
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
            state = { confirmed: null, initial: true, tried: false, intent: null }
            foldSignature.set(key, state)
          }
          // The one-time initialization targets CLOSED whatever the pin set
          // says. Only once that has been read back does the pin rule below
          // take over the group.
          let wantExpanded = state.initial ? false : signature === ''
          if (state.initial !== true && state.confirmed === signature) continue
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
            const spent = state.intent
            state.intent = null
            const expandedNow = now === 'true'
            // HANDOVER. The initialization has been asked for, and the group is
            // EXPANDED with no pin: the user's own opening is now the state to
            // respect. Clicking here would re-close a group the user opened,
            // on every notification, for the rest of the session.
            if (state.initial === true && state.tried === true
              && expandedNow === true && signature === '') {
              state.initial = false
              state.confirmed = signature
              continue
            }
            if (expandedNow === wantExpanded) {
              // Reached. Book it, and let go of the intent: from here on an
              // ordinary notification for the SAME signature must not re-issue
              // it. Reading the group closed ends the initialization too — from
              // now on only a pin change may move it.
              //
              // Booked against the signature the click was ISSUED against: a pin
              // that came and went while it was in flight is still unanswered,
              // and booking the later one would leave the group where the click
              // put it with no record that anything was owed.
              state.confirmed = spent === null ? signature : spent.signature
              state.initial = false
              if (state.confirmed === signature) continue
              // The pin set really did move. Ask that question NOW: deferring it
              // to the next notification would leave the group folded until
              // something unrelated happened to arrive.
              wantExpanded = signature === ''
              if (expandedNow === wantExpanded) {
                state.confirmed = signature
                continue
              }
            }
            if (state.intent === null) {
              if (state.initial === true) state.tried = true
              state.intent = { wantExpanded, signature, before: now, attempts: 1, undelivered: 0 }
            }
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
        return node.closest?.('[data-stp-region], [data-stp-anchor], [data-stp-notice], [data-stp-color-dialog]') != null
      }

      /**
       * Is this mutation record something the plugin did to itself?
       * @param {any} record - one MutationRecord.
       * @returns {boolean} true for plugin-owned edits.
       */
      const isOwnMutation = (record) => {
        if (record === undefined || record === null) return false
        // The attributes this plugin writes onto host nodes. Without these the
        // plugin's own `data-stp-panels` / `id` writes would come back through
        // the observer as host news and schedule a pass that writes them again.
        if (record.type === 'attributes'
          && (record.attributeName === PANELS_STATE_ATTR
            || record.attributeName === GROUPS_STATE_ATTR
            || record.attributeName === GROUPS_BODY_ATTR
            || record.attributeName === 'id')
          && record.target instanceof Element) return true
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
      const COLOR_ENTRY_ID = 'dsh-session-top.row-color'
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
          return ids.has(PIN_ENTRY_ID) && ids.has(UNPIN_ENTRY_ID) && ids.has(COLOR_ENTRY_ID)
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

      /**
       * Run the colour action from a menu: close that menu FIRST, then open the
       * dialog one tick later.
       *
       * The order is not cosmetic. Every menu this plugin can be reached from
       * gives focus back to the row that opened it as part of closing, so a
       * dialog that focused its own field a tick earlier would have that focus
       * taken back out from under the user — and the whole surface is unusable
       * from the keyboard. Deferring past the close is the same rule the
       * right-click hand-off already uses, for the same reason.
       *
       * @param {unknown} session - the resolved session.
       * @param {(() => void) | undefined} close - the menu's own closer.
       */
      const runColorAction = (session, close) => {
        if (!alive()) return
        const id = sessionIdOfEntry(session)
        if (id === undefined) return
        try {
          close?.()
        } catch (error) {
          warn(`closing the shared menu failed: ${describeError(error)}`)
        }
        afterDispatch(() => {
          if (!alive()) return
          openColorDialog(id, openerFor(id))
        })
      }

      /**
       * The row-colour entry this plugin contributes to the owner's menu.
       *
       * Visible for EVERY session, pinned or not: a colour is a local preference
       * keyed by session id, so it is meaningless only for a session the owner
       * could not resolve — and for those the entry simply hides, as every other
       * entry here does.
       */
      const colorEntry = () => ({
        id: COLOR_ENTRY_ID,
        order: ENTRY_ORDER + 2,
        label: translate('menu.color', '自定义行背景颜色…'),
        visible: ({ session } = {}) => {
          try {
            return sessionIdOfEntry(session) !== undefined
          } catch {
            return false
          }
        },
        run: ({ session, close } = {}) => { runColorAction(session, close) },
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
          releases.push(api.register(colorEntry()))
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
        console.info('[dsh-session-top] pin/unpin/row colour published into the shared session context menu')
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

        // The colour item, on the SAME dialog the row's colour point opens. This
        // menu is the fallback for a row with nothing to borrow, so a session
        // whose colour can only be reached from here would otherwise be the one
        // session whose colour cannot be set at all.
        const colorItem = document.createElement('button')
        colorItem.type = 'button'
        colorItem.setAttribute('role', 'menuitem')
        colorItem.setAttribute('data-stp-color-item', '')
        colorItem.textContent = translate('menu.color', '自定义行背景颜色…')
        colorItem.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          closeMenu()
          if (!alive()) return
          // Deferred for the same reason as the shared entry: this menu hands
          // focus back to the row it was opened from.
          afterDispatch(() => {
            if (!alive()) return
            openColorDialog(sessionId, anchorEl)
          })
        })
        surface.appendChild(colorItem)

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
       *   2. our own region row        → serve the gesture here
       *                                    (`openOwnRowMenu`, which borrows a
       *                                    host menu only when that host's own
       *                                    menu is richer than ours)
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
        // claim is FOR is the CHOICE OF MENU: this row is a pinned session, so
        // it needs the two actions the host's own menu may not carry at all.
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

        // (4) A real host session row of a recognized sidebar.
        const x = event.clientX
        const y = event.clientY
        afterDispatch(() => {
          // The microtask is already queued by the time teardown can run, and a
          // queued microtask cannot be cancelled. What can be checked is the
          // generation it belongs to: a hand-off scheduled one instant before
          // unmount must not claim the gesture and open a menu afterwards.
          if (!alive()) return
          if (event.defaultPrevented === true) return
          // codex-ui serves its own session menu on right-click, with its own
          // actions in it. That menu is the host's and stays the host's: the
          // gesture is left alone rather than covered by a plugin menu that
          // could only ever hold this plugin's own entry.
          if (flavor.nativeContextMenu === true) return
          event.preventDefault()
          // The host's own "…" control, when the row has one. The plugin's
          // single-item menu is the fallback for a row that has none.
          if (openOfficialRowMenu(flavor, id, x, y, found.row) === true) return
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
       * DELIVERY IS NOT A CLAIM, which is why the dispatched event itself is
       * returned rather than a success flag: the only evidence that anybody took
       * the gesture is that it comes back `defaultPrevented`.
       *
       * @param {Element} target - the element to dispatch on.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       * @returns {MouseEvent | null} the dispatched event, or null when it
       *   could not be constructed or delivered at all.
       */
      const redispatchContextMenu = (target, x, y) => {
        if (typeof MouseEvent !== 'function') return null
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
          return event
        } catch (error) {
          warn(`could not re-deliver the gesture to the host row: ${describeError(error)}`)
          return null
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
       * nothing CLAIMED the gesture: no owner, no host row, and no host menu
       * of its own to serve it. That claim is read off the re-delivered event
       * one microtask later, after the whole dispatch — whoever handled it
       * (the shared owner, or codex-ui's own session-row handler,
       * lib/client.js:4617) has already called `preventDefault()`, and a gesture
       * nobody prevented is one this plugin is still free to serve.
       *
       * Note what is NOT consulted: that a host row exists. It says the plugin
       * could deliver the gesture, nothing about whether anybody took it, and
       * reading it as a claim is what made every unclaimed right-click on a
       * pinned row silently do nothing.
       *
       * @param {Element} row - a `[data-stp-row]` element.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       */
      // ------------------------------------------------- the host's row menu

      /**
       * The stock sidebar's session menu is a BUTTON menu, not a `contextmenu`
       * surface: every row carries the host's own `…` control
       * (`Rows.tsx:667-690`, shipped at
       * `ui-workspace/lib/client.js:2328-2350`) whose `onClick` flips the row's
       * `menuOpen` state and renders the host's own items — 置顶/取消置顶、重命名、
       * 分叉会话、归档会话、复制 Session ID — from the
       * `sidebar.workspaces.session.menu.item` slot, into a portalled list
       * positioned from the anchor's rect. The hand-off is therefore a CLICK on
       * that control; nothing is re-implemented, grafted or replaced. The
       * container is located by `rowActions`, the readable segment its hashed
       * CSS-module class keeps.
       */
      const ROW_ACTIONS_SELECTOR = '[class*="rowActions"]'

      /** How often the open host menu is checked so the anchor can be handed back. */
      const OFFICIAL_MENU_POLL_MS = 150
      /** A menu nobody closed must not keep one row styled forever. */
      const OFFICIAL_MENU_MAX_MS = 60000
      /** How long a folded group is given to render the row the hand-off needs. */
      const GROUP_EXPAND_TIMEOUT_MS = 1200
      const GROUP_EXPAND_POLL_MS = 50
      /** How far outside a row the pointer may be before the anchor is moved. */
      const ANCHOR_SLOP_PX = 48

      /**
       * The host's own "…" control for a row, or null when the row carries none.
       * @param {Element | null} row - a host session row.
       * @returns {Element | null} the button.
       */
      const officialRowMenuControl = (row) => {
        if (row == null) return null
        let actions = null
        try {
          actions = row.querySelector(ROW_ACTIONS_SELECTOR)
        } catch { return null }
        if (actions == null) return null
        const button = actions.querySelector('button[aria-label]') ?? actions.querySelector('button')
        return button instanceof Element ? { actions, button } : null
      }

      /** The host row's own "…" control, or null when the row carries none. */
      const officialRowMenuButton = (row) => officialRowMenuControl(row)?.button ?? null

      /**
       * Is the host's menu open on this row right now?
       *
       * `Rows.tsx` puts its own `menuOpen` class on the row while the menu is
       * open (and the stylesheet reveals `rowActions` on exactly that class), so
       * this is the observable outcome of our click — and the signal the anchor
       * transaction watches for, instead of a guess about how long a menu lives.
       * @param {Element} row - a host session row.
       * @returns {boolean} true when the row reports an open menu.
       */
      const officialMenuOpenOn = (row) =>
        typeof row?.className === 'string' && row.className.includes('menuOpen')

      /**
       * Did the gesture arrive at some OTHER row than the one it landed on?
       *
       * A real right-click always lands on the row whose menu is about to open.
       * A re-delivered one — this plugin's own row handing the gesture to the
       * host's row for the same session — lands on a row somewhere else in the
       * sidebar entirely, and the host would then open its menu hundreds of
       * pixels from the pointer. Comparing the pointer with the row's own box
       * tells the two apart without either path having to announce itself.
       * @param {Element} row - the row the gesture landed on.
       * @param {number} x - viewport x of the gesture.
       * @param {number} y - viewport y of the gesture.
       * @returns {boolean} true when the pointer is nowhere near the row.
       */
      const pointerOutsideRow = (row, x, y) => {
        let rect = null
        try {
          rect = row.getBoundingClientRect?.() ?? null
        } catch { return false }
        if (rect == null || typeof rect.left !== 'number') return false
        return x < rect.left - ANCHOR_SLOP_PX
          || x > rect.right + ANCHOR_SLOP_PX
          || y < rect.top - ANCHOR_SLOP_PX
          || y > rect.bottom + ANCHOR_SLOP_PX
      }

      /**
       * Park one row under the pointer, invisibly, and return the undo.
       *
       * The host measures the anchor's rect, so a menu opened for a row that is
       * `display:none` (which is exactly what the pin rule does to a pinned
       * session's own row) or that sits in a folded group lands at (0,0) or far
       * off from the click. Both are fixed on THIS row only, and only while its
       * menu is open:
       *
       *   - laid out (`display`) so its button has a real rect, and invisible
       *     (`opacity`) so nothing is drawn where the user is looking;
       *   - `pointer-events: none` so the invisible row cannot swallow the next
       *     click — a click that would otherwise open the session behind the
       *     menu;
       *   - `transform` moves that box onto the pointer, which is what the host
       *     then measures. It does not affect layout, so nothing around it
       *     shifts.
       *
       * The undo restores the four properties to the values they held BEFORE,
       * and only those four. A caller that wants the row left exactly as it was
       * found gets exactly that.
       *
       * @param {Element} row - the host row to move.
       * @param {Element} button - the anchor inside it.
       * @param {number} x - viewport x of the gesture.
       * @param {number} y - viewport y of the gesture.
       * @returns {() => void} the undo.
       */
      const anchorRowAtPointer = (row, actions, button, x, y) => {
        const style = row.style
        if (style == null) return () => {}
        const PROPS = ['display', 'opacity', 'pointer-events', 'transform']
        const prior = new Map()
        const applied = new Map()
        for (const prop of PROPS) {
          prior.set(prop, [style.getPropertyValue?.(prop) ?? '', style.getPropertyPriority?.(prop) ?? ''])
        }
        const set = (prop, value) => {
          try {
            style.setProperty(prop, value, 'important')
            applied.set(prop, value)
          } catch { /* nothing was written, so nothing has to be undone */ }
        }
        // Laid out so the button has a real box, invisible so nothing is drawn
        // where the user is looking, and inert so it cannot swallow the next
        // click. The transform moves that box onto the pointer — which is what
        // the host measures — without affecting layout.
        set('display', 'flex')
        set('opacity', '0')
        set('pointer-events', 'none')
        // THE ORDERING THAT MAKES THIS WORK. `.rowActions` is `display: none`
        // until the row is hovered or its menu is open (Rows.module.css:256-269),
        // so the button's box is 0×0 at this point and measuring it would place
        // the row at the pointer's coordinates OFFSET FROM THE ORIGIN — a menu
        // that opens at the bottom of the screen. The container is put on screen
        // first, and only then measured; the host's own `menuOpen` class takes
        // over keeping it visible until the row is handed back.
        //
        // `actionsPrior` is captured here rather than with the row's own props
        // because this is the HOST's element: its `display` is given back by the
        // same compare-and-restore rule, not by an unconditional remove.
        let actionsPrior = null
        try {
          if (actions?.style != null) {
            actionsPrior = [
              actions.style.getPropertyValue?.('display') ?? '',
              actions.style.getPropertyPriority?.('display') ?? '',
            ]
            actions.style.setProperty('display', 'inline-flex', 'important')
          }
        } catch { /* the measurement below falls back to the row's own box */ }
        let rect = null
        try {
          rect = button.getBoundingClientRect()
        } catch { rect = null }
        if (rect != null && typeof rect.left === 'number' && (rect.width > 0 || rect.height > 0)) {
          const dx = Math.round(x - (rect.left + rect.width / 2))
          const dy = Math.round(y - (rect.top + rect.height / 2))
          set('transform', `translate(${dx}px, ${dy}px)`)
        }
        return () => {
          for (const prop of PROPS) {
            // Only undo a property that still carries OUR value. Someone who
            // wrote this inline style in the meantime owns it now.
            let current = null
            try {
              current = style.getPropertyValue?.(prop) ?? ''
            } catch { continue }
            if (current !== applied.get(prop)) continue
            const [value, priority] = prior.get(prop)
            try {
              if (value === '') style.removeProperty(prop)
              else style.setProperty(prop, value, priority)
            } catch (error) {
              warn(`could not hand the anchor style ${prop} back: ${describeError(error)}`)
            }
          }
          const container = actions?.style
          if (container != null && actionsPrior !== null) {
            try {
              if ((container.getPropertyValue?.('display') ?? '') === 'inline-flex') {
                if (actionsPrior[0] === '') container.removeProperty('display')
                else container.setProperty('display', actionsPrior[0], actionsPrior[1])
              }
            } catch (error) {
              warn(`could not hand the anchor container's display back: ${describeError(error)}`)
            }
          }
        }
      }

      /**
       * The ONE temporary-anchor transaction.
       *
       * A second right-click, the menu closing, an unmount and teardown all
       * release through this single holder, so there is never more than one
       * styled row and never a second timer set to restore it. Its timers go
       * through `ownTimer`, so teardown's drain covers them even if a release
       * is missed.
       * @type {{row: Element, restore: (() => void) | null, refold: (() => void) | null, watch: unknown, settle: unknown} | null}
       */
      let officialAnchor = null

      /** Release the transaction, if any. Safe to call from anywhere, repeatedly. */
      const restoreOfficialAnchor = () => {
        const tx = officialAnchor
        if (tx === null) return
        officialAnchor = null
        releaseTimer(tx.watch)
        releaseTimer(tx.settle)
        tx.watch = null
        tx.settle = null
        try {
          tx.restore?.()
        } catch (error) {
          warn(`could not hand the anchor row back: ${describeError(error)}`)
        }
        try {
          tx.refold?.()
        } catch (error) {
          warn(`could not re-fold the expanded group: ${describeError(error)}`)
        }
      }

      /** Watch for the host menu closing, then hand the row back. */
      const watchOfficialMenu = (tx) => {
        const poll = () => {
          if (!alive() || officialAnchor !== tx) return
          const closed = tx.row.isConnected !== true || officialMenuOpenOn(tx.row) !== true
          if (closed === true || Date.now() - tx.openedAt >= OFFICIAL_MENU_MAX_MS) {
            restoreOfficialAnchor()
            return
          }
          tx.watch = ownTimer(setTimeout(poll, OFFICIAL_MENU_POLL_MS))
        }
        tx.watch = ownTimer(setTimeout(poll, OFFICIAL_MENU_POLL_MS))
      }

      /**
       * Re-check the anchor shortly after a gesture that would close the host
       * menu (a pointerdown, Escape, blur, resize). The host's own close lands
       * inside the same dispatch, so the check is armed after it — restoring
       * first would move the anchor out from under a menu that is still open,
       * and the host re-measures its position every frame while it is.
       */
      const scheduleOfficialSettle = () => {
        const tx = officialAnchor
        if (tx === null || tx.settle !== null) return
        const check = () => {
          tx.settle = null
          if (!alive() || officialAnchor !== tx) return
          if (tx.row.isConnected !== true || officialMenuOpenOn(tx.row) !== true) restoreOfficialAnchor()
        }
        tx.settle = ownTimer(setTimeout(check, 0))
      }

      /**
       * Open the HOST's own menu for a session, wherever its row lives.
       *
       * `hostRow` is passed when the caller already has the row. When there is
       * none, the owning group is expanded through its own header toggle — the
       * same path the pin fold uses — and this returns having CLAIMED the
       * gesture; the row arrives a moment later.
       *
       * @param {object | null} flavor - the detected sidebar.
       * @param {string} id - the session.
       * @param {number} x - viewport x of the gesture.
       * @param {number} y - viewport y of the gesture.
       * @param {Element | null} hostRow - the row, when it is already mounted.
       * @returns {boolean} true when the gesture is claimed (the host menu is
       *   opening, or is about to); false when the caller should fall back.
       */
      const openOfficialRowMenu = (flavor, id, x, y, hostRow) => {
        if (!alive()) return false
        if (flavor !== FLAVOR_OFFICIAL) return false
        const row = hostRow ?? hostRowFor(flavor, id)
        if (row === null) return expandGroupForSession(flavor, id, x, y)
        const control = officialRowMenuControl(row)
        if (control === null) return false

        // One transaction at a time: a second gesture releases the first, and a
        // release puts back both the styled row and any group opened for it.
        restoreOfficialAnchor()
        const tx = { row, restore: null, refold: null, watch: null, settle: null, openedAt: Date.now() }
        if (pointerOutsideRow(row, x, y) === true) {
          tx.restore = anchorRowAtPointer(row, control.actions, control.button, x, y)
        }
        officialAnchor = tx
        try {
          control.button.click()
        } catch (error) {
          warn(`could not open the host's session menu: ${describeError(error)}`)
          restoreOfficialAnchor()
          return false
        }
        watchOfficialMenu(tx)
        return true
      }

      /**
       * The workspace a session belongs to, or null when the store does not say.
       * @param {string} id - the session.
       * @returns {string | null} the workspace key.
       */
      const groupKeyForSession = (id) => {
        for (const item of workspaceItems()) {
          if (item.sessionIds.includes(id) === true) return item.workspaceId
        }
        return null
      }

      /**
       * Make a row exist for a session whose group is folded.
       *
       * The host renders NO session rows for a folded group
       * (`WorkspaceBrowser.tsx:484`), so for a PINNED session — whose group the
       * pin rule folds — the row a right-click must borrow is usually not in the
       * document. Expansion goes through the group's own header click, once, for
       * that group alone, and only when it is actually folded.
       *
       * The WAIT is part of the same transaction as the anchor: it is what holds
       * the group open, so teardown and a second right-click release it through
       * `restoreOfficialAnchor` and the group goes back exactly as it was found.
       * A group this did not open is never closed.
       *
       * @returns {boolean} true — the gesture is claimed; false when the caller
       *   should fall back to the plugin's own menu.
       */
      const expandGroupForSession = (flavor, id, x, y) => {
        if (!alive()) return false
        const key = groupKeyForSession(id)
        if (key === null) return false
        const header = groupHeader(flavor, key)
        if (header === null) return false
        if (header.getAttribute('aria-expanded') === 'true') return false

        restoreOfficialAnchor()
        const openedByUs = toggleGroupHeader(header, key)
        const tx = { row: header, restore: null, refold: null, watch: null, settle: null, openedAt: Date.now() }
        if (openedByUs === true) {
          tx.refold = () => {
            if (header.isConnected !== true) return
            if (header.getAttribute('aria-expanded') !== 'true') return
            toggleGroupHeader(header, key)
          }
        }
        officialAnchor = tx

        const deadline = Date.now() + GROUP_EXPAND_TIMEOUT_MS
        const wait = () => {
          tx.watch = null
          if (!alive() || officialAnchor !== tx) return
          const row = hostRowFor(flavor, id)
          if (row !== null) {
            const refold = tx.refold
            officialAnchor = null
            if (openOfficialRowMenu(flavor, id, x, y, row) === true) {
              officialAnchor.refold = refold
            } else {
              refold?.()
              openMenu(id, x, y)
            }
            return
          }
          if (Date.now() >= deadline) {
            // No row, no menu: put the group back and leave the user the pin
            // fallback rather than an expansion with nothing in it.
            restoreOfficialAnchor()
            openMenu(id, x, y)
            return
          }
          tx.watch = ownTimer(setTimeout(wait, GROUP_EXPAND_POLL_MS))
        }
        tx.watch = ownTimer(setTimeout(wait, GROUP_EXPAND_POLL_MS))
        return true
      }

      /**
       * Open the menu for one of the plugin's own region rows.
       *
       * THE HAND-OFF IS TAKEN UNLESS SOMETHING STRONGER IS SERVING.
       *
       * Borrowing the host's menu is only worth doing when the host's menu
       * actually offers what this row has to offer. On the stock sidebar it
       * does — its row menu IS the `sidebar.workspaces.session.menu.item` list,
       * which carries the host's own `pin` row with this plugin's colour item
       * registered beside it. On codex-ui it does not, and the reason is worth
       * stating exactly because it is NOT the whole answer:
       *
       *   - codex-ui registers its own `sidebar.workspaces` entry at
       *     `priority: -1` and therefore WINS that `single` slot against the
       *     stock `WorkspaceBrowser` (`entriesOfSlot` returns only the first
       *     live entry per cell). The stock browser never mounts, so the stock
       *     `sidebar.workspaces.session.menu.item` list — and the colour item
       *     this plugin registers into that same list — has no renderer at all.
       *   - codex-ui's own row menu is built inline by `sessionMenuItems()`
       *     (lib/client.js:1757-1836) and handed to `SessionRow` as a prop. It
       *     reaches no extension table, no `Symbol.for` key and no slot, and it
       *     carries rename / unread / archive / fork / openPath / moveWorkspace
       *     / copyId / copyTitle / copyPath — and, where the registry allows it,
       *     delete. No pin, no unpin, no row colour, and no supported way in.
       *
       * So with nothing else listening, forwarding on that host buys a menu
       * with nothing in it that a PINNED row needs, while this plugin's own
       * menu holds exactly Unpin and the row colour. That is the case the
       * short-circuit below is for.
       *
       * IT IS NOT THE CASE WHEN THE SHARED OWNER IS INSTALLED, which is the
       * case that made the previous revision wrong. That owner
       * (`@baihejiangnan/dsh-session-context-menu`) does not use the slot list
       * at all: it builds its own `.dshcm-menu` from scratch and reads our
       * entries out of `Symbol.for('dsh.session-context-menu.extensions')`. Its
       * menu therefore carries the host actions codex's inline menu does have
       * AND the Unpin and colour rows this plugin registers into it — strictly
       * more than either of the two alternatives, on the same host. Short-
       * circuiting while it is there would take all of that away from a pinned
       * row, which is why the guard also asks whether the owner is present.
       *
       * The host's own ordinary rows are untouched either way: they keep their
       * native menu, observed but never claimed, because claiming one would
       * take away eight working actions this plugin cannot replace.
       *
       * @param {Element} row - a `[data-stp-row]` element.
       * @param {number} x - viewport x.
       * @param {number} y - viewport y.
       */
      const openOwnRowMenu = (row, x, y) => {
        const id = ownRowId(row)
        if (id === undefined) return
        const flavor = currentFlavor(Date.now())
        // A codex host's own row menu provably cannot carry Unpin or a row
        // colour, so on that flavor our own menu beats it — but ONLY while
        // nobody richer is going to build one. The shared owner builds its own
        // menu outside this flavor's slot and carries our two actions plus the
        // host's, so its presence is exactly the condition that makes
        // forwarding the better answer again.
        const ownerPresent = sharedMenuRegistered(sharedMenuApi())
        if (flavor !== null && flavor.nativeContextMenu === true && ownerPresent === false) {
          openMenu(id, x, y)
          return
        }
        const hostRow = hostRowFor(flavor, id)
        if (hostRow !== null) {
          publishSharedMenu()
          const forwarded = redispatchContextMenu(hostRow, x, y)
          if (forwarded !== null) {
            // codex only. The stock sidebar's own "…" menu is served by our
            // ordinary handler, which sees this same re-delivered event and
            // decides about it one microtask later; giving it a second path to
            // open a menu would put two of them on one gesture. What codex
            // leaves open is whether its OWN session-row handler claimed the
            // gesture — lib/client.js:4617, a synchronous `preventDefault` —
            // and the whole dispatch has finished by the time this reads that.
            if (flavor.nativeContextMenu === true) {
              afterDispatch(() => {
                if (!alive()) return
                if (forwarded.defaultPrevented === true) return
                openMenu(id, x, y)
              })
            }
            return
          }
        }
        // No re-delivery at all: no `MouseEvent` to build one with, or the host
        // row refused it. Nothing was served and nothing could be, so there is
        // no host menu to leave alone and no reason to drop the gesture — the
        // upstream suppression has already taken the browser's own menu out of
        // it. The host's "…" menu is tried first, exactly as on any other row.
        if (openOfficialRowMenu(flavor, id, x, y, hostRow) === true) return
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

        // And the stock sidebar's own session-row menu, for the same reason and
        // at the same time. It is called HERE, not next to the code that defines
        // it, for the only reason that matters: registering an entry can make the
        // host render it synchronously, and a render that reaches
        // `openColorDialog` before this mount's own `const` bindings exist is a
        // TDZ ReferenceError inside somebody else's render.
        registerOfficialColorMenu()

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
          // The host's own menu closes on exactly these gestures, so they are
          // also when the borrowed anchor row must be handed back.
          scheduleOfficialSettle()
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
        // Paired through the SAME disposer list the subscriptions use, so
        // teardown cannot leave a `storage` listener behind that keeps
        // repainting rows for a generation that no longer exists.
        window.addEventListener('storage', onRowColorsStorage)
        disposers.push(() => { window.removeEventListener('storage', onRowColorsStorage) })

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
        + `, sessions ${sessionsService() === undefined ? 'absent' : 'ok'}`
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