# dsh-session-top

ZCode 风格的会话列表 for DeepSeek Harness 0.2.x：会话有新活动就自动上浮，
右键会话行可以置顶/取消置顶，置顶的会话从工作区分组里抽出来显示在侧栏顶部
的「已置顶」区域，置顶状态跨重启保留。

纯插件，零核心修改。双面结构（host + client）。

## 运行提示与常用操作

**绿色表示会话自身正在执行；黄色表示会话自身空闲、但有子代理正在执行。**
父会话和子代理同时执行时显示绿色，并保留子代理数量。顶部「运行会话 / 子代理」
分别统计正在执行的根会话、正在执行的子代理；多级后代和 Team 成员按会话 ID 去重，
空闲父会话不会因为子代理执行而计入「运行会话」。普通分叉仍作为独立会话统计。
只认宿主当前列表里的 `running === true`，不把会话驻留或 `activity` 标签当作执行；
旧宿主缺少 `running` 时不猜测运行状态。

**运行中的会话会临时上浮。** 未置顶会话在自身或子代理执行期间出现在顶部区域，
原工作区里不重复显示；执行完成后移出临时区域，回到原分组，原本已置顶的仍保留。
活跃会话按最近活动排序；每秒读取插件 Host 已过滤的根会话活动时间，助手输出和工具结果
也会触发上浮。活动接口不可用时退回宿主摘要；初次加载或同批更新按活动时间比较新旧。
这层临时展示不写入置顶集合，与原有的工作区活动重排分开。

**普通置顶按最近活动排序，超级置顶独立显示在它上方。** 初次加载即比较已有的活动
时间，不必等待下一次运行。行尾「−」取消普通置顶，「+」设为普通置顶；星标设置或取消
超级置顶。普通未置顶会话会先通过官方 pin 接口置顶，成功后才设置超级置顶。
置顶集合仍由宿主保存，星标只在本浏览器的 `localStorage`
（`dsh-session-top:absolute-pins`）记录该集合内的优先级；同源窗口会同步，
不承诺跨浏览器或跨设备同步。再次点击星标只取消绝对优先，保留普通置顶；
取消普通置顶也会清除超级置顶记录，之后重新置顶不会恢复旧的超级优先级。

**当前选中行显示红色。** 选中底色覆盖运行状态和自定义底色，运行文字与边标仍保留。
Windows 打包桌面版的任务栏与托盘图标显示为深蓝色（`#1e3a8a`）实心圆；插件停用或
Host 退出时恢复原图标。仅对已验证的桌面 Host 及其直接 Electron 父进程生效，命令行
和其他平台不修改图标。后续 Explorer 重启、窗口重建或 DPI 变化需重新加载插件。

**双击会话标题可行内改名。** Enter 保存，提交前去掉首尾空白（`trim`），
空白名称会被拒绝；中文输入法组合输入期间的 Enter 只确认输入，不提交改名。
提交前按 Esc 或让输入框失焦可取消。提交期间输入框禁用；失败后显示错误、
保留草稿并恢复编辑，列表重排不会丢掉正在编辑的草稿，也不会打断焦点与选区。
若临时上浮会话在改名期间执行结束，该行会保留到保存或取消，再回到原分组。
其他窗口切换该会话的超级置顶时，也会等编辑结束后换区，以免打断中文输入。

**断线时不把缓存运行状态继续显示。** 宿主提供可选的 `connection.state` 与
`connection.generation` 接口时，插件同时监听两者；断线或尚无连接 generation 时
清除运行标记，显示「运行状态暂不可用」。重连后的公开接口无法保证会话列表已取得
当前 generation 的新基线，因此连接恢复后可能短暂读到先前的摘要。缺少这套连接接口的
旧宿主按可读的会话字段降级，不额外推断连接或执行状态。

**每次进入或切换会话时，右侧栏默认展开，首先显示「任务管理」。** 进入后的手动
收起和切页不会被列表刷新反复覆盖；下次切回该会话时再应用默认值。插件通过宿主
`sidebarRight` 接口操作，任务页来自 `dsh-better-sidebar` 的 `subagent` 类型。
任务页晚注册时会等待；缺少该页时仍可展开右侧栏，缺少宿主接口时安全跳过。
只用任务页替换空白「开始」页，已有文件和其他页面保留；不直接修改宿主存储。

---

## 行为与实现位置对照

