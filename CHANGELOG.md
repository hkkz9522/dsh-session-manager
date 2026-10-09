
## 0.6.3 — 2026-10-03

- **feat(settings)**: 新增「弹窗透明度 / Dialog opacity」偏好设置（Issue #23），为第三方主题下的插件弹窗提供通用、不依赖任何主题插件的调节手段：
  - 位置：设置卡片「偏好设置」区域；滑块范围 50%–100%，步长 5%，默认 100%，实时显示当前百分比，并提供「恢复默认」按钮。
  - 通过 `localStorage`（`dsh-session-manager-dialog-opacity`）持久化，复用现有偏好存储，未新建存储系统；拖动滑块立即生效，无需重启 DSH。
  - 透明度只作用于弹窗**背景填充**：新增插件自有变量 `--sm-dialog-opacity`，配合 `color-mix()` 施加到 DSH 的抬升表面 token（`--dsw-alias-bg-layer-1`）上。文字、按钮、输入框、标签、badge、边框、hover 与危险按钮颜色保持完全不透明，并继续跟随 DSH 主题变量。未使用整元素 `opacity`。
  - **不破坏 token 自带 alpha**：默认 100% 时 `color-mix(in srgb, <token> 100%, transparent)` 会**原样**还原 token（含其自身 alpha），因此插件绝不会把 DSH（或主题重新发布的）半透明表面强行变为不透明；只有用户主动下调滑块时才会额外增加透明。输入框、textarea、select、按钮、菜单、filter、卡片等内部控件读取各自的 DSH token，不继承该透明度设置（「统一主题来源，不统一透明度」）。
  - 未检测任何主题插件、未枚举主题名称、未读取第三方插件私有变量；第三方主题只需发布 `--dsw-alias-*` token 即可被继承。
- **fix(css)**: 修复第三方主题被硬编码背景阻断的问题（Issue #23）：
  - 原代码使用的 `--dsw-alias-surface-l1` 在 DSH 中并不存在，所有 `var(--dsw-alias-surface-l1, #fff)` 实际总是回退为硬编码 `#fff`；已改为真实的 DSH token（弹窗 `--dsw-alias-bg-layer-1`，对话框内输入/下拉与菜单 `--dsw-alias-bg-layer-2`）。
  - 移除 `background:#fff!important` / `background-color:#fff!important` / `background:#1f1f23!important` / `background-color:#1f1f23!important` 强制锁色，以及弹窗根节点上多余的 `opacity:1` 与 `.sm-migrateDialog` 上的 `backdrop-filter:none`。
  - 删除 `smApplyInlineTheme()`：它向弹窗根节点写入内联 `!important` 背景/文字/边框颜色，会无条件覆盖包括第三方主题在内的任何主题；浅色/深色适配改由 `html[data-sm-theme]` 作用域 CSS 与 token 回退值承担。
  - 弹窗头部/主体/底部不再各自绘制不透明底色（迁移弹窗原本重绘 `#fff`），透明度因此只叠加一次，50% 设置不会被内部不透明层抵消。
