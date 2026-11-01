# DeepSeek Harness 文件夹资源管理器插件 · 方案文档

> 状态：M1 已实现并通过验收 · 目标 DSH 版本：Web/Desktop 0.2.1-rc.5 · 编写日期：2026-11-01
> 仓库：<https://github.com/wx-98/DSH-folder>

## 1. 背景与目标

DSH Web/Desktop GUI 目前只提供**只读**的文件浏览能力：右侧栏内置 `files` 标签（`@deepseek-ai/dsh-client-ui-sidebar-files`）以会话工作目录为单根、逐层列出目录，点击文件打开预览。它没有任何文件管理操作：没有右键菜单、重命名、新建、删除、复制路径、复制/粘贴、拖拽、多选（该包 README 自述 "Listing only. No search, artifact filter, drag-and-drop, rename, context menu, or current-file highlight."）。

同时，DSH 的数据面也刻意保持只读：

- `@deepseek-ai/dsh-api-workspace-files` 只暴露 `stat / read / readBytes / list / changes`，README 明确 "The service exposes no mutation operation"；
- `ctx.fs` 契约只有 `resolve / stat / readText / readBytes / listDir / watch / writeText / editText`，README 明确 "No delete, rename, or copy"；
- 内置文件树唯一的扩展槽是头部 `sidebar.right.tab.files.actions`（owner prop 为树根 `absolutePath`），**没有行级槽**，且插件规范禁止读取其他插件 DOM，因此无法在既有树上注入"行级右键菜单/内联重命名"。

**目标**：开发一个可安装的第三方 DSH 插件（bundle，含 Host 半边与 Client 半边），在 GUI 内提供类 VSCode 的文件夹资源管理器：选择一个本地文件夹后，以树形浏览，并支持复制路径、重命名、新建、删除、复制/粘贴等文件管理操作，同时保持 DSH 的主题、国际化与安全边界一致。

### 非目标（本变更不做）

- 文件内容编辑（沿用现有预览/外部编辑器能力）；
- 全文搜索、多根工作区、Git 集成；
- 废纸篓（trash）原生桥、拖拽移动、多选批量操作、外部变更实时监听（列入后续里程碑）。

## 2. 需求范围

### 2.1 本次变更（M1）范围

| 需求 | 说明 |
|---|---|
| 打开文件夹 | 新标签类型提供 "Open Folder…" 目录选择（Host 侧目录浏览路由），默认根为当前会话工作目录；记住上次打开的根 |
| 树形浏览 | 右侧栏新标签页；懒加载展开、目录优先排序、隐藏文件可见、失败/空目录行内提示、手动刷新 |
| 打开文件 | 单击文件 → 右侧栏文档预览 tab（`dsh-resource://file/session/<sessionId>/<path>`，支持工作区外绝对路径） |
| 复制路径 | 行级右键菜单：复制绝对路径、复制相对根路径；写系统剪贴板 + 轻提示 |
| 重命名 | 右键/F2 → 行内输入，Enter 提交、Esc 取消；冲突/非法名/权限错误给出明确提示 |
| 新建 | 在当前目录或选中目录右键：新建文件、新建文件夹 |
| 删除 | 右键/Delete：二次确认弹窗；本变更实现**永久删除**（废纸篓后续里程碑） |
| 复制/粘贴 | 应用内剪贴板：复制文件/目录后粘贴到目标目录，冲突（重名）时提供"重命名保留/跳过/覆盖"策略 |
| 外部打开 | 右键：在 Finder/资源管理器中显示（Host 原生命令路由）、用外部应用打开（复用现有 `session.openWorkspacePath` / `workspacePathApplications`） |
| 键盘 | 树焦点下 ↑/↓ 移动、→/← 展开折叠、Enter 打开、F2 重命名、Delete 删除、Cmd/Ctrl+C / V 复制粘贴、Esc 关闭菜单/弹窗 |
| 工程化 | 插件包可直接通过 GUI **Plugins → Add plugin → 本地绝对路径**安装；client 改动 HMR 生效，host 改动热重组/重启生效；提供文档与最小测试 |