| # | 验收标准 | 实现位置 |
|---|---|---|
| 1 | **工作区活动重排**：有新活动的 session 上浮到所属工作区顶部；绝对优先仍优先于顶部区域的活跃顺序 | `src/index.js` 的 `onSessionEvent` 记录活动时间 → `reorderSessions()` 通过官方 `workspace.insertSessionBefore` 把该 session 上浮到所属工作区账户顶部。算法在 `src/core.js` 的 `planFloatToTop`。 |
| 2 | **右键置顶**：右键会话行出「置顶该会话」/「取消置顶」 | `src/client.js` 的 `registerSharedMenu`（发布进共享扩展表，由 owner 渲染）+ `onContextMenu` / `openMenu`（owner 不在场时的自有兜底菜单，在光标处弹出）。 |
| 3 | **顶部区域**：置顶及临时运行会话抽出工作区，顶部平铺且分组内不重复；未置顶的运行会话完成后回到原分组。所有原生区段、分组和目录默认收起，仅手动激活各自表头才允许展开；点击顶部会话不会展开原分组 | `src/client.js` 的 `renderRegion`（平铺渲染）+ `applyPinRules`（样式表规则隐藏分组内的原行）+ `reconcileGroups`（折叠分组）。 |
| 4 | **取消置顶**：没有自身或子代理执行时移出顶部区域，回到原工作区分组；仍在执行则保留为临时运行行 | 同一套 `reconcile`：仅在置顶和临时运行集合都不再包含该会话时恢复原行；分组保留用户手动选择，取消置顶不会自动展开目录。 |
| 5 | **持久化**：置顶状态跨重启保留 | 置顶集合直接用宿主已有的 registry 全局 pin 集（`workspaceRegistry.pinnedSessionIds`），经官方 `workspaces.pinSession` / `unpinSession` RPC 写入。宿主自己落盘，插件不存第二份置顶集合；星标优先级另存本浏览器 `localStorage`。 |

---

## 设计要点

### 为什么置顶状态不自己存

置顶集合用宿主已有的 `pinnedSessionIds`（官方侧栏的图钉按钮写的就是它）。
它本来就是持久化的，跨重启自动保留 —— 行为 5 由「复用官方存储」满足，
而不是插件自己再写一份置顶集合。星标的绝对优先级只保存在本浏览器
`localStorage`，仅对当前官方置顶集合中的会话生效。

自己存会带来一个真实风险：用户在别处（比如官方图钉按钮）取消了置顶，
插件那份副本不会跟着更新，两边不一致后界面上会出现「以为置顶了其实没有」
的幽灵状态。

插件自己的状态目录 `$DSH_HOME/dsh-session-top/` 只放**活动日志**
（`activity.log`，纯调试用）和诊断数据。删掉它只会让本次进程外从未运行过的
会话少一层排序精度，置顶状态不受影响。

### 为什么工作区活动重排要在 host 侧改持久顺序

官方侧栏默认视图（`orderBy: 'updated'`）本来就每帧按 `summary.updatedAt`
排序，所以「看起来上浮」是免费的。但工作区的**持久**账户顺序
（`workspace.sessionIds`）只有 `insertSessionBefore` 能改。

如果只在客户端排，用户一旦把侧栏切到「手动排序」，活动就再也不影响顺序了。
在 host 侧把持久账户本身也上浮，两个视图就一致 —— 而且重启后还在。
这里指原有工作区顺序；顶部区域的运行上浮只是临时展示，完成后退回原分组，
不会因此新增官方置顶。

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

唯一的例外是**只读影子**：别的插件（`dsh-session-pin`）在
`sidebar.footer.action` / `shell.overlay` 上挂着自己的置顶计数和面板，
它数的是自己的私有 store，于是顶部 5 条、底部却写「(2)」。这里对这两条
entry 各注册一条低一档 priority 的影子，复用原 component 和原 inject，
只把 `pin` 换成读官方 `pinnedSessionIds` 的门面（写入也走官方 RPC），
不动对方的 entry、不动它的私有 store；teardown 时影子自己释放。
面板的 workspace 分区、行颜色、tags 仍由对方的 store 提供。
`test/pin-integration.mjs` 守这一条。

同源的只有这两条：`sessions.row.action`（行上的置顶/色点）和
`conversation.session.header.actions`（会话头部开关）**仍读第三方自己的状态**，
本轮没动，所以不能称为「全部置顶表面已统一」。

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

用户机器上真正的侧栏是 **`@michengai/dsh-codex-ui`**（实测装的是 1.1.42），它
以 `cordis.patch.yml` 插进组合，并以 `priority: -1` 抢下 `sidebar.workspaces`
这个 `single` slot——官方那个 `WorkspaceBrowser` 因此**从不挂载**。第一版只写
官方选择器，在那台机器上一个都匹配不上 —— 症状是「boot 0 错误但界面零效果」，
因为「什么都没渲染」和「功能被禁用」看起来一模一样。

