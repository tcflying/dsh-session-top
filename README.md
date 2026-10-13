# dsh-session-top

ZCode 风格的会话列表 for DeepSeek Harness 0.2.x：会话有新活动就自动上浮，
右键会话行可以置顶/取消置顶，置顶的会话从工作区分组里抽出来显示在侧栏顶部
的「已置顶」区域，置顶状态跨重启保留。

纯插件，零核心修改。双面结构（host + client）。

---

## 行为与实现位置对照

| # | 验收标准 | 实现位置 |
|---|---|---|
| 1 | **活跃上浮**：任何 session 有新活动就排到所在列表最上 | `src/index.js` 的 `onSessionEvent` 记录活动时间 → `reorderSessions()` 通过官方 `workspace.insertSessionBefore` 把该 session 上浮到所属工作区账户顶部。算法在 `src/core.js` 的 `planFloatToTop`。 |
| 2 | **右键置顶**：右键会话行出「置顶该会话」/「取消置顶」 | `src/client.js` 的 `onContextMenu`（事件委托）+ `openMenu`（用官方 `Menu` primitive 在光标处弹出）。 |
| 3 | **置顶语义**：抽出工作区 → 侧栏顶部平铺「已置顶」区，原分组默认折叠，分组内不重复显示 | `src/client.js` 的 `renderRegion`（平铺渲染）+ `applyPinRules`（样式表规则隐藏分组内的原行）+ `reconcileGroups` / `setGroupExpanded`（折叠分组）。 |
| 4 | **取消置顶**：回到原工作区分组内按活跃度的位置，「已置顶」区移除 | 同一套 `reconcile`：pin 规则为空 → 分组内的行由样式表自动恢复显示；`reconcileGroups` 把分组重新展开。 |
| 5 | **持久化**：置顶状态跨重启保留 | 置顶集合直接用宿主已有的 registry 全局 pin 集（`workspaceRegistry.pinnedSessionIds`），经官方 `workspaces.pinSession` / `unpinSession` RPC 写入。宿主自己落盘，插件不存第二份。 |

---

## 设计要点

### 为什么置顶状态不自己存

置顶集合用宿主已有的 `pinnedSessionIds`（官方侧栏的图钉按钮写的就是它）。
它本来就是持久化的，跨重启自动保留 —— 行为 5 由「复用官方存储」满足，
而不是插件自己再写一份文件。

自己存会带来一个真实风险：用户在别处（比如官方图钉按钮）取消了置顶，
插件那份副本不会跟着更新，两边不一致后界面上会出现「以为置顶了其实没有」
的幽灵状态。

插件自己的状态目录 `$DSH_HOME/dsh-session-top/` 只放**活动日志**
（`activity.log`，纯调试用）和诊断数据。删掉它只会让本次进程外从未运行过的
会话少一层排序精度，置顶状态不受影响。

### 为什么行为 1 要在 host 侧改持久顺序

官方侧栏默认视图（`orderBy: 'updated'`）本来就每帧按 `summary.updatedAt`
排序，所以「看起来上浮」是免费的。但工作区的**持久**账户顺序
（`workspace.sessionIds`）只有 `insertSessionBefore` 能改。

如果只在客户端排，用户一旦把侧栏切到「手动排序」，活动就再也不影响顺序了。
在 host 侧把持久账户本身也上浮，两个视图就一致 —— 而且重启后还在。

重排串在一条 Promise 链上：手动拖拽和这个 pass 写的是同一个账户，交错执行
会打架。

### 上浮只动一个 session，不重排整个账户

`planFloatToTop` 只把「刚活动过的那个 session」移到账户顶部，**其余 session
保持相对位置不变**。

这是刻意的。全量按活动重排会静默毁掉用户拖拽排出来的顺序 —— 拖拽顺序本身
是持久化状态，一个后台活动事件没有资格把它冲掉。「活跃上浮」的字面含义就是
上浮：动的只有它自己。