- **fix(plugin-css)**: 插件样式表按 `data-plugin-css` 去重时只创建不更新，导致客户端插件热重载后页面沿用旧版本 CSS（表现为「设置项已出现但样式不生效」）；现在每次加载都会重写样式表内容。
- **feat(opacity)**: 统一接入透明度的弹窗：会话管理主面板 / 标记（annotation）面板（`.sm-panelDialog`、`.sm-annotationSurface`）、删除/移动/迁移确认弹窗（`.sm-confirmDialog .sm-nativeDialog`）、迁移预设弹窗（`.sm-migrateDialog`）、更新弹窗（`.sm-updateDialogLayer .sm-nativeDialog`）、批量操作弹窗（`.sm-bulkDialog .sm-nativeDialog`，含预览/进度/结果/标签/预设迁移）。
- **test**: 新增 `test/client-dialog-opacity.test.mjs`（18 项）覆盖默认 100%、持久化与恢复、范围/步长归一化、设置卡片交互、样式表实际注入内容、热重载重写回归、「文字/按钮/输入/边框不随透明度变化」、「100% 原样保留 DSH token 自带 alpha（不做无意义的覆盖）」、「input / textarea / select / 菜单 / 卡片等内部控件不继承弹窗透明度且各自读取 DSH token」，以及「不得引用特定主题插件或第三方私有变量」的守卫；`test/helpers/client-harness.mjs` 增加 `rootStyleValues` / `styleTags` / `initialStorage` 观测点。
- **refactor(theme)**: 插件不再自建一套独立的浅色/深色配色，改为直接消费 DSH 主题 token（Issue #23 后续）：
  - **删除所有局部 `--dsw-alias-*` 重定义**。原 `[data-sm-theme=light]` / `[data-sm-theme=dark]` 规则曾把 `label-primary`、`label-secondary`、`label-tertiary`、`border-l1`、`border-l2`、`fill-l1`、`fill-l2`、`interactive-bg-hover`、`state-error-primary`、`accent-primary`、`accent-primary-bg`、`state-warning-primary` 全部改写为固定 hex，这会无条件覆盖任何主题（含第三方主题）对这些 token 的修改。现在 DSH 的 `--dsw-alias-*` 只被读取，从不赋值。
  - **修正一批 DSH 中并不存在的 token**（它们的 `var()` 一直静默回退到硬编码字面量，是主题失效的真正原因）：`--dsw-alias-surface-l1` → `--dsw-alias-bg-layer-1`；`--dsw-alias-fill-l1` → `--dsw-alias-bg-layer-2`；`--dsw-alias-fill-l2` 按语义拆分 → `--dsw-alias-bg-layer-2`（内嵌面板）/ `--dsw-alias-markdown-tag`（标签、badge、chip）/ `--dsw-alias-bg-module-platform`（选中行、开关态）/ `--dsw-alias-interactive-bg-hover`（hover）/ `--dsw-alias-bg-skeleton`（进度槽）；`--dsw-alias-fill-l3` → `--dsw-alias-button-ghost-active-fill`；`--dsw-alias-accent-primary` → `--dsw-alias-state-business-primary`；`--dsw-alias-accent-primary-bg` → `--dsw-alias-state-business-tertiary`；`--dsw-alias-accent-primary-hover` → `--dsw-alias-button-info-hover`；`--dsw-alias-state-warning-primary` → `--dsw-alias-state-warn-primary`。
  - **补齐语义化 token**：warn 提示框改用 `state-warn-tertiary` / `state-warn-label`，success 改用 `state-success-tertiary` / `state-success-primary`，error 与危险边框由 `state-error-primary` 经 `color-mix()` 派生（DSH 无 error tertiary），危险 hover 用 `interactive-bg-hover-danger`；填充式按钮的文字色改用 `--dsw-alias-label-primary-foreground`（浅色白字 / 深色深字，深色下蓝、红按钮对比度更好）。
  - **删除被后续声明完全覆盖的固定颜色“旧浏览器双声明”**（如 `color:#111;color:var(…)`、`background-color:#356ae6;background-color:var(…)`、`border:1px solid #d4d4d8;border:1px solid var(…)`）；迁移弹窗不再残留 `#fff`/`#356ae6`/`#4576f0`/`#e8e8e8` 等固定色。
  - **移除大量 `!important`**：`[data-sm-theme=dark]` 下所有 `background` / `background-color` / `color` / `border-color` 强制覆盖全部删除（settingsTag、settingsBadgeLink、updateVersionGrid、bulkSessionList、bulkProgressBar、settingsSelect、header/footer border 等），`.sm-headerBtnDanger:hover` 的三处也不再需要（选择器权重已足够）。保留的 8 条规则中：1 条颜色相关（`.sm-markIcon.sm-markOn`）取值是 `var(--dsw-alias-*)` token，因此不阻断主题，仅用于压过插件自身的同类颜色规则（原 `.sm-danger` / `.sm-dangerText` 两条颜色 `!important` 属死代码，见下方 fix(ui) 已删除）；`.sm-tooltip` 用于覆盖 DSH Tooltip primitive 的内联样式（Issue #21 回归守卫，边框同样使用 token）；其余 6 条为纯布局（overlay portal 提层、`.sm-updateDialogLayer` 居中、`@container` 隐藏、DSH 行 primitives 的文本对齐）。
  - **保留的唯一浅/深色分支**：`--sm-dialog-surface-fallback`（透明度设置在 token 缺失时的回退底色）与 `.sm-priority-1/2`（优先级是插件自有语义，DSH 无对应 token）。
  - 浅色/深色现值与改动前基本一致：`--dsw-alias-border-l2` 浅色等价于原 `#e5e5e5`、深色等价于原 `#3a3a40`，`--dsw-alias-interactive-bg-hover` 亦与原 `#eee` / `rgba(255,255,255,.06)` 基本等价。
- **fix(ui)**: 修复「删除会话」按钮（标题栏 / 面板行 / 批量栏）在主题把表面 token 设为半透明或大面积色时看不清的问题：
  - 根因：这些按钮的底片用的是**表面 token** `--dsw-alias-bg-layer-1`，而表面 token 可能带 alpha 或为大片区域选择的色相；按钮的文字用 `--dsw-alias-state-error-primary`，两者叠加后对比度不再可控（实测注入「洋红半透明表面 + 橙色错误色」时，橙字压在洋红底片上几乎不可读）。
  - 修复：按钮底片改用 DSH 的**按钮**填充 token `--dsw-alias-button-floating-fill`（浅色 `#fff` / 深色 `#2c2c2e`，均不透明），语义上也是 §三 要求的「按钮 → 按钮 token」；涉及 `.sm-headerBtn`、`.sm-headerBtnDanger`、`.sm-bulkBar .sm-bulkBtn`。这样无论主题给表面 token 什么 alpha/色相，危险按钮的文字与图标都落在稳定的不透明按键底上。
  - 面板行内危险按钮（透明底）新增专用 hover：`.sm-rowBtnDanger:hover` 使用 `--dsw-alias-interactive-bg-hover-danger`（与菜单里的危险项一致），不再复用普通 hover。
  - 顺带删除**死代码** `.sm-danger` / `.sm-dangerText`（没有任何元素带这两个 class），它们是仅剩的两条颜色类 `!important`，删除后颜色类 `!important` 只剩 `.sm-markIcon.sm-markOn` 一条。
- **fix(ui)**: 统一「会话标记」窗口里复制 Prompt / 导入区域的格式，使其与上方字段一致：
  - 去掉该区域自带的表面底色（`--dsw-alias-bg-layer-2` 横条，在带色主题下会形成一条与弹窗主体不同色的色带），改为继承弹窗表面，仅保留与其它分区一致的上边框。
  - 补齐与上方字段相同的「标签 + 字段」结构：新增 `AI 返回结果`（复用已有 `marks.import.paste.label` 文案）标签行，两个操作按钮改为靠右排列在同一行；粘贴框仍复用 `.sm-noteInput` / `.sm-fieldWithClear`。
  - 修正内边距叠层：`.sm-importGroup` 改为 `padding:12px 16px`（与弹窗主体 16px 对齐），`.sm-importStatus` 的 `margin:0 16px` 改为 `margin:0`（原本在分组内边距之上又叠加 16px，导致状态框比其它内容缩进更多）。
  - 导入/复制按钮由「表面色填充」改为与弹窗内其它按钮一致的描边样式（透明底 + `border-l2` + `label-primary`）。