现在按**属性存在性**探测，不做类名全文匹配。**官方标记优先**：官方行
（`data-row-key^="session:"`）一旦在页面上就以官方为准，因为 codex 的 dcu 属性是
**叠加**上去的，官方树一旦挂上（profile 同时装了官方浏览器，或官方树比 codex-ui
活得久）就该认它。官方侧的搜索结果树不会误判——它的 `SearchResultItem` 行根本不带
`data-row-key`（`rows/WorkspaceBrowser.tsx:850-857`）。每一轮 reconcile 都重新
探测，实测 codex → official → codex 两头都能纠正回来。

| 行为 | codex-ui（真机） | 官方 ui-workspace |
|---|---|---|
| 会话行选择器 | `[data-dcu-session]` | `[data-row-key^="session:"]` |
| 从行取 session id | `getAttribute('data-dcu-session')`（**原始 id**，形如 `session-<uuid>`） | `getAttribute('data-row-key').slice(8)` |
| 分组表头 | `.dcu-wb-project-head[aria-expanded]`（无 id 属性，靠 `.dcu-wb-project` 的**祖先链**定位，结果缓存） | `[data-row-key^="workspace:"]`（自带 workspace key） |
| 会话列表容器 | `[role="tree"]`（`.dcu-wb-tree`，**无** aria-label） | `[role="tree"][aria-label]`（label = `t('section.sessions')`） |
| 置顶隐藏规则 | `[role='tree'] [data-dcu-session="<id>"]` | `[role='tree'] [data-row-key='session:<id>']` |
| 主题 token | `--dcu-sidebar-*` | `--dsh-*` |
| 右键菜单 | 宿主自己的 `sessionMenuItems()`，**没有**置顶项，也加不进去 | `sidebar.workspaces.session.menu.item`，有官方 `pin` 行；本插件在旁边加 `dsh-session-top.row-color`（order 500） |

### 侧栏上另外几件实际行为

**全局面板默认折叠，并且记住。** 顶部 `nav[class*="panelList"]` 首次默认折叠，插件在
它上面加一个真 `<button>` 控制（`aria-expanded` / `aria-controls` 齐全）；用户的展开
或收起记在 `localStorage` 的 `dsh-session-top:panels-collapsed`，下次装载按记忆还原。
窄栏和未知 flavor 交给宿主，插件只观察。

**侧栏上有两级折叠，互不相干。**

一级是**宿主区段、分组和目录各自的**默认收起。官方侧栏按工作区表头处理，codex-ui
同时覆盖区段、集合和项目。只有用户手动激活对应表头，才允许该层展开；点击顶部会话、
运行状态更新、改名、置顶或取消置顶，都不会授予展开权限。宿主因选中会话自动展开时，
插件会将该层收回；用户手动展开或收起的选择则在本次 mount 内保留。表头上的菜单、
新建会话和文件夹提示按钮不算展开操作。

这份手动选择**不进 `localStorage`，跨刷新不记忆**，每次 mount 都重新默认收起。
收起走表头自己的 `click()`，读回 `aria-expanded` 才算落地；延迟提交或表头替换不会
导致同一待确认操作被重复点击。官方原生右键菜单借用会话行时仍可临时展开，菜单关闭后恢复。

二级是**「工作区目录」总开关**，在目录区**正上方**（控制放在被折叠块的外面，否则它会
跟着自己折叠的那一块一起消失）。点一下把**目录和目录里的会话一起**收起来：一条 CSS
规则，不删节点、不改父节点，所以每个目录自己的展开状态原样保留，展开回去时各目录
仍停在用户留下的样子。默认展开，只有显式的 `1` 算折叠，记在
`dsh-session-top:groups-collapsed` —— **目录这两级折叠中，仅总开关记入
`localStorage`；单个目录不记忆**。（面板区、置顶区、行颜色另有各自的 key。）

这一层**目前只支持官方 ui-sidebar**。它要折叠的那一块是从**已证明的**
`[role="tree"][aria-label]` 往上取的父节点，还要求它确实装着 `workspace:` 表头（官方
FLAT 视图根本没有目录）、且侧栏不在 56px 窄栏态——按宿主哈希类名全局去找会把页面上任何
长得像的容器一起收掉（`test/sidebar-dom.mjs` 的 3i 用一个排在真身**前面**的仿冒容器守
这条）。codex-ui 每个工作区一个 `.dcu-wb-project`，没有一个装着它们全部的座位，所以不
提供这一层；但它的**每个目录**默认收起照常生效，因为那条规则只需要各自的分组表头。