`test/core.test.js` 里 `planFloatToTop preserves the relative order of the rest`
就是守这一条。

### 为什么没有挂 slot（有意为之）

官方侧栏**已经自带**置顶：`sidebar.workspaces.session.menu.item` 里 order 100
的置顶行，写的是同一个 Host pin 集。再注册一条就是同一个动作出现两次。

而规格要的两块表面都没有 slot 可占：

- 行「...」菜单是按钮菜单，不是 `contextmenu` 入口；
- 「已置顶」区域不是官方 slot map 声明的洞 —— `sidebar.workspaces` 是
  `single` slot，已经被官方 browser 占了；挂到 `sidebar.footer.action`
  会把「已置顶」放到侧栏**底部**而不是顶部。

所以这里 DOM 层是正确工具，代码里把每一处 DOM 操作都收窄并加了守卫。

### 两个容易踩的官方实现细节

写这个插件时踩到两个不看源码就想不到的点，都已在代码注释里标明：

1. **`AnimatedRows.readPositions()` 会读列表内所有 `[data-row-key]`。**
   如果「已置顶」区域的行带着同样的 `session:<id>` key 插在列表**内部**，
   它会被当成「刚消失的行」，克隆进退出遮罩做淡出动画 —— 区域会在下一次
   重渲染时自己散掉。所以区域插在 `[role="tree"]` **外面**。

2. **搜索视图自己也会渲染一个 `[role="tree"]`。** 只有一个候选时无所谓；
   有多个候选时，靠「带 `session:` 行的那个」来区分。但全部工作区分组都
   折叠时列表里一条 `session:` 行都不剩，所以还留了二级回退：认
   `workspace:` 行（搜索结果行完全没有 `data-row-key`）。

---

## 两种侧栏（重要）

用户机器上真正的侧栏是 **`@michengai/dsh-codex-ui` 1.1.35**，它的
`cordis.patch.yml` 禁用了官方 `ui-sidebar`。第一版只写官方选择器，在那台机器上
一个都匹配不上 —— 症状是「boot 0 错误但界面零效果」，因为「什么都没渲染」和
「功能被禁用」看起来一模一样。

现在按**属性存在性**探测，不做类名全文匹配：

| 行为 | codex-ui（真机） | 官方 ui-sidebar 0.2.0-rc.2 |
|---|---|---|
| 会话行选择器 | `[data-dcu-session]` | `[data-row-key^="session:"]` |
| 从行取 session id | `getAttribute('data-dcu-session')`（**原始 id**，形如 `session-<uuid>`） | `getAttribute('data-row-key').slice(8)` |
| 分组表头 | `.dcu-wb-project-head[aria-expanded]`（无 id 属性，靠 `.dcu-wb-project` 的**祖先链**定位，结果缓存） | `[data-row-key^="workspace:"]`（自带 workspace key） |
| 会话列表容器 | `[role="tree"]` | `[role="tree"][aria-label]` |
| 置顶隐藏规则 | `[role='tree'] [data-dcu-session="<id>"]` | `[role='tree'] [data-row-key='session:<id>']` |
| 主题 token | `--dcu-sidebar-*` | `--dsh-*` |
| 右键菜单 | **侧栏自己开**，本插件**追加**一行置顶 | 侧栏没有 context menu，本插件自己接管 |

### 为什么 codex-ui 是「追加」不是「替换」

codex-ui 的会话行自带 `onContextMenu`，右键会打开它自己的菜单
（重命名 / 标记未读 / 归档 / 分叉 / 打开路径 / 移动），里面**没有置顶**。
直接 `preventDefault` 接管会把六个能用的操作全删掉。

所以那里**不拦截**：让侧栏照常开菜单，本插件再把一行「置顶该会话 / 取消置顶」
追加进去。它用的是官方 `Menu` primitive（`data-menu-material="translucent"`
`role="menu"`），追加的节点落在同一套标记里，主题样式自动生效。找不到菜单面
时轮询 12 次 × 40ms，仍失败就静默不动（不吞掉原有菜单）。