### 2.2 后续里程碑

- **M2**：废纸篓（macOS Finder / Windows 回收站原生桥）、拖拽移动、多选批量操作、目录自动监听（Host SSE watch）。
- **M3**：搜索（Host glob/grep）、多根、外部编辑器偏好、面板内大目录虚拟滚动。

## 3. 现状调研结论（证据见 OpenSpec design.md 与 §9）

| 结论 | 依据 |
|---|---|
| 内置文件树只读、单根=session.cwd | `dsh-client-ui-sidebar-files` README "Known Limitations"；lib/client.js 仅 toggle/open/refresh |
| 内置文件树无行级扩展槽 | 其 body 注册只声明 `sidebar.right.tab.files.actions` 头部 list 子槽 |
| 数据面只读 | `dsh-api-workspace-files`、`dsh-fs` README 明文 |
| 第三方可注册新侧栏标签类型 | `ctx.sidebarRightTabs.register({id,kind,...})` + `ctx.slots.register({name:'sidebar.right.pane.tab',key:id})`，内置 guide 与新类型走同一公开路径 |
| 无法增强内置树行 | 无行级 slot；规范禁止读其他插件 DOM/样式 |
| 变更类能力需自建 Host 插件 | 推荐 `ctx.webServer.register` 路由 + `ctx.connection.requestRejection` 信任栅栏（`dsh-host-open-in-app` 为完整先例） |
| Reveal / Open With | Reveal 由插件 Host 原生命令路由实现；Open With 复用现有 `remote.session.workspacePathApplications` / `openWorkspacePath` / `canOpenWorkspacePath` |
| 安装/调试路径可行 | 插件包 = `dsh.bundle.patch` + Host `index.js` + `exports["./client"]` + `dsh.client`；GUI 插件管理支持本地绝对路径安装；client HMR 按文件 mtime 热替换；Host 侧 linked 包变更经 HMR 重组 |

## 4. 插件形态与工程结构

插件是一个**双面 bundle 包**，GitHub 仓库根目录即插件包根目录（含 `package.json` 的目录）：

```text
DSH-folder/
├── package.json          # @local/dsh-folder-explorer；exports "." / "./client" / locale / icon
├── cordis.patch.yml      # - insert: [{ id: folder-explorer, name: '@local/dsh-folder-explorer' }]
├── index.js              # Host 半边：apply(ctx) 注册 /folder-explorer/* 路由
├── lib/ops.js            # 纯函数：路径校验、list/stat/create/rename/delete/copy/move/reveal
├── client.js             # Client 半边：window.__ModuleLoader__.load({ id, factory(require) { ... } })
├── icon.svg
├── locale/{en,zh}.json   # 插件管理页展示的 meta.title / meta.description
├── docs/folder-explorer-plugin.md   # 本文档
├── LICENSE
└── README.md                 # 安装、使用与已知限制
```

> 单元测试与 OpenSpec 规划产物只保留在本地开发工作区（`.gitignore` 已排除），不随公开仓库发布。

`package.json` 关键字段：

```json
{
  "name": "@local/dsh-folder-explorer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "lib/ops.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-shortcuts"
      ]
    }
  }
}
```

- 无构建步骤、无运行时依赖：Host 只用 `node:fs/promises` / `node:path`；Client 只用模块表基线 `react` 与 `react/jsx-runtime`（不引用 `@deepseek-ai/dsh-client-ui-primitives` 等 Client 包，遵守插件规范）。
- 一个 Loader 行同时承载两半边：Host 行走 `index.js` 的 `apply`，Client 半边由 `dsh.client` 声明经 Client Modules 加载。

## 5. 架构设计

### 5.1 运行位置