**官方侧栏的右键直接复用宿主自己的菜单。** 官方行的入口是 "…" 按钮菜单，所以插件不
改写那份菜单：右键时把宿主那一行临时挪到指针下、点它自己的 "…"，弹出的就是宿主原生
那一整份（置顶/取消置顶、重命名、分叉会话、归档会话、复制 Session ID），置顶不出现
第二份。宿主行因为分组折叠而不存在时，先用分组表头把它展开出来；仍然拿不到才退回
插件自有的单项菜单。菜单关闭、第二次右键、卸载，都会把临时样式和只有插件展开过的那个
分组还回去。codex-ui 有自己的原生右键菜单，只观察、不抢。

**颜色菜单入口在哪、哪没有。** 这取决于这一版装了什么菜单 owner，**不是所有右键都有
颜色项**，说清楚边界：

- **官方侧栏（有 host session row）**：本插件通过公开 slot
  `sidebar.workspaces.session.menu.item` 注册一个**独立命名的**新条目
  （id `dsh-session-top.row-color`，order 450，排在宿主自己 order 100 的置顶项之后），
  复用宿主的 `PinSessionMenuItem` 组件和 `inject`。结果就是**宿主那一整份菜单照旧**，后面
  多出第六项「自定义行背景颜色…」。宿主自己的置顶项**一个字都没改**：不 shadow、不替换、
  不改 order，它晚到、被换掉或被撤销时，颜色项跟着它的宿主项走。
- **装了共享 owner（`@baihejiangnan/dsh-session-context-menu`）**：走共享扩展表，
  它渲染进 owner 自己的菜单。
- **两者都没有的行**：只剩插件自有的 fallback 菜单（置顶 + 颜色两项）和置顶行尾的色点。

宿主的归档会话上不提供颜色项——这是宿主组件自己的契约（archived 返回 null），不是
本插件加的限制。

**置顶区自己也能折叠，每条会话行还能自己上色。** 「已置顶」那一行是一个可聚焦的
真实控件（`role="button"`、`aria-expanded` 齐全，Enter/Space 都能用），点它把下面的置顶
行收起来——只隐藏、不删除，所以行节点、顺序和计数都不动；选择记在
`dsh-session-top:region-collapsed`，只有显式的 `1` 算折叠，默认展开。颜色按
`{sessionId:'#rrggbb'}` 存在 `dsh-session-top:row-colors`，只接受严格六位 hex
（`#000000` 是合法颜色），取消置顶再置顶颜色还在。背景是混色，hover、焦点和当前会话
的高亮都仍然看得清。

**颜色对话框是插件自己的，菜单入口和行尾色点共用它。** 右键菜单里的「自定义行背景
颜色…」和置顶行末尾的色点打开同一个对话框：一个六位 hex 输入框（带原生取色器辅助）、
**应用 / 取消 / 恢复默认**三个按钮。**Enter 从输入框提交**；**Esc 取消**。
**只有「应用」和「恢复默认」会写存储**——恢复默认写的是一次清除（只删这一个
sessionId），不是「什么都不做」；**取消和 Esc 一点都不写**。非法值就地拒绝并显示提示
文字（`role="status"`，同时置 `aria-invalid`）——不是只把边框标红而不给话看。

回焦：从**行尾色点**打开的对话框关闭时，焦点交还那个色点。从**右键菜单**打开的，
只有菜单自己交还焦点的那条路径能回到原行；菜单项随后连同菜单一起消失时，焦点会落回
页面而不是原行（已知 P2）。

**对话框里的取色器只是辅助，不直接写盘。** 它拖动/改值时的 `input` 和 `change` 都只
把颜色填进输入框，**必须再按「应用」才存**。行尾那个旧的隐藏原生取色器（兼容路径）
仍保持"`input` 只预览、`change` 才保存"，那是另一条路径的行为，不是新对话框的默认交互。

**行标题字号分两档，作用域很窄。** 只有被 `data-stp-typography` 标记的那棵树里、
工作区与会话行的标题（以及同位的改名输入框）降到 12px/400/16；置顶区自己那几行
保持 14px/500/20。官方侧栏的标题用 `[class*='_title']`（CSS module 哈希类里的
可读片段），codex 侧栏没有哈希类可匹配，直接点名它自己的
`.dcu-wb-session-title` / `.dcu-wb-project-title` / `.dcu-wb-collection-label`，
改名输入框是 `.dcu-wb-rename-input`。

**紧凑化必须覆盖 codex 自己的行，否则等于没做。** 行高和字号两段规则原来只写
`data-row-key`，而 codex 的行是 `data-dcu-session` + `.dcu-wb-session`，**一个
`data-row-key` 都没有**：标记照样落在 `.dcu-wb-tree` 上，下面每条规则却一条都匹配
不到，界面看起来完全没生效。现在两种侧栏的行都进规则——codex 的会话行
`[data-dcu-session]`、目录头 `.dcu-wb-project-head`、分组头
`.dcu-wb-collection-head` / `.dcu-wb-section-head`——统一收到 26px 行高 / 24px
最小命中区，作用域仍然全部挂在 `data-stp-typography` 之下。
`test/sidebar-dom.mjs` 里有一条专门的断言就是钉这个的：规则在，且必须仍然挂在
标记之下。

