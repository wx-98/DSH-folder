# 文件类型图标主题（VSCode 风格）分析与设计

> 状态：M1 已实现并验收通过（自动化 + GUI 视觉验收，2026-11-01）· 目标 DSH 版本：Web/Desktop 0.2.1-rc.5 · 日期：2026-11-01
> 关联 OpenSpec 变更：`openspec/changes/add-vscode-like-file-icons/`

## 1. 问题

1. 本插件的图标能否设计成 VS Code 图标主题那样的效果——不同类型的文件、文件夹使用不同样式和颜色的图标？
2. 相关分析与设计文档落盘在 `docs/` 文件夹中（即本文）。

## 2. 现状分析

当前 Folder Explorer 的树行图标全部在 `client.js` 内以单色内联 SVG 实现：

| 图标 | 使用场景 | 规格 |
|---|---|---|
| `FolderIcon` | 普通目录（关闭 / 展开两种 path） | 16×16，`stroke: currentColor`，CSS 颜色 `var(--dsw-alias-label-tertiary)` |
| `FileIcon` | 所有普通文件 | 同上，单一折角文档轮廓 |
| `OtherIcon` | `type: "other"` 条目 | 同上，圆圈感叹号 |
| `FolderGlyph` | 标签类型 / guide 卡片 | 20×20，单色描边 |

也就是说：`index.ts`、`package.json`、`README.md`、`logo.svg`、`data.zip` 在改造前视觉上完全一致，用户只能靠文件名区分（改造后：树行使用 §6 的类型图标；「打开文件夹」对话框的目录浏览列表仍沿用原来的 20×20 单色 `FolderIcon`，后续 M2 可统一）。宿主列表条目只提供 `{ name, type, size?, mtime? }`，**没有 MIME / language ID**，所以类型判断只能基于名称（文件名、扩展名、文件夹名）。

## 3. VS Code file icon theme 机制（已核对官方文档）

VS Code 图标主题是一个 JSON 文件，核心是 `iconDefinitions` + 关联表：

```json
{
  "iconDefinitions": {
    "_ts": { "iconPath": "./icons/typescript.svg" },
    "_folder": { "iconPath": "./icons/folder.svg" },
    "_folder_open": { "iconPath": "./icons/folder-open.svg" }
  },
  "file": "_file",
  "folder": "_folder",
  "folderExpanded": "_folder_open",
  "fileNames": { "package.json": "_package" },
  "fileExtensions": { "ts": "_ts", "d.ts": "_ts_d" },
  "folderNames": { ".git": "_git", "node_modules": "_node" },
  "light": { "file": "_file_light" }
}
```

要点：**精确文件名 > 扩展名**、文件夹有 `folder`/`folderExpanded` 两态、`folderNames` 可覆盖特殊目录、支持 `light`/`highContrast` 变体、图标可以是 SVG 图片或字形字体。

许可证核对（源码仓库 LICENSE 原文）：

- `material-extensions/vscode-material-icon-theme`：**MIT**；
- `vscode-icons/vscode-icons`：**MIT**。

因此可以在保留版权与许可声明的前提下，复用其图标子集并再分发。

## 4. 可行性结论

**可以。** 但必须满足本插件的形态约束：

| 约束 | 说明 |
|---|---|
| 单文件浏览器 bundle | `client.js` 经 `window.__ModuleLoader__.load` 加载，不能拆模块、不能引入构建步骤 |
| 仅 react 基线 | 不 `require` 任何 `@deepseek-ai/*` Client 包（含 `FileTypeIcon` 组件） |
| 无网络 / 无外部资源 | 图标必须内联为 SVG 数据；不引入字体、图片 URL 或 Host 资源路由（M1） |
| 颜色自持 | 类型颜色必须是图标自身的 `fill`/`stroke`，不能用 `currentColor`（那样会变单色） |
| 体积预算 | `client.js` 当前约 134 KB，图标体系新增不超过 80 KB |
| 许可合规 | 原创，或 MIT 图标子集 + `docs/THIRD_PARTY_NOTICES` 归属声明 |

## 5. 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 内联数据注册表 | `ICON_DEFS` + 映射表全部写进 `client.js` | 零网络、零构建、离线/HMR 友好、静态可审计 | 增大 bundle | **M1 采用** |
| B. Host 提供 SVG 资源 | 新增 `GET /folder-explorer/icon/<id>`，图标放仓库 `icons/` | 图标集可很大、client.js 不变大 | 多一条 Host 路由、首屏异步闪烁、缓存与鉴权成本 | M2 备选 |
| C. Icon font（`fontCharacter`） | 打包 woff2，用字形渲染 | 与 VS Code 字形方案同源、文件相对小 | 字体加载/许可/回退复杂，收益低 | 不采用 |
| D. 复用 DSH `ui-primitives` | 直接 import `FileTypeIcon` | 与宿主一致 | 规范禁止依赖 Client 包、接口不稳定 | 不采用 |