```text
Browser (DSH Web GUI)                                   Host (Electron 主进程 spawn 的 Node)
┌───────────────────────────────────────────┐          ┌────────────────────────────────────────────┐
│ client.js (UI plugin)                     │  fetch   │ index.js (Host plugin)                     │
│  · sidebarRightTabs.register(explorer)    │ ───────▶ │  · ctx.webServer.register(                │
│  · slots.register(sidebar.right.pane.tab) │  /folder-  │      /folder-explorer/{list,create,        │
│  · 树/右键菜单/行内重命名/对话框/剪贴板   │  explorer  │      rename,delete,copy,move,stat})        │
│  · 预览跳转 tab.actions.openResource      │            │  · ctx.connection.requestRejection 信任栅栏 │
│  · reveal / open-with → remote.session    │            │  · node:fs/promises + lib/ops.js           │
└───────────────────────────────────────────┘            └────────────────────────────────────────────┘
```

- **读与写统一走 Host 路由**（不用 `remote.workspaceFiles`，因为它被限制在会话 workspace，无法支持"打开任意文件夹"）。文件预览仍复用内置资源体系：客户端自己拼 `dsh-resource://file/session/<sessionId>/<abs path>` 地址，由预览 tab 的 `file` Resource 读取（文件读允许工作区外绝对路径）。
- **不新增 typert Remote namespace**：第三方插件在 build 期无法接入 `api-remotes` 的生成式 assembly；Host 路由是官方示例（open-in-app）验证过的最小摩擦路径。

### 5.2 安全边界

1. **信任栅栏**：每个路由先 `ctx.connection.requestRejection(req)`，与 open-in-app 完全一致（Host/Origin 防 DNS rebinding + 浏览器登录令牌），未授权请求直接 403/401。
2. **路径校验**：请求体只接受绝对路径；拒绝 NUL/空/相对路径；`path.resolve` 规范化后做**根包含校验**（root 由客户端随请求携带，必须为绝对存在的目录）；操作前对父目录与目标做 `realpath`，防 `..` 与符号链接逃逸；重命名/删除不跟随最终符号链接（`lstat` 判定），对符号链接本身操作。
3. **危险操作**：删除必须带确认标记 `confirm: true`（客户端先行二次确认，Host 再校验）；复制/移动目标若包含源（目录复制进自身）直接拒绝。
4. **无模型可见副作用**：文件操作不写 session 事件、不触发 Agent；宿主侧记录结构化操作日志（可选）。
5. **与 Agent 沙箱的关系**：本插件是**用户手势驱动的 GUI 文件管理器**，与 DSH 现有 GUI 目录选择器（可在任意目录建目录）同级，不套用 Agent 的 `sandboxPolicy`；Agent 的文件工具仍受自身沙箱约束。文档中明确该边界。

### 5.3 宿主 HTTP API 契约

统一前缀 `/folder-explorer`，均要求已认证连接；请求 `application/json`（body ≤ 64 KiB），响应 UTF-8 JSON。

| 方法 | 路径 | 请求 | 成功响应 | 说明 |
|---|---|---|---|---|
| GET | `/folder-explorer/browse` | query: `path`（可选，缺省=用户主目录） | `{ ok, path, parent, entries:[{name,type:'file'\|'directory'\|'other'}], truncated }` | **只读**任意目录列举，供"打开文件夹"对话框使用（与 DSH 目录选择器同级，不做根包含） |
| GET | `/folder-explorer/list` | query: `root`, `path` | `{ ok:true, path, entries:[{name,type:'file'\|'directory'\|'other',size?,mtime?}], truncated }` | 单层列表；目录优先排序；默认上限 2000 条 |
| GET | `/folder-explorer/stat` | query: `root`, `path` | `{ ok:true, stat:{name,type,size,mtime,mode} }` | 元数据；用于冲突检测/刷新单行 |
| POST | `/folder-explorer/create` | `{ root, parent, name, kind:'file'\|'directory' }` | `{ ok:true, path }` | 已存在 → 409 `already-exists` |
| POST | `/folder-explorer/rename` | `{ root, path, newName }` | `{ ok:true, path }` | 仅同目录改名；非法名/已存在给出错误码 |
| POST | `/folder-explorer/delete` | `{ root, paths:[...], confirm:true }` | `{ ok:true, deleted:[...] }` | 永久删除（M1）；失败项逐条返回 |
| POST | `/folder-explorer/copy` | `{ root, sources:[...], targetDir, conflict:'rename'\|'skip'\|'overwrite' }` | `{ ok:true, results:[{source,path,status}] }` | 文件+目录递归；粘贴目标位于源内拒绝 |
| POST | `/folder-explorer/move` | `{ root, sources:[...], targetDir, conflict }` | 同上 | 优先 `rename`，`EXDEV` 降级 `copy+delete` |
| POST | `/folder-explorer/reveal` | `{ root, path }` | `{ ok:true }` | 平台原生命令在 Finder/资源管理器中显示（macOS `open -R`、Windows `explorer /select,`、Linux `xdg-open` 父目录） |