**分组头要连它自己的标题一起收，否则收出一个溢出。** codex-ui 把标题的尺寸和头
是分开定的：`.dcu-wb-collection-label` 是 `min-height:32px` + 4px padding，
`.dcu-wb-section-label` 是 `min-height:24px` + 2px padding。只把头压到 26px、
标题不动，就是把一个 32px 以上的子元素 `align-items:center` 地塞进 26px 的盒子里
——上下各溢出几像素，点击区也跑到它所属的分组头外面去了。所以这两个 label 和
它们的头在同一条规则里收，并且显式 `border-box`：否则它们自己的 padding 会加在
声明的高度之外，这正是官方侧栏那条规则早就写在 `box-sizing` 上的同一个原因。

**紧凑化：真实页面上量到的值。** 下面每个数字都是在真实官方侧栏上量到的 before → after，
不是设计意图：

| 位置 | before | after |
| --- | ---: | ---: |
| 置顶区总高（5 条） | 201px | 159px |
| 单条置顶 | 32px | 26px |
| 「已置顶」折叠头 | 28px | 24px |
| 单个工作区目录行 | 34px | 26px |
| 单条会话行（宿主） | 32px | 26px |
| 今日 / 余额 / 时段区 | 74.91px | 63.14px |
| 导入会话 | 42px | 28px |
| 已置顶底部入口 | 28px | 24px |
| 账号菜单 | 44px | 32px |

只压行高、组间距和底部留白：**不隐藏任何信息**，每个主要可点控件的命中区保持在
24px 及以上。底部几个控件的紧凑值必须用 `!important` 才能生效——导入按钮的高度是宿主
写在**行内样式**里的，普通规则压不过；置顶底部入口则是宿主 `button[class]` 规则加
`all: unset`，单属性选择器也压不过。这些 `!important` 只出现在这几个已证 marker 上，
测试里对此有断言。

**行尾那个旧的隐藏取色器（兼容路径）才是一落定就写盘。** 拖动时的 `input` 只做实时
预览、不写存储，`change`（松手/回车/关闭）才保存并按 key 触发一次跨上下文同步。这条
只适用于那个兼容控件；上面说的新对话框必须按「应用」。已知边界：同一 origin 下多个
窗口各自改色走的是「读整张表 → 合并 → 整张写回」，没有锁也没有 CAS，并发写按
last writer wins，理论上会覆盖掉对方那一次修改。

这些行为都不引入新依赖。

### 右键接缝：共享扩展表，不是 DOM 嫁接

会话右键菜单属于 `@baihejiangnan/dsh-session-context-menu`（本文以 v0.2.14 的
tagged 产物为准；未发布的 main 菜单内容已有差异，见下文）。它的
client 侧在 `globalThis[Symbol.for('dsh.session-context-menu.extensions')]` 上建一张
共享扩展表，**表由它自己创建和维护**，并在自己 apply 期间持有 lease；每个
`visible({session, row})` 通过的条目都被渲染进它自己的 `.dshcm-menu`，点按时
`run({session, row, sessions, workspaces, close})`。

本插件 `register()` 进那张表，**从不自建第二张**。上一版是去 DOM 里找
`[data-menu-material]` 菜单面往里嫁接节点——owner 根本不用那套标记，于是在真机
上每行右键都匹配到零个菜单面，什么也没发生。

事件归属**不看注册表**。表在 owner 卸载后仍然存在（lease 归零但还有条目时表不
删），`api.list()` 里能看到我们自己的 id，这只能证明条目在，不能证明 owner 活着。
所以归属按**事件实际发生了什么**判定：

- owner 声称手势的方式是它在自己的 document 捕获监听里 `preventDefault()` +
  `stopPropagation()`；
- 我们在同一个节点同一个阶段，轮到本 handler 时无法知道它的监听是已经跑过还是
  排在注册序前面。

因此自己的兜底菜单**延后一个微任务**（在整轮 dispatch 之后）打开，且只在事件到
那一刻仍 `defaultPrevented === false` 时才开。这同时覆盖 owner 先监听、owner 后
监听、owner 卸载后我们的条目留在表里、owner 从未加载四种情形；owner 在场时它先
`preventDefault`，我们的兜底什么都不做，两边不会同时开菜单，空白区域也永远不会被
认领。