`test/sidebar-dom.mjs` 对两种侧栏各建一套骨架 DOM，跑真 bundle，逐条验证上表。

### token 适配

样式表只引用 `--stp-token-*`，实际值在运行时由探测到的 flavor 写成
`--stp-token-hover: var(--dcu-sidebar-hover)` 这种间接层。换主题、走 light/dark
都能跟着变。两种都没识别到时 token 全部移除，回落到样式表自带默认值。

## 服务就绪时机（装机实测踩过）

bundle 带 `immediately: true`，会在 **bootstrap 阶段**就物化。那一刻
`api-workspace-controller` 的 `workspaces` 服务还没 publish。

某一版在 `apply` 里直接读这个服务、读不到就 `return` —— 于是插件**永久沉默**：
没有区域、没有菜单追加、连日志都没有（早退把日志一起跳过了），症状就是
「boot 0 错误但界面零效果」。

现在把等待交给 cordis 自己：

```js
ctx.inject(['workspaces'], (child) => mount(child, warn))
```

`ctx.inject` 是 `ctx.plugin({ inject: deps, apply: callback })` 的简写
（`vendor/cordis/src/registry.ts:300`，方法被 mixin 到每个 Context，
见 `context.ts:31`「Its methods are mixed onto `ctx`」）。它开的是一个
**子 fiber**：本 fiber 一直是 ACTIVE，`workspaces` 一 publish 回调就跑。

所以「服务永远不来」最坏也只是子 fiber 一直 PENDING —— **不会**把 entry
拖进 LOADING，更不会让整机启动失败。`inject` 导出仍然是 `[]`，正是这个原因：
一旦在 `inject` 里写上服务名，就变成顶层依赖，服务不来 = entry PENDING =
`web boot: 1 entry did not activate`。

`dsh.client.inject`（包行顺序）保持为空：加载图边解决的是 factory 到达顺序，
解决不了「服务 publish 时刻」，而 `ctx.inject` 两者都不依赖，还不会引入
「包名写错 → 永远 loading」的风险。

### 日志（真机可诊断是验收刚需）

`console` 才是能进桌面 err.log 的通道，host logger 只是附加：

- `apply` 一进来就 `console.info('[dsh-session-top] activated; waiting for the workspaces controller service')`
- `console.info('[dsh-session-top] active (flavor codex, list pending, pin ok, sessions ok, uiWorkspace ok, pinned 0)')`
- 列表真正 ready 后再补一行 `workspace list ready — … pinned 2`：`pinnedSessionIds`
  在 `phase: pending/loading` 期间本来就是空的，挂载那一刻打出来的 `pinned 0`
  说明不了任何置顶状态
- 20s 还没等到 → `console.warn('[dsh-session-top] workspace controller still unpublished after 20s; …')`
- 任何降级路径各自 `console.warn`，写明原因

真机上按这三行就能判断卡在哪一步。

## 样式注入：不碰 CSSOM

某一版用 `while (sheet.cssRules.length > 0) sheet.deleteRule(0)` 清空、然后
`sheet.insertRule(...)` 重写。在真机上 `insertRule` 抛 DOMException
（`pin rule injection failed: [object DOMException]`），而**循环已经把静态规则
全删了** —— 一次失败留下空样式表，区域完全没有样式。

现在改成两个独立 `<style>` 元素，全部走 `textContent`：

- `data-stp-sheet="static"` —— 区域/行外观，只写一次
- `data-stp-sheet="dynamic"` —— 每轮 reconcile 重写整段 pin 规则

`textContent` 赋值失败会保留旧值，不会出现「先删光再失败」。日志也改成
`err.name + ': ' + err.message`，不再打 `[object DOMException]`。

`test/core.test.js` 里有一条静态拦截：源码里出现 `insertRule` / `deleteRule` /
`cssRules` 就失败。