错误响应统一：`{ ok:false, code, message, details? }`。HTTP 状态映射：`bad-request|invalid-name|invalid-path` → 400；`outside-root|forbidden` → 403；`not-found` → 404；`already-exists` → 409；`internal|io-error` → 500。客户端按 `code` 分支，不解析 message。

实现补充（apply 阶段确定）：POST body 采用**严格字段白名单**（多余字段 → 400 `bad-request`）；405/413/415 为传输级状态，payload code 统一 `bad-request`；`entries[].mtime` 为 epoch 毫秒 number、`size` 仅普通文件；符号链接在列表中 `type:"other"`（重命名/删除只作用于链接本身）；`copy/move` 成功项 status 为 `copied|skipped|renamed`，`overwrite` 先删除同名目标再复制；变更请求排队执行（不返回 `busy`）；`delete` 的 `confirm` 必须是布尔 `true`。

### 5.4 客户端结构（单文件 client.js）

模块表只允许一个 bundle 模块节点（扁平模块图），因此 `client.js` 自包含：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-folder-explorer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'folderExplorer'

    const inject = ['sessions','slots','locale','sidebarRightTabs','sidebarRight','shortcuts','remote','remote.session','layout']

    function apply(ctx) {
      // 1) 注册 tab 类型（kind: 'folder-explorer'，guide 卡片）
      // 2) 注册 slot body：sidebar.right.pane.tab（key = 类型 id）
      // 3) 注册 slot title：sidebar.right.pane.tab.title
      // 4) 注册 locale 字典（zh/en）
      // 5) 注册可选命令/快捷键
    }
    return { inject, apply }
  },
})
```

- Body 由 slots 框架注入会话作用域 props：`sessionId`、`useSessions`、`useTabInfo`、`useLocale` 等；通过 `useSessions(s => s.byId[sessionId]?.cwd)` 取默认根，通过 `useTabInfo().tab.actions.openResource(address)` 打开预览。
- 状态：根路径持久化到 `localStorage['dsh.folder-explorer.root.<sessionId?>']`（上次打开）；展开集合/选中行/剪贴板为组件内 React state（切换标签会重置，M1 接受；M2 可迁到模块级 store）。
- 样式：组件内 `<style>` 注入，类名前缀 `dfe-`，只用主题变量 `--dsw-alias-*`；图标用内联 SVG，跟随主题。
- 交互：右键上下文菜单、行内重命名输入框、确认对话框、目录选择器（内联 Modal，复用树行样式）、轻提示（toast 区域）全部自绘。
- 复制路径：`navigator.clipboard.writeText`；失败时降级选中文本 + 提示。
- "显示位置"走 Host \`POST /folder-explorer/reveal\`（平台原生命令，先做 root 包含校验）；"用外部应用打开"复用 \`ctx.remote.session.workspacePathApplications({ path })\` + \`openWorkspacePath({ path, application })\`，宿主不可用或路径不可访问时隐藏/禁用入口并提示；自有的应用目录清单不在 M1 范围。

### 5.5 状态与错误模型

- 每层目录：`loading | ready(entries,truncated) | failed(code)`；失败行显示错误码的人类可读文案 + 重试。
- 操作后局部刷新：create/rename/delete/copy/move 成功后只重拉受影响目录，不重置整棵树。
- 冲突策略：`rename`（默认，生成 `name copy`/`name 2`）、`skip`、`overwrite`（仅文件复制，目录覆盖需确认）。
- 长操作（递归复制/删除）按钮进入 busy 态、禁用重复提交；Host 内变更操作串行化（单队列）避免交叉。

## 6. 交互清单（对标 VSCode）

| 能力 | M1 | 说明 |
|---|---|---|
| 打开文件夹 | ✅ | Open Folder…（Host 目录浏览）/ 使用当前会话目录 |
| 树形展开/折叠、文件预览 | ✅ | 懒加载；单击文件打开预览 |
| 右键菜单 | ✅ | 行级自建菜单 |
| 复制绝对/相对路径 | ✅ | 剪贴板 + toast |
| 重命名（内联） | ✅ | F2 / 菜单 |
| 新建文件/文件夹 | ✅ | 目标：当前目录或右键目录 |
| 删除 | ✅（永久，确认） | 废纸篓 M2 |
| 复制/粘贴 | ✅（应用内剪贴板） | 系统文件剪贴板 M2+ |
| Reveal / Open With | ✅ | Reveal 走 Host 路由；Open With 复用已有 session remote |
| 键盘导航/快捷键 | ✅（基础） | 树内键位 |
| 拖拽移动、多选 | ❌ M2 | |
| 外部变更自动刷新 | ❌ M2 | M1 手动刷新 + 操作后刷新 |
| 搜索、多根、Git 状态 | ❌ | |

## 7. 开发、安装与验证

### 7.1 安装（用户操作）

1. 打开 DSH Web GUI → 左侧 **Plugins** → **Add plugin**（Install a third-party plugin）→ 填入 Git 地址 `https://github.com/wx-98/DSH-folder.git`；
2. 安装完成后启用该 bundle 的 row；
3. 打开任意会话 → 右侧栏标签向导 → **Folder Explorer** 打开。