## 6. 实现采用的图标清单

图标数据来自 Material Icon Theme（MIT，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）的 `icons/` 子集；文件夹展开态由项目的 canonical open-folder path 替换生成；`other` 为原创图形。共 **46** 个图标定义（31 个文件图标 + 14 个文件夹图标 + 1 个 other）。

### 6.1 文件图标（按扩展名/精确文件名）

| 图标 id | 匹配 | 主色 |
|---|---|---|
| `ts` | `.ts` `.mts` `.cts` | `#0288d1` |
| `js` | `.js` `.mjs` `.cjs` | `#ffca28` |
| `react` | `.tsx` `.jsx` | `#00bcd4` |
| `json` | `.json` `.jsonc` `.json5`、`package.json` | `#f9a825` |
| `md` | `.md` `.mdx` | `#42a5f5` |
| `html` | `.html` `.htm` | `#e65100` |
| `css` | `.css` | `#7e57c2` |
| `scss` | `.scss` `.sass` | `#ec407a` |
| `less` | `.less` | `#0277bd` |
| `yaml` | `.yaml` `.yml` | `#ff5252` |
| `toml` | `.toml` | `#ef5350` |
| `xml` | `.xml` | `#8bc34a` |
| `svg` | `.svg` | `#ffb300` |
| `image` | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.ico` `.bmp` `.avif` | `#26a69a` |
| `zip` | `.zip` `.tar` `.gz` `.tgz` `.bz2` `.xz` `.7z` `.rar` `.zst` | `#afb42b` |
| `pdf` | `.pdf` | `#ef5350` |
| `word` | `.doc` `.docx` `.rtf` `.odt` | `#01579b` |
| `ppt` | `.ppt` `.pptx` `.odp` | `#e64a19` |
| `table` | `.xls` `.xlsx` `.csv` `.tsv` `.ods` | `#8bc34a` |
| `lock` | `.lock`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`cargo.lock` | `#ffd54f` |
| `license` | `LICENSE` `LICENCE` `COPYING` | `#ff5722` |
| `git` | `.gitignore` `.gitattributes` `.gitmodules` | `#e64a19` |
| `python` | `.py` | `#0288d1` / `#fdd835` |
| `go` | `.go` | `#00acc1` |
| `rust` | `.rs` | `#ff7043` |
| `java` | `.java` | `#f44336` |
| `docker` | `Dockerfile` | `#0288d1` |
| `database` | `.sql` `.db` `.sqlite` `.sqlite3` | `#ffca28` |
| `console` | `.sh` `.bash` `.zsh` `.fish` `.ps1` `.bat` `.cmd`、`Makefile` | `#ff7043` |
| `settings` | `.env` `.ini` `.cfg` `.conf` `.properties`、`.npmrc`、`.editorconfig` | `#8b949e` / `#42a5f5` |
| `file` | 其余文件（`.txt` `.log` 等） | `#8b949e` / `#42a5f5` |
| `other` | 宿主返回 `type: "other"`（原创） | `#8b949e` |

### 6.2 文件夹图标

| 图标 id | 匹配 | 主色 |
|---|---|---|
| `folder` / `folderOpen` | 普通目录（关闭 / 展开） | `#8d6e63` |
| `folderSrc` / `folderSrcOpen` | `src` | `#4caf50` |
| `folderNode` / `folderNodeOpen` | `node_modules` | `#8bc34a` |
| `folderDist` / `folderDistOpen` | `dist` `build` `out` | `#e57373` |
| `folderGit` / `folderGitOpen` | `.git` `.github` | `#ff7043` |
| `folderDocs` / `folderDocsOpen` | `docs` `doc` | `#0277bd` |
| `folderConfig` / `folderConfigOpen` | `config` `.config` | `#00acc1` |

匹配优先级：文件夹名（`folderNames`）→ 普通文件夹；文件精确名（`exactNames`）→ 最长复合后缀 → 单段扩展名 → 通用文件；全部大小写不敏感。

## 7. 数据模型（计划写入 client.js）

```js
const ICON_DEFS = {
  ts: { viewBox: "0 0 16 16", body: { fill: "#3178c6", path: "M..." } },
  // ...
};
const FILE_ICONS = {
  fileNames: { "package.json": "config", "license": "license", "readme.md": "markdown" },
  fileExtensions: { ts: "ts", "d.ts": "ts", json: "json", md: "markdown", tar.gz: "archive" },
  categories: { image: "image", archive: "archive" },
};
const FOLDER_ICONS = { folder: "folder", folderExpanded: "folderOpen", folderNames: { ".git": "gitFolder" } };

function resolveIcon(entry, expanded) { /* 精确名 → 最长复合后缀 → 扩展名 → 类别 → 兜底 */ }
```

