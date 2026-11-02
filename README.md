# DSH Folder Explorer

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web/Desktop 插件：在右侧栏提供类 VSCode 的文件夹资源管理器。

**插件类型：** Cordis 插件 bundle（双面：Host 半边 + Web Client 半边），不是皮肤 / TUI / 桌面客户端。

打开任意本地文件夹后可以：

- **VSCode 风格类型图标**：TypeScript / JavaScript / JSON / Markdown / 图片 / 压缩包 / Office / Shell / 配置 / 锁文件等按形状与颜色区分；文件夹有开合两态，`.git`、`node_modules`、`src`、`dist`、`docs`、`config` 使用专属图标（图标子集来自 MIT 许可的 Material Icon Theme，见 [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)）
- 树形浏览（懒加载、目录优先排序、隐藏文件可见；**自动刷新**：watch ≤2s、轮询降级 ≤5s，切换标签/预览后**保留展开、选中与滚动状态**；也可手动刷新）
- 右键菜单：复制绝对路径 / 复制相对路径、重命名（行内编辑）、新建文件、新建文件夹、删除（二次确认后永久删除）、复制 / 粘贴（冲突策略：保留两者 / 跳过 / 覆盖）、在 Finder/资源管理器中显示
- 键盘操作：↑/↓ 移动、→/← 展开折叠、Enter 打开、F2 重命名、Delete 删除、Cmd/Ctrl+C / V 复制粘贴、Esc 关闭浮层
- **添加到对话（Add to Chat）**：文件树右键、已打开文件的预览头部按钮或 tab 右键，把文件/文件夹作为 `@` 引用直接放进当前会话的聊天输入框（类似 Cursor；不读取文件内容、不自动发送、保留已有草稿）
- 点击文件用 DSH 内置文档预览打开（工作区外绝对路径同样可用）
- 中文 / 英文文案，跟随宿主主题（深色 / 浅色）

插件是一个**双面 bundle**：Host 半边（`index.js`）注册 `/folder-explorer/*` HTTP 路由完成受控的本地文件操作，浏览器半边（`client.js`）在右侧栏注册 `folder-explorer` 标签类型。无构建步骤、无 npm 运行时依赖。

## 安装

前置：DSH Web/Desktop **0.2.1-rc.5**。插件声明了 `dsh.bundle.patch` 与 `dsh.client`，支持 GitHub、npm 与本地目录三种安装方式。

### 从 GitHub 安装

GUI：Plugins → Add plugin → Install a third-party plugin → 填 `github:wx-98/DSH-folder`（或 `https://github.com/wx-98/DSH-folder.git`）→ 安装后启用 bundle 的 row。

CLI（`dsh` 在 PATH 中时）：

```bash
dsh plugin --profile <profile> add github:wx-98/DSH-folder
```

### 从 npm 安装

npm 包名：`dsh-folder-explorer`（无构建步骤、无运行时依赖）。

GUI：Plugins → Add plugin → 包名 `dsh-folder-explorer`。

CLI：

```bash
dsh plugin --profile <profile> add dsh-folder-explorer
```

> 已发布到 npm：**`dsh-folder-explorer@0.2.0`**（2026-11-01，[npm registry](https://registry.npmjs.org/dsh-folder-explorer)）。
>
> 维护者发布：配置仓库 secret `NPM_TOKEN`（npm automation token）后，可通过 `.github/workflows/publish-npm.yml` 的 workflow_dispatch 或 GitHub Release 发布；也可本地 `npm login && npm publish --access public`。

### 本地开发安装

```bash
git clone https://github.com/wx-98/DSH-folder.git dsh-folder
```

然后在 DSH GUI：Plugins → Add plugin → **本地绝对路径**，填入 clone 目录的绝对路径。本地目录以 link 方式安装，修改 `client.js` 会被 `dsh-client-hmr` 原地热替换，Host 半边改动经 profile 重组生效。

## 使用

1. 右侧栏标签向导打开 **Folder Explorer**（或从标签栏 + 号选择）；
2. 默认根目录是当前会话工作目录；点击工具栏 **打开文件夹…** 可浏览并切换到任意本地目录（最近一次根会记住）；
3. 单击文件在右侧预览；目录行单击展开 / 折叠；
4. 右键打开行级菜单；树获得焦点后可用键盘操作。

## 安全边界

- 每个文件操作请求先经过 DSH 的 **连接信任栅栏**（Host/Origin 校验 + 登录 cookie）；
- 所有路径限定在用户显式打开的 **根目录** 内，并做规范化 + `realpath` 复核，拒绝通过 `..` 或符号链接逃逸；
- 删除必须带显式确认；复制/移动拒绝把目录放进自身；
- 变更操作在 Host 内串行执行；不产生模型可见事件。

## 兼容性与已知限制

- 目标 DSH 0.2.1-rc.5；依赖其公开扩展点（`sidebarRightTabs`、`slots`、`webServer`、`connection`、`remote.session`），DSH 升级后建议重新回归。
- 删除为**永久删除**（有二次确认），暂不进入废纸篓；
- 暂不支持拖拽移动、多选批量、全文搜索、跨根全局索引（后续里程碑）；
- “用外部应用打开”依赖宿主提供 Session Remote，不可用时菜单项隐藏。

更多设计细节与验收记录见 [docs/folder-explorer-plugin.md](docs/folder-explorer-plugin.md)；图标机制与清单见 [docs/file-icons.md](docs/file-icons.md)；「添加到对话」说明见 [docs/add-to-chat.md](docs/add-to-chat.md)。

## 社区收录

- GitHub topic：[`dsh-plugin`](https://github.com/topics/dsh-plugin)（已设置）
- 列表收录：[awesome-dsh-plugin PR #11102](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11102)（提交于 2026-11-01；唯一 CI 门槛是仓库创建未满 1 天，约 19 小时后自动复跑通过，无需重提）
- 注册登记：[DSH Plugin Registry（dshplugin.world）](https://dshplugin.world/submit) 的 Submit 流程：仓库 issue [#1](https://github.com/wx-98/DSH-folder/issues/1) 已提交；官方 discussions ping 受 deepseek-ai 组织 OAuth App 访问限制（issue 路径与 dsh-plugin topic 抓取已覆盖提交）

## 更新记录

- **0.2.1**（2026-11-02）：修复右键菜单半透明导致的文字不清（改用不透明主题层）；新增自动刷新（Host SSE watch，变化后 ≤2s 出现；不可用时 ≤5s 轮询降级）；文件预览/标签切换返回时保留展开集合、选中行与滚动位置（`keepMounted`）。
- **0.2.0**（2026-11-01）：包名改为 `dsh-folder-explorer`，发布 npm；新增「添加到对话」与类型图标。
- **0.1.0**（2026-11-01）：首个版本。

## 仓库结构

```text
package.json       插件包清单（exports / dsh.bundle.patch / dsh.client）
cordis.patch.yml   Loader 行插入（Host 半边 + 浏览器半边）
index.js           Host 半边：/folder-explorer/* 路由
lib/ops.js         文件操作实现（校验、list/stat/create/rename/delete/copy/move/reveal）
client.js          浏览器半边：右侧栏标签类型、文件树、菜单、对话框
locale/            插件管理页展示文案（zh/en）
icon.svg           插件图标
docs/              设计与验收文档
```

## 许可证

[MIT](LICENSE)