**置顶行自己被右键时，判据换成"转发出去的事件本身"。** 区域行不是宿主行，
codex 不会为它开菜单，所以这里的归属只有两个来源：转发到该会话真实宿主行上的
那一轮 dispatch 里，谁调用了 `preventDefault()`。转发**送达**不等于有人**认领**
——宿主行存在只说明送得出去。所以 `redispatchContextMenu` 返回事件对象而不是
成功标志，`openOwnRowMenu` 在同一个微任务回调里读它的 `defaultPrevented`：
owner 认领 → 只有 owner 的完整菜单；codex 自己的会话行处理器认领
（`dsh-codex-ui/lib/client.js:4617`，同步 `preventDefault` + `stopPropagation`）
→ 宿主菜单原样保留；**没有任何人认领** → 退到本插件的置顶/取消置顶菜单。
连重投递都构造不出来（没有 `MouseEvent` 或宿主行拒绝）时同样退到兜底：那说明
既没人服务这次右键、也不可能有人服务，此时"因为宿主行在所以不动"是把右键丢在
地上。普通宿主行的 codex 原生门（`nativeContextMenu`）保持不变，仍然只观察。

`test/shared-menu.mjs` 直接照抄 0.2.14 的 `ownerRegistry()` 与它的
`onContextMenu` 来驱动真 bundle，逐条验证上表（含 owner 卸载后接管、owner 晚加载、
owner 先加载、owner 重载）；`test/sidebar-dom.mjs` 对两种侧栏各建一套骨架 DOM，
验证上表其余各行。

**菜单内容随 owner 版本变化，测试按 sha256 钉版本。** v0.2.14 的 tagged 产物菜单里
**没有**「删除会话」；未发布的 main 才加了
`deleteSession`。`test/owner-menu-real.mjs` 按 owner `lib/client.js` 的 sha256
绑定一份手写菜单契约（v0.2.14 = `6960b05c…`，main@ab40cced = `9ccc3ab8…`），
expected 全部是字面量、逐项精确断言，不从实际渲染结果里过滤。遇到未登记的
sha256 会**直接失败**并打印该 hash 与已登记版本；新增版本时读它自己
`if (row) {` 那段的 `add()` 调用，把 sha256 和它调用的标签加进契约即可。

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
- **host 半边**那行 `active (activity …, N pinned, …)` 只在 `workspaceRegistry`
  已经 publish 时才报数字；没 publish 就写成
  `pinned count unavailable (no workspaceRegistry yet)`，而不是一个会被人当成事实的
  `0`。`inject` 保持 `[]` 就是为了在没有 `workspaceRegistry` 的宿主上照常跑，
  这个代价必须如实标出来而不是藏起来。实时数字看
  `GET /api/dsh-session-top/status`（loopback only）
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

## 右键：codex-ui 的宿主菜单不能借——但装了共享 owner 时借得更值

codex-ui 的行菜单是 `SessionRow` 的一个 **prop**，由它自己的 `sessionMenuItems()`
现场拼出来（`@michengai/dsh-codex-ui` lib/client.js:1757-1836），**不是**
`sidebar.workspaces.session.menu.item` 那张 slot 表。条目是重命名 / 标记为未读 /
归档 / 分叉 / 在资源管理器中打开 / 项目 / 复制会话 ID / 复制会话标题 /
复制工作目录（注册表允许时还有删除）——**没有取消置顶，也没有自定义行背景颜色**，
而且加不进去：codex-ui 自己以 `priority: -1` 抢占了 `sidebar.workspaces` 这个
`single` slot（`ui-slots/src/index.ts` 的 `entriesOfSlot`：每个 cell 只返回第一个
存活条目），官方那个**声明了 `session.menu.item` 并注册 `pin` 行**的
`WorkspaceBrowser` 因此从不挂载，那张列表没有任何渲染者；本插件注册进同一张
列表的颜色项也同样注册成功、没人画。

**所以「有没有共享 owner 在场」决定走哪条路，这是承重的，不是可有可无的：**

- **owner 不在场** → 自有置顶行的右键**不转发**宿主行，直接 `openMenu` 开自己的
  菜单（取消置顶 + 自定义行背景颜色…）。转发在这个宿主上买到的是一条**缺了这两项**
  的菜单，而自己的菜单正好只有这两项。
- **owner 在场** → **仍然转发**，因为共享 owner
  （`@baihejiangnan/dsh-session-context-menu`）**根本不用那张 slot 表**：它自己
  从零拼一个 `.dshcm-menu`，并从
  `Symbol.for('dsh.session-context-menu.extensions')` 里读本插件注册进去的条目。
  于是在**同一个 codex 宿主**上，它的菜单同时有宿主动作（重命名 / 归档…）
  **和**取消置顶**和**行颜色——比上面两个选项都多。此时短路转发只会白白拿走这些。
  判据用 `sharedMenuRegistered(sharedMenuApi())`，读 owner 自己的 `list()`，
  不是记住注册时的状态，所以 owner 卸载后自动退回「不转发」那一支。