> 开发时也可以选择 **本地绝对路径** 安装 clone 后的目录：本地包以 linked 方式安装，修改即时生效，不复制文件。安装由 `@deepseek-ai/dsh-plugin-manager` 执行（profile：`~/.dsh/profiles/<profile>`）。

### 7.2 开发调试

- **Client 改动**：`client.js` 保存后，`@deepseek-ai/dsh-client-hmr` 按 mtime 检测重建产物并热替换插件（React 状态会重置），无需刷新页面。
- **Host 改动**：linked 包文件变化经 `@deepseek-ai/dsh-hmr` 的 profile 重组使插件重启；若未生效，在 Plugins 页关闭/开启该 bundle，或重启应用。
- **语法检查**：`node --check index.js lib/ops.js client.js`；
- **自动化测试**：单元测试、浏览器注册冒烟与 client↔host 契约测试保留在本地开发工作区（共 42 项，未随公开仓库发布）。
- **接口自测**：浏览器 DevTools Network 观察 `/folder-explorer/*` 响应；Host 日志看路由注册与错误。

### 7.3 验收清单

- [ ] 插件出现在 Plugins 页，标题/描述/图标正确（zh/en）；
- [ ] 右侧栏可打开 Folder Explorer 标签，默认根=会话目录；
- [ ] 打开任意文件夹、展开/折叠、点击文件打开预览；
- [ ] 右键菜单完整，复制两种路径内容正确；
- [ ] 重命名/新建文件/新建文件夹/删除/复制粘贴在含空格、中文、隐藏文件的目录可用；
- [ ] 错误路径（无权限/不存在/重名）提示可读且不崩溃；
- [ ] 深色/浅色主题下样式一致；键盘操作可用；Esc/焦点行为正确；
- [ ] 卸载插件后标签与入口消失，无残留。

## 8. 风险与备选

| 风险 | 影响 | 缓解 |
|---|---|---|
| 右侧栏较窄，菜单/树操作拥挤 | 体验 | 使用 dockkit 全屏/浮动；行高与菜单紧凑；M3 评估主面板形态 |
| 依赖内部 Client API（sidebarRightTabs/slots）随版本变化 | 未来升级可能失效 | 锁定目标 0.2.1-rc.5，只使用官方公开的注册路径与主题 token；不 require DSH Client 包 |
| 无法导入 primitives，自绘控件与宿主风格不一致 | 观感 | 按规范复制宿主控件标记/样式并改前缀，只依赖 `--dsw-alias-*` |
| 永久删除无废纸篓 | 数据风险 | 二次确认 + 默认不提供"删除不确认"；M2 原生桥 |
| Host 路由可操作任意目录 | 安全 | 认证栅栏 + root 包含校验 + realpath 防逃逸 + 危险操作确认；与 GUI 目录选择器同级授权 |
| Host HMR 对 linked 包不总是即时 | 开发效率 | Plugins 页 toggle / 重启兜底 |