- **fix(ui)**: 统一全部弹窗的按钮设计（上一轮把迁移预设弹窗的按钮底色换成 `button-floating-fill` 后，它成了唯一「白色/深灰实底」的取消按钮）：
  - **全部弹窗的次要/取消按钮统一为同一套规格**：`background:transparent` · `border:1px solid var(--dsw-alias-border-l2)` · `border-radius:8px` · `padding:3px 14px` · `min-height:28px` · `font-size:12px` · `line-height:20px`。迁移预设弹窗的实底取消按钮已改回透明；会话管理主窗口与标记窗口原先的 `6px` 圆角 / `3px 12px` / `18px` 行高也统一到同一规格。
  - **hover 统一**：原先只有确认弹窗的 Cancel、迁移/更新弹窗的基类有 hover，批量弹窗、会话管理主窗口与标记窗口的取消按钮**完全没有 hover 反馈**；现合并为一条覆盖五个弹窗的 `.sm-nativeDialogCancel:hover` 规则（`--dsw-alias-interactive-bg-hover`）。标记窗口的取消按钮原先漏了 `sm-nativeDialogCancel` class，已补上以纳入统一规则。
  - **填充态保持一致**：确认按钮一律 `state-business-primary` + `label-primary-foreground`，危险按钮一律 `state-error-primary` + `label-primary-foreground`（五个弹窗完全一致）。
  - **标记窗口的导入/复制按钮**对齐到同一套对话框按钮规格（`min-height:28px` / `3px 14px` / `20px` 行高）。
  - **批量工具栏按钮** `.sm-bulkBar .sm-bulkBtn` 由实底改为透明描边：其填充色与所在容器（`bg-layer-2`）在 DSH 默认浅/深色下取值相同（`#fff` / `#2c2c2e`），实底等同于无效，改为透明后与面板内其它按钮（`.sm-rowBtn`、`.sm-filterBtn`、`.sm-settingsCheckBtn`）一致。
  - **删除死代码**：`.sm-nativeDialogGhost`、`.sm-panelHeaderSelect`（含 `:hover` / `:disabled` / `.sm-on`）从未被任何元素使用（有测试专门断言 JSX 不再使用 `sm-panelHeaderSelect`）。
  - 设计约定（本次确立）：**弹窗动作按钮 = 28px 规格**（透明描边 + 单一 hover）；**面板内的密集控件**（行内操作 `.sm-rowBtn` 22px、筛选开关 `.sm-filterBtn` 24px、批量网格 `.sm-bulkBtn`）保持紧凑尺寸，但共用同一套「透明底 + `border-l2` + hover token」语言与填充态 token。
- **fix(ui)**: 修复深色模式下插件下拉框（`<select>`）的弹出列表仍是白底、与全局主题不一致的问题：
  - 根因：`<select>` 的弹出列表属于**浏览器原生 UA 控件**，它**不读取任何 `--dsw-*` token**。DSH 的机制是把解析后的配色投影给原生控件——ui-layout 的 `ThemePresenter` 订阅官方 `theme/change` 事件后执行 `documentElement.style.colorScheme = snapshot.active.colorScheme`（官方文档：`html { color-scheme }` for native UA chrome）。插件此前没有给 `<option>` 任何样式，于是列表项使用平台默认底色（白）。
  - **插件不再声明 `color-scheme`**：曾有一版把插件镜像的浅/深色状态写成 `html[data-sm-theme=dark] …{color-scheme:dark}`。原生控件是 DSH 的职责——ui-layout 的 presenter 会在 `theme/change` 时写入 `documentElement.style.colorScheme`；插件一旦与 DSH 的投影不一致（镜像判错或过期），就会把原生控件锁在相反的配色上，表现为「切到浅色模式后下拉列表仍然是深色」。现已删除：DSH 是原生控件的唯一权威，插件只负责列表项本身的颜色。
  - 修复（列表项本身）：给插件自有表面内的 `<option>` 显式指定 DSH token——`background-color:var(--dsw-alias-bg-layer-3)` + `color:var(--dsw-alias-label-primary)`，选中项用 accent 文字色标记（`--dsw-alias-state-business-primary`），禁用项 `--dsw-alias-label-tertiary`。
    - **为什么是 layer-3 而不是控件自身的 layer-2**：浮动列表必须保持不透明。主题可能给 `bg-layer-2` 加上 alpha，半透明填色叠在原生弹出列表自身的底上仍然呈现为白/浅色（第一版修复看起来「没生效」即由此而来）。`--dsw-alias-bg-layer-3` 在 DSH 调色板中是不透明的（浅色 `#fff` / 深色 `#353638`），且语义上是位于弹窗（layer-1）与控件（layer-2）之上的一层。选中行改用文字色而非填充色，同样避免任何半透明 token 把它冲淡。
  - 作用范围只限插件自有表面内的 `option`，不会影响 DSH 自己的下拉框；插件全部 7 个 `<select>`（面板的工作区/排序/标签/优先级筛选、弹窗内的选择器、设置卡片的安装源）都位于这四个表面之内，无需逐个枚举 class。
  - 已知平台边界：若宿主把 `<select>` 弹出列表交给**操作系统**绘制（Windows 下 Electron/浏览器在某些版本上如此），该列表将忽略页面 CSS，包括 `option` 样式；DSH 桌面端通过把主题同步到 Electron `nativeTheme.themeSource` 规避了这一点，浏览器端没有该通道。这种情况下唯一的通用解法是不使用原生 `<select>`，改为用 DSH 的 `Menu` primitive 渲染 HTML 下拉层（DSH 自身产品界面即如此，其 primitive 包中并没有 `Select`，只有 `Menu`）。