## 右键：codex-ui 分支只观察，不碰事件

真机上 codex-ui 的行菜单**不再打开**（`[role=menu]` count=0）。React 是把监听
挂在 **root 容器**上的（委托），所以只要事件在 document 捕获阶段被打断
（`stopPropagation` 之类），React 根本收不到，菜单永远不开。

现在 codex 分支在 `return` 之前**完全不碰 `event`** —— 不 preventDefault、
不 stopPropagation、不 stopImmediatePropagation，事件原样放行，插件只是观察。

追加逻辑也收紧了：只碰**右键之后才出现**的菜单面。右键之前就已经开着的菜单
（设置弹层、侧栏导航）属于别人，往别人的 React 菜单里塞外来节点正是「把宿主
搞坏」的典型方式。

`test/sidebar-dom.mjs` 用一个挂在 tree 上的哨兵监听器模拟 React root，
断言事件仍然能到达它；`test/core.test.js` 另有一条静态拦截：own-menu 分支之前
出现任何事件中断调用就失败（这条第一版只检查 `if` 分支内部，会漏掉「放在
分支上面」的中断，我实测复现后才补上）。

## flavor 必须惰性探测（装机实测踩过两次）

真机日志打的是 `flavor none`，而同一时刻 DOM 里有 18 个 `[data-dcu-session]`。
两个原因，都已修：

1. **一次性定终身**。原来的 `detectFlavor` 在 mount 跑一次就定下来，而侧栏
   比插件晚渲染，于是永远 `none`。现在 `currentFlavor(now)` 每次现查，只做
   250ms 的短记忆（避免每次指针/每次 reconcile 都全文档查询）；每次 reconcile
   先 `invalidateFlavor()` 再查，flavor 变化时打一行
   `[dsh-session-top] sidebar flavor: codex` 并继续重排。日志里的 flavor 也改成
   惰性读取，不再是 mount 时的快照。

2. **自己的区域行冒充宿主侧栏**。`makeRow` 之前给每行都带
   `data-row-key="session:<id>"` 和 `data-dcu-session`。于是 codex-ui 自己的行
   一旦没挂载（分组全折叠、搜索视图、渲染中途），这两个标记还在 →
   `detectFlavor` 判成**官方** flavor → 右键走 own 分支 → `stopPropagation`
   → codex 菜单死。区域行现在**不带任何 flavor 标记**，只用
   `data-stp-row` + `data-stp-session`，并且在 flavor 探测**之前**先匹配自己
   的行。

## 右键：事件归属规则

全插件只有两处可以中断事件，写在同一处并逐条列明前置条件：

| # | 条件 | 行为 | 是否碰 event |
|---|---|---|---|
| 1 | `closest('[data-stp-row]')` 命中 | 开自己的菜单 | **是**（自有行，没有宿主菜单竞争） |
| 2 | `flavor === null` | **只观察** | 否 |
| 3 | `flavor.nativeContextMenu`（codex） | 只观察 + 往宿主菜单追加一行 | 否 |
| 4 | 明确是官方 flavor | 开自己的菜单 | **是**（官方侧栏没有 context menu） |

React 把监听挂在 **root 容器**上，所以捕获阶段任何中断都会让宿主菜单永远
打不开 —— codex-ui 的行菜单因此死过两次。现在「不认识 = 只观察」，不做任何
事件修改、不开自己的菜单、不追加。

`test/sidebar-dom.mjs` 用挂在 tree 上的哨兵监听器模拟 React root，断言事件
仍然能到达；另有三条行为测试：flavor none 完全不干预、区域行不带宿主标记、
以及**侧栏晚于插件渲染**时能被正确识别为 codex 并追加（这三条我都注入回归
验证过会失败）。

## 降级契约

官方结构变了不能崩，这是硬约束。每处 DOM 依赖都有对应的静默降级路径：