普通未置顶的宿主行在两种情况下都仍然只观察、不抢——那条菜单有八九项能用的动作，
本插件替换不了。官方侧栏（`nativeContextMenu: false`）不受影响，仍然转发，菜单里
同时有官方 `pin` 行和本插件的颜色项。

这两个半边都有断言：`test/sidebar-dom.mjs` 钉「owner 不在场」，
`test/owner-menu-real.mjs` 拿**真实 owner 产物**钉「owner 在场」（它断言的正是
自有菜单**不得**出现、必须由 owner 建出完整菜单）。只钉一半，就是上一版把
owner 集成改坏的那条路。

仍然**不向宿主菜单 DOM 嫁接节点**，宿主菜单里的重命名 / 归档 / 分叉保持原样。
双击标题的行内改名另走公开会话重命名接口。

## 右键：宿主行那一支只观察，不碰事件

真机上 codex-ui 的行菜单**不再打开**（`[role=menu]` count=0）。React 是把监听
挂在 **root 容器**上的（委托），所以只要事件在 document 捕获阶段被打断
（`stopPropagation` 之类），React 根本收不到，菜单永远不开。

现在宿主行的分支在 `return` 之前**完全不碰 `event`** —— 不 preventDefault、
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

右键处理路径只有两处可以中断事件，写在同一处并逐条列明前置条件：

| # | 条件 | 行为 | 是否碰 event |
|---|---|---|---|
| 1 | 事件到达时 `defaultPrevented` 已为 true | **只观察**（owner 或别人已经接手） | 否 |
| 2 | `closest('[data-stp-row]')` 命中 | 转发宿主行（官方侧栏，或 codex 宿主且共享 owner 在场）/ 立即开自己的菜单（其余情况） | **是**（自有行，没有宿主菜单竞争） |
| 3 | `flavor === null` | **只观察** | 否 |
| 4 | 解析出宿主的 session 行，且 dispatch 结束时仍无人处理 | 延后一个微任务开自己的兜底菜单 | **是**（dispatch 之后） |

第 2 条里的「转发」在两种宿主上会发生，各有各的理由：

- **官方侧栏**：宿主菜单由 `sidebar.workspaces.session.menu.item` 渲染，`pin` 行
  就在里面，本插件再把 `pinSession`/`unpinSession` 两个回调换成颜色对话框，于是同
  一条菜单里既有官方的置顶/取消置顶、也有本插件的 `自定义行背景颜色…`。
- **codex 宿主，且共享 owner 在场**：owner 自己建菜单、且从共享表读到本插件的
  两个条目，比宿主那条多得多，理由见上一节。

codex 宿主**没有 owner 时**不走转发：它的菜单里既没有这两项、也加不进去，
转发只会买到一条更差的菜单。

在**转发**这条路上，判据同第 1、4 条但作用在**转发出去的**那个事件上：谁
`preventDefault()` 就是谁认领，无人认领才落到置顶/取消置顶兜底菜单，连事件都发
不出去也落到兜底。"宿主行存在"不是认领。

React 把监听挂在 **root 容器**上，所以捕获阶段任何中断都会让宿主菜单永远
打不开 —— codex-ui 的行菜单因此死过两次。现在「不认识 = 只观察」，不做任何
事件修改、不开自己的菜单。owner 在场时它自己 `preventDefault`，第 4 条就永远
不触发；owner 不在场（或卸载后条目还留在它的表里）时第 4 条接管。

`test/sidebar-dom.mjs` 用挂在 tree 上的哨兵监听器模拟 React root，断言事件
仍然能到达；另有行为测试：flavor none 完全不干预、区域行不带宿主标记、
侧栏晚于插件渲染时仍被正确识别、以及 `MutationObserver` 静止一秒零突变且行节点
身份不变（这些我都注入回归验证过会失败）。归属的四种时序在
`test/shared-menu.mjs` 里对着 0.2.14 的真实 owner 代码逐条验证；转发后"有人认领
/ 没人认领 / 构造不出事件 / 已卸载"四种判据在
`test/owner-menu-real.mjs` 里对着两个未修改的真实 owner 产物逐条验证。

## 降级契约

官方结构变了不能崩，这是硬约束。每处 DOM 依赖都有对应的静默降级路径：