- **fix(theme)**: 主题镜像改用 DSH 官方事件，不再只靠 DOM 属性观察：`ctx.on("theme/change", () => smApplyTheme())`（ui-layout 的 presenter 在同一事件上投影配色）。原先只靠 MutationObserver 观察 `class` / `data-ds-dark-theme` / `style` 等属性，若某个主题只改 token 值而不触碰这些属性，`data-sm-theme` 镜像就会过期。该镜像现在只影响两处装饰性分支（token 缺失时的透明度回退底色、优先级颜色），并被测试锁定为**不得**声明 `color-scheme`、不得重定义任何 `--dsw-*` token。
- **test(theme)**: 新增 `test/client-theme-tokens.test.mjs`（6 项）：逐个校验插件引用的每个 `--dsw-*` token 都存在于按 DSH 0.2.0-rc.2 主题 token 表固化的白名单中（杜绝再次凭空发明 token）、插件从不重定义 DSH token、浅/深色分支被限制在允许的两处、不存在任何主题插件检测/枚举/私有变量读取、15 类 UI 语义各自引用对应 token、以及弹窗透明度设置（名称/默认值/范围/存储键/color-mix 结构）未被改动。同步更新 6 个原有 static guard，使它们校验新的等价实现而非旧的硬编码字符串。
- **fix(ui)**: 修复弹窗内 tooltip 被弹窗自身遮住的问题（会话管理窗口标题栏的 GitHub / npm / 关闭图标，以及面板内所有带提示的按钮）：
  - 根因：插件通过 DSH 的 `Tooltip` primitive（`renderTip`）渲染提示，而该气泡的 z-index 是**写死的**（内联 100、portal 到 body 时 1100），且不转发 `className`，插件无法单独抬高它；同时插件把面板设为 `z-index:9999`、portal 根节点设为 `99999`，因此任何插件界面都会盖住 1100 档的提示气泡。
  - 修复：把插件的两个文档级图层收进 DSH 自己的层级区间——面板 `9999 → 1020`，`#dsh-session-manager-overlay-root` `99999 → 1050`（CSS 与运行时内联值同步）。DSH 的层级为 `1000`（模态遮罩/全屏遮罩）与 `1100`（浮层：菜单、popover、对话框、tooltip），插件保持在 `1000..1100` 之间，因此提示与 DSH 浮层都能正常压在插件界面之上，而插件界面仍在 DSH 页面内容与遮罩之上。
  - portal 根节点内部各对话框的静态 z-index（确认 10000 / 迁移 10001 / 批量 10002 / 更新 10010 / 标记 100002+）与 `nextDialogZ()` 计数器都在该 stacking context 内部解析，取值本身不参与与 DSH 的层级竞争，故未改动，仅在代码与注释中固化层级契约。
- **test(ui)**: 新增层级回归守卫：断言 overlay root 与面板的 z-index 严格位于 DSH `1000..1100` 区间、面板低于 overlay root、内联值与 CSS 一致、提示仍走 DSH primitive + body portal；并在代码注释中固化「不要把插件图层抬到 1100 以上」的契约（测试总数 364）。
- **docs**: 明确验证范围——自 0.6.3 起本插件**仅在官方 DSH Desktop 客户端上进行验证**，Web UI 与本插件共用同一套 Host / 客户端代码但不再纳入验证范围。中英文 README 的「简介」与「兼容性」章节均已注明。

## 0.6.2 — 2026-10-02

- **fix(ui)**: 修复删除当前打开的会话后未自动跳转的问题：删除当前会话时显式调用 `ctx.uiWorkspace.clearMain()` 并回退触发新建会话，使界面正确跳转到新建会话欢迎视图，与会话归档行为保持一致。
- **fix(css)**: 修复无作用域全局样式覆盖宿主组件的缺陷（Issue #21）：移除未带前缀的全局规则选择器 `[role=tooltip]`, `.bubble`, `[class*=bubble]`, `.tooltip`，仅保留插件作用域 `.sm-tooltip`，避免给 DSH 官方消息气泡强加 1px 边框；将 tooltip 浮层 z-index 调降回官方 Toast 档位（1100）。
- **fix(ui)**: 优化顶部标题栏动作按钮排列与显示（归档按钮置于首位、图标垂直居中对齐、紧凑折叠菜单定位保持跟随）。
- **feat(update)**: add self-update checking and installation workflow:
  - Header 🐋 (Whale) icon button: checks for updates against the npm registry with indicator badge / red dot notification when a new version is released.
  - Update Dialog (`UpdateDialog`): modal overlay displaying current and latest versions, check progress, and one-click update via the DSH Plugin Manager `installBundle()`.
  - Update state management (`UpdateStore`): unified state machine (`idle`, `checking`, `available`, `updating`, `done`, `error`) with development overrides (`window.__DSH_SM_TEST_UPDATE__`).
  - Host update endpoints: `GET /session-manager/api/update/check` and `POST /session-manager/api/update/install`.
- **feat(settings)**: add Settings Card (`SessionManagerSettingsCard`) registered in DSH Settings under `settings.plugin.item` (`key: "dsh-session-manager"`):
  - Displays current version, latest version, inline check/update buttons, auto-check for updates toggle, and GitHub repository link.
  - **Install Source (Registry)**: add a registry source dropdown allowing users to select between **npm official registry** (`registry.npmjs.org`, default) and **China mainland mirror** (`registry.npmmirror.com`). Both check and install requests flow directly through the selected registry and the preference is persisted in `localStorage`.
- **feat(ui)**: responsive Header layout enhancements:
  - Header actions use Container Queries (`@container (max-width: 720px)` and `@container (max-width: 520px)`): automatically transitions between full labels, 32×32 icon-only compact mode, and secondary action overflow menu (`⋯`).
  - Surface buttons: `.sm-headerBtn` styled with opaque background tokens for consistent visibility across light/dark themes.
  - Danger button: unified red text/border resting state and filled red hover state.