| 依赖的官方结构 | 结构变了会怎样 |
|---|---|
| codex `[data-dcu-session]` / 官方 `[data-row-key^="session:"]` | 两种都找不到 → flavor 为 null → 区域 detach、隐藏规则清空、右键不响应 |
| `[role="tree"]` | 找不到列表 → 同上，完全静默降级 |
| `.dcu-wb-project-head[aria-expanded]` | 找不到表头 → 不折叠，分组保持侧栏原样 |
| `data-row-key^="workspace:"`（官方） | 同上 |
| `[data-menu-material][role="menu"]` | 找不到菜单面 → 右键时侧栏菜单照常开，只是没有置顶行 |
| `workspaces.pinSession/unpinSession` | 缺 RPC → 不置顶，只警告一次 |
| `uiWorkspace.openSession` | 缺失 → 回退到 `sessions.retain` |

`client.js` 里所有 DOM/React 调用都在 try/catch 内，失败只 `warn` 一次，
**绝不把异常抛进侧栏的渲染链**。`inject` 是空数组：把任何服务写进 inject，
在缺该服务的老 baseline 上会让 entry 永远 `pending`，而 pending entry 会让
整个客户端启动失败 —— 这个插件绝不能有能力阻止应用启动。

---

## 安装

主代理执行（插件自身不碰 `D:\dsh-home` 下任何文件）：

```bash
# 1. 链进 profile 并加入 bundles
dsh plugin --profile desktop add link:D:\mmx-project\dsh官方\dsh-plugins\dsh-session-top

# 2. 确认 bundles 里出现 dsh-session-top
#    profile 的 package.json → dsh.profile.bundles

# 3. 重启应用
```

`cordis.patch.yml` 里的 insert id 是 `session-top`，name 是包名
`dsh-session-top`。

### peer 版本范围（重要）

`package.json` 只声明了 `@deepseek-ai/cordis: ">=4.0.4 <5"`，
**没有**声明任何 `@deepseek-ai/*` 包。

这是刻意的。那台机器反复启动失败的已知原因，就是旧插件把 peer 写成
`<0.2.0` 之类的上界，pnpm 于是把 0.2.x 的真包遮住、装一份旧包进去。
本插件直接复用宿主的官方服务，一个包都不额外声明，物理上不可能造成这种
遮蔽。`test/core.test.js` 里有一条断言专门守着这件事：任何
`@deepseek-ai/*` 的 peer 范围里出现 `<0.2.0` 就让测试失败。

### `dsh.client.inject` 必须是空（重要，装机实测踩过）

`dsh.client.inject` 里每一项都必须是一个**在 profile 里能解析到的真实包行**。
写了不存在的包名，该行永远等不到 factory，fiber 卡在 `FiberState.LOADING`，
最后报 `web boot: 1 entry did not activate`。

desktop profile 的 `node_modules` 下**根本没有 `@deepseek-ai` 这个 scope**
（官方包由 bundle 提供，不作为 profile 依赖安装），所以
`@deepseek-ai/dsh-client-ui-sidebar` 之类全部解析不到。本插件最初的版本就
是死在这里的。

现在 `dsh.client.inject` 是空的，这是**必需**的：bundle 只 require
`react` / `react-dom/client` / `@deepseek-ai/dsh-client-ui-primitives`，
三者都在 `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`
种子表里，由 `ClientModuleSystem` 直接从 `staticModules` 取
（`system.ts:321` 的 `this.seed.has(spec)` 分支），**不需要任何
graph 行或 inject 边**。

数据服务（`workspaces` / `sessions` / `uiWorkspace` / `locale`）走的是
cordis Context，名字在 `src/client.js` 里用 `ctx.<name>` 读，全部做了
判空降级；bundle 的 `inject` 导出保持 `[]`，因为写了名字就等于要求 fiber
等到它，一个等不到就是整机启动失败。

两条断言守着这件事：`dsh.client declares no inject edges` 和
`every bundle require resolves as a platform seed word`。