| 依赖的官方结构 | 结构变了会怎样 |
|---|---|
| codex `[data-dcu-session]` / 官方 `[data-row-key^="session:"]` | 两种都找不到 → flavor 为 null → 区域 detach、隐藏规则清空、右键不响应 |
| `[role="tree"]` | 找不到列表 → 同上，完全静默降级 |
| `.dcu-wb-project-head[aria-expanded]` | 找不到表头 → 不折叠，分组保持侧栏原样 |
| `data-row-key^="workspace:"`（官方） | 同上 |
| 共享扩展表 `Symbol.for('dsh.session-context-menu.extensions')` | 表不存在 → 有限次重试后仍拿不到 → 自有兜底菜单接管（仍只在解析出的宿主 session 行上）；owner 在场则照旧交给 owner |
| `workspaces.pinSession/unpinSession` | 缺 RPC → 不置顶，并在界面上给出 `role="alert"` 提示（不是只 `warn` 一次） |
| `uiWorkspace.openSession` | 缺失 → 点击不导航，界面上 `role="alert"` 说明原因。**不回退**到 `sessions.retain` / `sessions.open`：前者是引用计数绑定 API 不是导航，后者在当前 ClientSessions 契约（`{ids, byId, phase, projectionsBySession}`）里不存在 |

`pinSession`/`unpinSession` 被拒绝时同样 `role="alert"` 报出 `describeError`
的 `name: message`，因为一次用户看不见的拒绝和一次坏掉的点击完全无法区分。

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

两条测试守着：`test/cordis-activation.mjs` 用**真实 Cordis**
（仓库 vendor 或 DSH profile 的构建产物）跑一遍，确认 fiber 真的到 ACTIVE；`core.test.js` 里
`services are resolved with ctx.get, never with bare ctx.<name>` 做静态拦截。

## 测试

```bash
npm test        # 单元测试 + bundle 冒烟 + 真实 cordis 激活 + 双侧栏 DOM
```

完整测试需要真实 Cordis 构建产物，以及 `test/owner-menu-real.mjs` 中 SHA-256
契约覆盖的 `@baihejiangnan/dsh-session-context-menu` 客户端。Cordis 可从仓库 vendor
或 `$DSH_HOME/profiles/desktop/node_modules` 读取；菜单客户端可用
`DSH_CTX_MENU_CLIENT` 指向 `lib/client.js`。缺少依赖时测试会明确失败，不会用 mock
冒充真实兼容性验证。本次回归使用 Cordis 4.0.5 与菜单插件 v0.2.14 的固定产物。

- `test/core.test.js`（39 项）：`planFloatToTop` 上浮语义、loopback 信任围栏、
  peer 版本范围、两种侧栏选择器与 token 绑定、右键「事件归属表」顺序、
  「未知 flavor 只观察」、flavor 惰性探测 + 区域行不带 flavor 标记、
  样式禁止 CSSOM、「apply 不得早退」+「必须有 console 日志」、
  「服务只能用 `ctx.get` 读」。
- `test/runtime.test.js`：`deriveRuntime` 的真实执行口径、空闲父会话的多级子代理、
  普通分叉、Team 去重、列表 `ids` 权威与留存记录边界，以及缺失父节点、环和深链。
  可单独运行 `node --test test/runtime.test.js`，也已加入 `npm test`。
- `test/bundle-smoke.mjs`：stub 上跑 bundle 工厂全流程，灌畸形数据。
- `test/cordis-activation.mjs`：**真实 Cordis**，断言 fiber 到 ACTIVE，
  外加「零服务」降级场景。
- `test/sidebar-dom.mjs`：两种侧栏骨架；**先让 apply 在服务
  publish 之前跑**（复现真机时序）；flavor none 只观察；区域行不带宿主标记；
  只在宿主自己的行没挂载时也不误判；**侧栏晚渲染仍能正确识别**；
  右键事件到达 React root 哨兵；只追加新出现的菜单面；隐藏规则、静态样式存活、
  区域锚点、分组折叠、顶部会话导航后的自动展开纠正、codex 区段/集合/项目手动选择、
  表头动作排除和取消置顶保持折叠。另覆盖真实执行绿/黄提示与总数、空闲父会话上浮与完成退回、
  同批活动排序、快照不可用与留存记录排除、独立连接信号与替换/卸载清理、
  星标绝对优先及跨窗口/重挂载、官方取消置顶与失败拒绝，以及双击改名的
  中文输入、Enter/Esc、空白拒绝、失败留草稿、真实换序保留编辑与选区、执行结束后
  保留编辑直到保存/取消，以及会话引用释放。另覆盖进入/切回会话默认展开任务页、
  迟到的 store/任务页注册、会话内手动选择保留、未知左侧栏与卸载取消。
- `test/client-lifecycle.mjs`：真实 Cordis 下验证右侧栏服务晚发布、撤销/再发布、
  短暂切换、订阅清理与待执行打开取消；保留原有挂载、重挂载和重复实例回归。

**没有覆盖**：真实浏览器渲染、真实 Host RPC 往返。这些需要主代理在 GUI 里验收。