**备选方案（已评估不采用）**：只做动作增强（`sidebar.right.tab.menu.item` / `files.actions`）——无法满足行级菜单与内联重命名；接管内置 `files` kind——与内置 body 的子槽兼容性未验证且用户仍需要内置只读树，M1 先以新 kind 并存；typert Remote——第三方 build 期 codegen 不可行；`ctx.shell` 执行 mv/rm——注入与跨平台风险高。

## 9. 证据索引

| 主题 | 来源 |
|---|---|
| 内置文件树现状与限制 | `@deepseek-ai/dsh-client-ui-sidebar-files` README + lib/client.js |
| 文件树数据面（只读） | `@deepseek-ai/dsh-api-workspace-files` README / lib/typert.host.js |
| fs 契约无 rename/delete/copy | `@deepseek-ai/dsh-fs` README "Known Limitations" |
| 新 tab 类型注册 API | `@deepseek-ai/dsh-client-ui-sidebar-right` README "Extension seats" |
| Host 路由 + 信任栅栏先例 | `@deepseek-ai/dsh-host-open-in-app` lib/index.js |
| 插件 bundle 结构/安装 | `dsh-agent-preset/skills/cordis-plugin-development`（SKILL.md、references/host-plugin.md、ui-plugin.md、practices.md、templates/decoration） |
| 安装/本地路径/HMR | `@deepseek-ai/dsh-client-ui-plugin-manager` README；`dsh-hmr` / `dsh-client-hmr` README |
| Reveal / Open With API | `@deepseek-ai/dsh-api-session-controller` typert.host.js；`@deepseek-ai/dsh-client-ui-open-in-app` lib/client.js |

> 实现状态：M1 已实现并通过静态检查、42 项本地自动化测试、服务端探测与 GUI 人工验收（记录见下一节）。
## 10. 验收记录（2026-11-01）

- **安装**：通过 GUI Plugins → Add plugin → 本地绝对路径安装成功；profile `~/.dsh/profiles/desktop` 的 dependencies 为 `link:/Volumes/E/code/DSH/folder`，`dsh.profile.bundles` 已追加 `@local/dsh-folder-explorer`。
- **服务端探测**：`GET /folder-explorer/list`、`/browse`、未知 `/folder-explorer/*` 均返回 **401**（连接信任栅栏生效，证明 Host 半边已激活且路由已注册；未注册应为 404）；client bundle（134 KB）以 200 返回，且出现在 `/plugins/events` 的 boot graph 中（含 inject 列表与立即加载标记）。
- **HMR**：对 `client.js` 触发 mtime 变化后，`/plugins/events` 收到该插件的 `rebuilt` 帧并更新 graph revision，验证浏览器半边可原地热替换。
- **自动化**：`node --check` 全过；`node --test test/*.test.js` **42/42**；Host 假 ctx + 真实 HTTP 集成冒烟 82 断言（全部路由、401 栅栏无副作用、405/413/415/404、outside-root、串行队列、disposer 生命周期）通过。
- **用户 UI 验收**：标签向导打开 Folder Explorer、树显示并可展开、右键菜单出现、新建文件夹并删除、单击文件打开预览、复制绝对路径、行内重命名、复制/粘贴冲突对话框（选“跳过”）均正常，浏览器控制台无报错。
- **尚未逐项手动验收**：全部键盘快捷键组合、深色/浅色主题对照截图、屏幕阅读器朗读、在 Finder/资源管理器中显示与外部应用打开的真实桌面行为（依赖宿主 Session Remote）。这些由实现、静态检查与单元测试覆盖，建议后续抽查。