---

## 配置

在 profile 的 `cordis.patch.yml` 里给 `session-top` 行加 `config`：

```yaml
- id: session-top
  name: dsh-session-top
  config:
    activity: any        # any = 任何提交事件都算活动；prompt = 只算用户消息
    debounceMs: 400      # 活动风暴的合并窗口
    maxTrackedSessions: 2000
    logFile: ''          # '' = $DSH_HOME/dsh-session-top/activity.log；'off' = 关闭
```

`activity: any`（默认）是「工具提交也算」—— 正在跑的任务会持续上浮。
`prompt` 只认用户自己的消息，和 GUI 的「最后更新」标签口径一致。

---

## 诊断

loopback-only，不信任 `X-Forwarded-For`：

```
GET  /api/dsh-session-top/status    # 计数器、pin 集、按活跃度排的会话
POST /api/dsh-session-top/resync    # 从持久化重新播种活动时间
```

`status` 的 `ranked` 数组就是侧栏当前的活跃顺序 —— 行为 1 是否生效，看它
每次活动后是否真的换人即可确认。

---

### 服务必须用 `ctx.get()` 读，不能用 `ctx.<name>`（装机实测踩过）

cordis 的 Context 是一个 **Proxy**：读一个没有 declare 的属性会**抛错**
`cannot get property "uiWorkspace" without inject`（`vendor/cordis/src/reflect.ts`）。

这个抛错从 `apply` 里逃出去，cordis 记日志，fiber 卡在 `FiberState.LOADING`
—— 就是那个 `web boot: 1 entry did not activate` + `loading`。

本插件 `inject: []`，所以 `uiWorkspace` / `locale` / `logger` 永远不会被
provide，`ctx.uiWorkspace` 这种写法**必然**抛。只有 `ctx.get(name)` 会沿
fiber 链查找并返回 `undefined`。

```js
const workspaces = ctx.get('workspaces')   // 对
const sessions   = ctx.get('sessions')     // 对
const workspaces = ctx.workspaces          // 错：没有 inject 就抛
```

`ctx.effect` 是 Context mixin，每个 fiber 都有，可以直接用。

两条测试守着：`test/cordis-activation.mjs` 用**真实 cordis 4.0.4**
（`vendor/cordis`）跑一遍，确认 fiber 真的到 ACTIVE；`core.test.js` 里
`services are resolved with ctx.get, never with bare ctx.<name>` 做静态拦截。

## 测试

```bash
npm test        # 单元测试 + bundle 冒烟 + 真实 cordis 激活 + 双侧栏 DOM
```

- `test/core.test.js`（29 项）：`planFloatToTop` 上浮语义、loopback 信任围栏、
  peer 版本范围、两种侧栏选择器与 token 绑定、右键「事件归属表」顺序、
  「未知 flavor 只观察」、flavor 惰性探测 + 区域行不带 flavor 标记、
  样式禁止 CSSOM、「apply 不得早退」+「必须有 console 日志」、
  「服务只能用 `ctx.get` 读」。
- `test/bundle-smoke.mjs`：stub 上跑 bundle 工厂全流程，灌畸形数据。
- `test/cordis-activation.mjs`：**真实 cordis 4.0.4**，断言 fiber 到 ACTIVE，
  外加「零服务」降级场景。
- `test/sidebar-dom.mjs`（16 项行为断言）：两种侧栏骨架；**先让 apply 在服务
  publish 之前跑**（复现真机时序）；flavor none 只观察；区域行不带宿主标记；
  只在宿主自己的行没挂载时也不误判；**侧栏晚渲染仍能正确识别**；
  右键事件到达 React root 哨兵；只追加新出现的菜单面；隐藏规则、静态样式存活、
  区域锚点、分组折叠。

**没有覆盖**：真实浏览器渲染、真实 Host RPC 往返。这些需要主代理在 GUI 里验收。