解析规则：全部大小写不敏感；复合后缀按 `.` 切分后从最长组合开始匹配；未知扩展名 → 通用文件；`type: "other"` → 其他图标；缺失元数据不抛错。

## 8. 体积与性能预算

- 基线：`client.js` ≈ 134 KB（当前 3075 行）；
- 预算：新增 ≤ **80 KB**，目标 20–60 KB；
- 措施：SVG path 精度精简到 1–2 位小数、图标复用 `<g>` 结构、注册表/组件模块加载时只建一次、行组件维持 `React.memo`；
- 实测值在实现完成后记录于本文 §11。

## 9. 主题与可访问性

- 图标为装饰性内容：`aria-hidden="true"`、`focusable="false"`，不进 Tab 序列，屏幕阅读器只读文件名与展开/选中状态；
- 类型颜色为固定色板，选择在浅色（白底）与深色（深灰底）主题下都可辨识；不依赖 `currentColor`；
- 行悬停/选中背景仍由宿主主题 token 提供，图标透明底，不与高亮冲突。

## 10. 许可证与归属

- 实际实现复用了 **Material Icon Theme**（MIT）的图标子集，归属声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（含来源 URL、版权声明与 MIT 全文）；
- `other` 图标为原创图形，无第三方归属；
- 本清单（§6）与实际内联数据一致；不把第三方图标用于品牌暗示，仅作文件类型识别。

## 11. 验收标准

- [x] 同一目录下的 .ts / .js / .json / .md / .svg / .png / .zip / .pdf / .sh 显示不同形状与颜色的图标；
- [x] 文件夹关闭/展开图标正确切换，特殊目录（`.git`、`node_modules`、`src`、`dist`）有独立图标；
- [x] 未知扩展名、`other` 类型、缺失元数据走兜底且无控制台异常；
- [x] 深色/浅色主题下图标可辨识；
- [x] `client.js` 体积增量 ≤ 80 KB（实测记录见下）；
- [x] 排序、选择、键盘导航、右键菜单与文件操作行为不变；
- [x] 如复用第三方图标，`docs/THIRD_PARTY_NOTICES` 存在且内容完整。

### 实测记录（实现后填写）

| 项目 | 值 |
|---|---|
| 变更前 `client.js` 字节数 | 134,489（当前基线） |
| 变更后 `client.js` 字节数 | 168,022 |
| 增量 | +33,533 bytes（≈32.7 KB，预算 ≤ 80 KB） |
| GUI 验收日期/结果 | 待验收 |

## 12. 后续（M2+）

- 可切换的 icon theme（内置主题 / 单色模式）；
- 图标集显著扩大时，改为 Host 提供 SVG 资源或 icon font；
- 如宿主未来暴露 MIME/language ID，可加入语言级匹配；
- 为浅色/深色主题提供独立色板变体。

## 13. 参考

- VS Code 官方 File Icon Theme 文档：<https://code.visualstudio.com/api/extension-guides/file-icon-theme>
- Material Icon Theme（MIT）：<https://github.com/material-extensions/vscode-material-icon-theme>
- vscode-icons（MIT）：<https://github.com/vscode-icons/vscode-icons>
- 现有插件方案文档：[docs/folder-explorer-plugin.md](folder-explorer-plugin.md)
### 实现验收记录（自动化，2026-11-01）

| 项目 | 结果 |
|---|---|
| `client.js` 变更 | 134,489 → **168,022 bytes**（+33,533 bytes ≈ 32.7 KB，预算 ≤ 80 KB） |
| 图标定义 | 46 个（31 文件图标 + 14 文件夹图标 + 1 other）；qlmanage 渲染成表并逐类目检通过 |
| 分辨率/映射测试 | 本地 VM 测试 30+ 项：精确名、复合后缀、大小写、未知扩展名、文件夹开合、特殊目录、`other`、缺失元数据 |
| 图标渲染测试 | 46 个定义逐个断言 viewBox/16×16/aria-hidden/path 数/fill；未知 id 回退 `file` |
| 本地测试套件 | `node --test test/*.test.js` → **45/45 通过**（35 Host ops + 7 浏览器注册/图标 + 3 契约） |
| 运行中集成 | boot graph 含该插件（rev `774b1965b104`）；服务端 bundle 168,105 bytes 且包含 `ICON_DEFS`；`rebuilt` HMR 帧已验证 |
| GUI 视觉验收 | ✅ 用户确认（2026-11-01）：形状/颜色/开合正常 |

> 验收样例目录：`/tmp/dfe-icon-sample`（含 .ts/.js/.tsx/.json/.md/.css/.png/.zip/.pdf/.sh/.lock/LICENSE 与 src/node_modules/dist/docs/.git/config 等目录）。