- **fix(ui)**: overlay root, stacking context, and footer fixes:
  - Dedicated Overlay Root (`#dsh-session-manager-overlay-root`) ensures dialogs break out of ancestor stacking contexts (fixing issue #19).
  - Dynamic z-index layering (`nextDialogZ()`) ensures dialogs stack properly above panels and other overlays.
  - Footer action (`FooterAction`): renders directly as native buttons in wide/rail modes, avoiding double container wrappers and layout overflow (fixing issue #20).
- **test**: comprehensive test suite expansion: added coverage for semver comparisons, UpdateStore state machine, UpdateDialog, Settings Card, responsive header layout, registry source switching, Host update endpoints, delete-current-session navigation and regression guards (338 tests total).

## 0.5.4 — 2026-09-30

- **docs**: update project description and metadata to reflect official Web UI and Desktop app support; clarify client synchronization, install profiles, and runtime requirements.

## 0.5.3 — 2026-09-26

- **fix**: issue #17.2 (panel `MoveDialog` now forwards `t` so labels render translated) and issue #17.4 (row Open unarchives archived sessions first).

- **fix**: issue #18 — `moveSession` stamps `header.version` from the target filename so v4-named artifacts don't carry stale v0 headers (which broke DSH startup's `listArtifacts`).

- **fix**: dialog descriptions (`confirm.move.desc`, `confirm.delete.desc`) show only the friendly `displayTitle`, never the raw id. The title-bar lookup is resolved once per render via IIFE — an earlier attempt invoked `useSessions()` inside an event handler, which crashed the slot framework's `useSyncExternalStore` subscriber and let `SlotErrorBoundary` replace the whole `conversation.session.header.actions` slot with `<div data-slot-error="…" />`, taking every title-bar button down.

- **fix**: drop UTF-8 BOM from `package.json` (`JSON.parse` was rejecting it and surfacing the plugin as "all components disabled").

- **chore**: remove leftover `TEMP DEBUG` block in `lib/index.js` (issue #18 debugging residue that spammed the log every 2 s).

- **test**: regression guard added in `test/issue-17-static-guards.test.mjs`; existing `test/issue-18-move-version.test.mjs` covers #18.

## 0.5.2 — 2026-09-23

- **fix(bulk management)**: add a missing entry-point for batch operations. The previous build gated the row checkboxes and `BulkActionBar` behind `selectedIds.size > 0`, so neither was ever reachable from the UI. A new **Select** toggle in the panel header now reveals the row checkboxes and the bulk action bar; toggling it a second time clears the selection and exits selection mode. Selection-mode state is also reset whenever the panel closes.

- **fix(bulk management)**: the SessionManagerPanel had a duplicated `return` statement above the bulk-dialog declarations (`bulkPreviewDialog`, `bulkProgressDialog`, `bulkResultDialog`, `bulkTagDialog`, `bulkPriorityDialog`, `bulkMoveDialog`, `bulkPresetDialog`). The early return made every bulk dialog unreachable, so the user never saw the confirmation preview, progress bar, or per-id success / failed / skipped result dialog. The duplicate return has been removed; the panel now keeps every dialog declaration live and renders them all in the final Fragment.

- **feat(bulk management)**: add the **Migrate preset…** button to the bulk action bar. Selecting rows and clicking the new button opens a preset picker (sourced from `/preset-scan`) and, on confirm, runs the `preset-migrate` action against every selected session through the existing `/batch` endpoint. Sessions already on the chosen preset are reported as skipped in the result dialog; failed sessions can be retried individually.

- **fix(host /batch)**: the `/session-manager/api/batch` host handler had four regressions that were hidden by the bulk-dialog UI bug fixed in the same release:

  1. **archive** called `ctx.workspaces.archiveSession(sessionId)` directly from the per-request dispatch; Cordis rejected it with `cannot get property 'workspaces' without inject`. The host now exposes an `archiveSession` helper that mirrors `unarchiveSession` and updates `workspaceRegistry.archivedSessionIds` atomically.

  2. **favorite / review / set-priority / add-tags / remove-tags** threw `annotations is not a function` on the first id because the original `runBatchAction` signature destructured `annotations` from its parameter object and callers did not pass it. `runBatchAction` now resolves the annotation accessor from the surrounding closure so it can never again be silently `undefined`.

  3. **unfavorite / unreview** were not in the `BATCH_ACTIONS` set and were rejected with `action not supported: unfavorite`. Both are now first-class annotation actions; `annotationPatchFromBatchAction` maps them to `{ favorite: false }` / `{ reviewLater: false }`.

  4. the `BATCH_ACTIONS` set, the annotation action set inside `runBatchAction`, and `annotationPatchFromBatchAction` have been kept in sync.

  As a hygiene cleanup, an orphan copy of the same handler that was left inside the file header JSDoc (between `/**` and the real `* @dsh-session-manager` description) has been removed. **Important:** if any of these errors were seen before this fix, hard-refresh DSH (Ctrl+Shift+R) so the cached plugin bundle is replaced with the new one.

- **fix(bulk dialog positioning)**: the bulk preview / progress / result / tag-input / priority / move / preset-migrate dialogs had only a `z-index` rule on `.sm-bulkDialog.sm-nativeDialogLayer` and inherited the default `position: static`, so they rendered in normal document flow at the bottom of the panel (below the row list). They now reuse the same fixed-position `inset: calc(50vh - 90px) auto auto calc(50vw + 308px)` as `.sm-confirmDialog.sm-nativeDialogLayer` and pop up to the right of the panel, matching every other per-row dialog.

- **fix(bulk dialog dark mode)**: every `[data-sm-theme=dark]` override that previously covered `.sm-panelDialog` / `.sm-confirmDialog` / `.sm-migrateDialog` now also covers `.sm-bulkDialog`. Without this, dark mode rendered the bulk dialog body, header, footer, list, result list, progress bar and progress fill in default white-on-white, making the dialog text invisible.

- **fix(footer)**: FooterAction now reads `props.wide` from `SidebarFooterActionOwnerProps` and renders differently for collapsed (`scope: 'root'` rail, 36x36 icon-only button) vs expanded (full-width row, icon + label, left-aligned) sidebar (DSH 0.1.6+ `sidebar.footer.action` slot contract).
- **test(bulk management)**: add client-side coverage for issue #13:     est/client-bulk-selection.test.mjs (static guards on the selection-state hooks),     est/client-bulk-actions.test.mjs (static guards on the BulkActionBar wiring + locale coverage),     est/client-bulk-runbatch.test.mjs (unit coverage for the runBatch wrapper via runInNewContext with a stubbed fetch), and     est/client-bulk-static-guards.test.mjs (cross-cutting structural invariants -- namespace ownership, panel dialog sibling layout, fan-out refresh, host/client action vocabulary). Total tests: 225 (188 pre-existing + 37 new).
- **feat(bulk management)**: add multi-select checkboxes to session rows plus a sticky bulk action bar with archive, unarchive, favorite, unfavorite, mark-for-review, clear-review, add-tags, clear-tags, set-priority, move-to-workspace, and delete actions. Destructive actions run through a BatchPreviewDialog with per-id skip/fail grouping; non-destructive ones fire immediately. Progress, success/failure counts, per-item error reasons, and a one-click **Retry failed** re-arm the failed ids back into the selection. The /batch endpoint is reused so per-id errors surface as partial failures without aborting the batch. Bulk state is reset when the panel closes or the filter excludes a selected row.
- **feat(sessions)**: `ARTIFACT_NAMES` now lists `session.v4.jsonl.zstd` first so DSH 0.1.7 V4-default session artifacts are picked up by the list-snapshot reader. Existing V3/V2/V1 files remain readable; the reader is version-agnostic and parses the header JSON regardless of declared version, so no per-version code paths are required.

## 0.5.1 — 2026-09-18

- **feat(annotations)**: add favorites, manual review flags, tags, multiline notes and priority (1 highest → 5 lowest, default **3 Normal**) to the manager and title bar. Add annotation search/filtering and priority sorting. Persist separately from session history with atomic writes, an inter-process lock, strict limits, conflict detection and deletion cleanup; synchronize browser surfaces and preserve unsaved drafts on failure.

- **feat(annotations)**: add an opt-in AI-assisted workflow in the annotation editor. A **Copy Prompt** button copies a strict-JSON prompt (Chinese or English, matched to the UI locale) to the clipboard for the user to paste into the current conversation. An **Import** button reads the clipboard, extracts the first JSON object (tolerating Markdown fences, conversational wrappers, smart quotes, stray backslashes and a leading BOM), validates tags/note/priority against the same limits, and populates the editor fields. Oversized notes are truncated and flagged in the status message; invalid tags/priority are dropped with reasons. Importing into a dirty draft triggers a confirm. Both buttons stay out of the conversation history — the plugin never calls the model directly. The parser is also exported as `parseClipboardAnnotation` from `lib/clipboard-parser.js` for tests and potential server-side reuse.

- **feat(annotations)**: add inline clear buttons inside the **Tags** and **Note** fields of the annotation editor. Each button only appears while the corresponding field has content and clears it without touching the other controls. Both buttons are disabled while a save is in flight and respect the existing Escape / IME handling.

- **feat(annotations)**: redesign the annotation editor layout. Favorite and review flags stack vertically on the left; priority and its small help text occupy the right column. The **Tags**, **Note**, and AI **paste** textareas all share the same `sm-noteInput` style and `rows: 3` height (60px min-height), so the three input boxes line up visually. The "{count} / 2000 chars" note counter and the privacy hint are removed; help text is moved into each input's `placeholder`. In the AI paste block the two buttons now sit **above** the paste textarea (Import on the left, Copy Prompt on the right) so the editor footer stays consistent. The priority label now uses the same 13px font as the favorite / review checkboxes.

- **feat(annotations)**: remove the "Not set" priority option. Priority is always one of 1–5, and the default is **3 (Normal)**; legacy data with `priority: null` is normalized to 3 in display, sort and filter, so there is no longer a separate "always-sorts-last" state. The priority filter dropdown, row badges and header badge all reflect the unified 1–5 scale; AI-returned `"priority": null` is also normalized to 3 by the clipboard parser. The priority help text now reads "1 is highest, 5 is lowest. Default is 3 (Normal)."

- **fix(annotations)**: in the manager's row badges, P1–P5 now always render (legacy `null` renders as P3) so the priority column is visually consistent across all rows instead of being absent for unset entries. The header shortcut button likewise always shows the current P-number badge.

- **fix(annotations)**: the AI copy/paste prompt now follows the active UI language. The dialog detects the language from the t() function (probing `marks.favorite`) instead of relying on `window.__smActiveLanguage`, which was never set; the prompt button writes Chinese under a Chinese UI and English under an English UI even when the global flag is missing.

- **fix(annotations)**: the AI paste workflow's error message now appends the actual `JSON.parse` error position from each recovery attempt (raw / fix quotes & backslashes / scan object / scan object + fix), so users can see exactly which character broke parsing when the auto-repair still fails. The parser also strips a leading UTF-8 BOM, normalizes smart quotes, and repairs stray single backslashes inside string values.

- **feat(annotations)**: tag input accepts both English `,` and Chinese `，` as separators (regex `/[,，\n]/`), trims whitespace around each tag, drops empty entries, and merges case-insensitive duplicates — so AI outputs in either locale parse cleanly without the user having to re-type the separator.

- **feat(manager)**: add case-insensitive title/session-ID search, workspace/ungrouped filtering, four time-order modes, matching/total counts and reset controls; combine them with the existing archive filter. Creation times are supplied from cached host headers when DSH summaries omit them, without reading logs. Add workspace load/retry handling, stale-request cancellation, narrow-screen layout, IME-safe Escape handling and real-bundle interaction tests.

- **fix(safety)**: validate session IDs, directory containment, symlinks/junctions and artifact identity before deletion or file rewrites; reject an already occupied move destination.
- **fix(persistence)**: separate backup/publication/rollback phases; never delete the original after a failed backup rename. Preserve recovery files and report their paths if rollback fails, and clean uncommitted temporary files after write failures.
- **fix(zstd)**: use structural frame decoding on every rewrite path and reject corrupt/torn logs instead of publishing a decoded prefix.
- **fix(startup)**: distinguish incomplete scans from empty libraries; normalize snapshot headers, preserve live/concurrently attached sessions, and reconcile using a fresh immutable registry state.
- **perf**: read only orphan artifact headers during enumeration and avoid duplicate full readRaw decoding for mutations.
- **chore(test)**: test the real plugin routes instead of a copied move implementation; cover traversal, junctions, corruption, rollback failures, concurrent mutations, and startup read failures. Run module imports, tests, and package checks on Windows/Linux with Node 22.15.0/24; declare the Zstd-capable Node requirement.

## 0.4.11 — 2026-09-14

- **chore(client)**: drop `@deepseek-ai/dsh-client-runtime` from `dsh.client.inject`. The package is no longer shipped by DSH 0.1.5-rc.2 / 0.1.2-alpha or newer (its client-bootstrap role was folded into `@deepseek-ai/dsh-client-store`). This plugin's bundle never required it, so removing the stale reference is a no-op at runtime and only cleans up the published manifest (#12).

## 0.4.10 — 2026-09-13

- **fix(move)**: cross-workspace move no longer breaks the live JSONL writer. The DSH JSONL backend keeps one `JsonlSessionHandle` per session id in an in-process tracker; its `header.cwd` is captured at construction, and the api-gateway's `session/event` router writes through that handle, so a session whose header was rewritten in memory but whose writer was still pointing at the pre-move directory started throwing `ENOENT` on the first new message (issue #8). `moveSession` now mutates the live writer's `header` in place so its persist path flips to the target `cwd` while the same handle, queue, cursor, and lease are retained; the Agent's owned handle therefore stays consistent with the tracker entry, and no `session/disposed` is fabricated. If the runtime does not expose a rebindable writer (older DSH builds or a custom backend), the move now refuses up front with a clear message instead of silently leaving the live session writing to a deleted path. Adds `test/issue-8-move-enoent.test.mjs` (post-move writer identity stability + a "no-fix ENOENT" regression guard) and `test/issue-8-repro/` (a standalone reproducer script).

- **chore**: bump version to 0.4.10.

## 0.4.9 — 2026-09-12

- **fix(ui)**: Session manager panel and inner dialogs (Delete / Move /
  Migrate confirmations) now close on Esc regardless of focus
  position (issue #7). The original layer-bound onKeyDown was
  unreachable because the sidebar toggle / row button that opened
  each modal stayed focused -- focus is a sibling of the layer,
  not a descendant, so keydown never bubbles into the modal subtree.
  ConfirmDialog / MoveDialog are also used by the title-bar Delete
  / Move actions, so this fix applies there too.

- **fix(ui)**: Modals now close ONLY via Esc or their explicit close
  buttons. The original 0.4.7 behavior (close on backdrop click)
  was removed per user feedback -- a stray click outside the panel
  was dismissing it accidentally. Every `.sm-nativeDialogBackdrop`
  `onMouseDown` handler is gone; the dim backdrop itself is also
  gone so opening a modal never darkens the page (sidebar or
  content area).

- **refactor(ui)**: Esc handling moved from per-layer `onKeyDown`
  to a `window`-level `keydown` listener via `useEffect` on every
  modal. A `useRef` lets the listener see the latest state values
  without re-subscribing on every render. The panel listener
  returns early when any inner dialog is open so the child
  dialog's listener gets the first shot at Esc.

- **fix(ui)**: After a keyboard-driven close (Esc), the originally
  focused trigger button (sidebar toggle / row button / Cancel
  button) no longer leaves a lingering `:focus-visible` ring. The
  four Esc handlers `blur()` the active element after the close
  call. Mouse-driven closes are not affected -- `:focus-visible`
  only activates for keyboard-acquired focus.

- **fix(ui)**: ConfirmDialog no longer listens for Enter at the
  layer level. The previous handler raced with the focused Cancel
  button's native Enter handler -- both fired (`onCancel` +
  `onConfirm`). Enter now lives only on the focused button.

- **cleanup(ui)**: Remove three dead `<section>` `ref={(el) =>
  el.focus()}` callbacks (sections have no `tabindex` and are
  not focusable, so the focus calls were silent no-ops). Also
  remove the now-unused `onPanelKey` callback and `tabIndex: -1`
  attributes on the modal layers. The `.sm-nativeDialogBackdrop`
  divs are no longer rendered at all -- they had no behavior left
  after removing the click-to-close.

- **chore**: bump version to 0.4.9.

## 0.4.7 — 2026-09-10

- **fix(disk scan)**: include `session.v3.jsonl.zstd` in the on-disk
  filename list used by readSessionArtifact() and listSessionHeaders().
  DSH 0.1.5-rc.1's persistence backend writes generation v3 artifacts at
  that filename; the 0.4.6 release scanned only v2/plaintext names, so
  fresh sessions appeared to have no disk record and the move/migrate
  endpoints failed with "session has no artifact".

- **chore**: bump version to 0.4.7.


## 0.4.6 — 2026-09-05

- **fix(persistence)**: read all concatenated Zstandard frames in a session
  artifact. DSH writes one frame for the header and additional frames for
  event batches; reading only the first frame made sessions appear to lose
  their event history after refresh.
- **fix(move)**: preserve the session generation/header version when
  re-homing an artifact, and synchronize the live session, persistence
  coordinator, registry indexes, and workspace accounting after a move.
  This avoids stale-path `ENOENT` failures and v2/v0 filename/header
  mismatches on the next DSH startup.
- **fix(preset migration)**: fall back to an id-based artifact scan when a
  persistence locate result points at a stale path, and mirror cold-path
  migrations into the live session projection.
- **fix(client)**: stop calling the removed/unavailable
  `noteAgentPreset` client method; refresh the session projection instead.
- **recovery**: add `scripts/heal-v2-sessions.ps1` for the DSH 0.1.1-rc.2
  boot-time quirk where `session.v2.jsonl.zstd` contains a `version: 0`
  header. Run it before starting DSH; this repair must happen before DSH's
  workspace initialization, which is earlier than user plugin `apply()`.

- **docs**: bump version to 0.4.6.
## 0.4.5 — 2026-09-05

- **fix(move)**: keep the live session and agent in place during a cross-workspace
  move. The previous code tore down the live agent/session, moved the file, then
  called `ctx.agents.resume` to re-create the agent. DSH's `agent/status` event
  is only emitted on phase changes, so a freshly resumed agent never told the
  client it was now idle, leaving the sidebar's model selector and send button
  disabled ("session unavailable") until a manual browser refresh. The new path flushes
  pending events to disk, updates the in-memory session header + coordinator
  state + workspace accounting in place, and atomically renames the artifact,
  so the agent's UI keeps showing the same in-memory session with no client
  re-init.
- **fix(preset migration)**: drop the over-strict `persistence.readRaw` /
  `persistence.list` precondition that caused the
  `/session-manager/api/preset-scan` endpoint to fail with
  `current persistence backend does not support readRaw/list` on a default DSH
  build. The actual `JsonlSessionPersistence` backend exposes both methods, so
  the precondition is replaced with a try/catch around `listSessionHeaders` that
  converts any missing-method failure into a useful
  `failed to enumerate sessions: <detail>` message.
- **chore**: remove the now-unused `quietLive` / `releaseLiveSession` helpers
  and squash the per-route indentation noise around `/move` and `/workspaces`.

## 0.4.4 — 2026-09-03

- **docs**: rename the English README wording from `conversation` to `session` to align with the plugin name (`dsh-session-manager`), the Chinese README (`README.zh.md`), the DSH host APIs, and the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry entry.
- **chore**: rewrite `package.json` `description` to use `Session manager` / `sessions` for the same alignment, and bump the version to `0.4.4`.
- **chore(repo)**: update the GitHub repository description to match.

## 0.4.3 — 2026-09-03

- **docs**: add the [Awesome DSH Plugin](https://awesome-dsh-plugin.com) badge to `README.md` / `README.zh.md` so the repo surfaces its curated registry membership.

## 0.4.2 — 2026-09-03

- **feat(theme)**: dialogs now auto-follow DSH''s dark/light theme (`data-ds-dark-theme` / ` `code-scheme` / `data-theme`) via a single `data-sm-theme` attribute and scoped CSS variables, with inline `background` / `color` / `border-color` applied to each dialog root so they stay opaque regardless of how DSH resolves its own tokens. The previous manual light/dark toggle button is removed.
- **docs**: aligned bilingual README structure, dropped the obsolete "no bulk migration" wording, and added an Acknowledgments section that thanks the users and the contributors filing issues and opening PRs. Listed [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) as install sources.
- **chore**: rewrote `package.json` `description` to match the new English summary.

## 0.4.1 — 2026-08-28

- **fix(ui)**: keep the title-bar **Delete conversation** button readable on hover with a red background, white text, and red border; remove the unused legacy danger-button rules.

## 0.4.0 — 2026-08-28

- **feat(session preset migration)**: replaces the former bulk workflow with a
  per-conversation **Migrate preset** action in Session manager. It resolves the
  effective preset from the latest `agent-preset/selected` event or, when absent,
  the session header, then safely updates that one conversation.
- **fix(lifecycle)**: moving a conversation or migrating its preset now retires stale
  live agents and persistence owners before refresh. This prevents resume failures
  such as `already has a live persistence owner`.
- **fix(move)**: refreshes session and workspace state immediately and once more after
  the host event race, so a moved conversation reappears in its target workspace
  without a manual browser refresh.
- **ui**: finalizes header actions and Session manager dialogs: red delete actions,
  per-row preset migration, consistent dialog placement, readable hover states, and
  a close button beside the manager title.
- **docs**: refreshes bilingual documentation and npm metadata for the single-session
  preset migration workflow.

## 0.3.0 — 2026-08-27

- **feat(preset migration)**: introduced preset migration support for conversations
  whose configured Agent preset was renamed or removed.
- **feat(move)**: added workspace move handling and client-side workspace refreshes.

## 0.2.1 — 2026-08-26

- **fix(move)**: reimplemented cross-workspace moves so the session artifact, stored
  `cwd`, and workspace accounting are moved together while preserving history,
  title, archive state, and derived-session relationships.
- **feat(workspaces API)**: added the workspace projection endpoint used by the move UI.
- **guard**: reject subagent and transient blank-session placeholders for move actions.

## 0.2.0 — 2026-08-16

> ⚠️ The initial workspace-move implementation was superseded by 0.2.1.

- **feat(move)**: added the initial move-to-workspace UI and host endpoints.

## 0.1.2 — 2026-08-16

- **docs**: synchronized package metadata and bilingual README files for publication.

## 0.1.1 — 2026-08-16

- **fix(panel)**: hide transient blank-session placeholders from the manager panel.
- **test**: added the host API smoke test.
- **ci**: added syntax and package-content verification.

## 0.1.0 — 2026-08-16

- **feat**: initial session deletion with confirmation, archive management, and the
  Session manager panel.
