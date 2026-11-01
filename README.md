# DSH Folder Explorer

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web/Desktop 插件：在右侧栏提供类 VSCode 的文件夹资源管理器。

打开任意本地文件夹后可以：

- **VSCode 风格类型图标**：TypeScript / JavaScript / JSON / Markdown / 图片 / 压缩包 / Office / Shell / 配置 / 锁文件等按形状与颜色区分；文件夹有开合两态，`.git`、`node_modules`、`src`、`dist`、`docs`、`config` 使用专属图标（图标子集来自 MIT 许可的 Material Icon Theme，见 [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)）
- 树形浏览（懒加载、目录优先排序、隐藏文件可见、手动刷新）
- 右键菜单：复制绝对路径 / 复制相对路径、重命名（行内编辑）、新建文件、新建文件夹、删除（二次确认后永久删除）、复制 / 粘贴（冲突策略：保留两者 / 跳过 / 覆盖）、在 Finder/资源管理器中显示
- 键盘操作：↑/↓ 移动、→/← 展开折叠、Enter 打开、F2 重命名、Delete 删除、Cmd/Ctrl+C / V 复制粘贴、Esc 关闭浮层
- **添加到对话（Add to Chat）**：文件树右键、已打开文件的预览头部按钮或 tab 右键，把文件/文件夹作为 `@` 引用直接放进当前会话的聊天输入框（类似 Cursor；不读取文件内容、不自动发送、保留已有草稿）
- 点击文件用 DSH 内置文档预览打开（工作区外绝对路径同样可用）
- 中文 / 英文文案，跟随宿主主题（深色 / 浅色）

插件是一个**双面 bundle**：Host 半边（`index.js`）注册 `/folder-explorer/*` HTTP 路由完成受控的本地文件操作，浏览器半边（`client.js`）在右侧栏注册 `folder-explorer` 标签类型。无构建步骤、无 npm 运行时依赖。

## 安装（从 GitHub）

前置：DSH Web/Desktop **0.2.1-rc.5**。

1. 打开 DSH Web GUI，左侧 **Plugins**；
2. 点击 **Add plugin** → **Install a third-party plugin**；
3. 在包/地址栏填入本仓库的 Git 地址（以下两种写法等价，任选其一）：

   ```
   https://github.com/wx-98/DSH-folder.git
   ```

   ```
   github:wx-98/DSH-folder
   ```

4. 安装完成后启用该 bundle 的 row（开关打开）；
5. 打开任意会话 → 右侧栏标签向导 → **Folder Explorer**。

安装由 DSH profile 的插件管理器执行（本地 profile 目录：`~/.dsh/profiles/<profile>`）。仓库根目录就是插件包根目录，`package.json` 已声明 `dsh.bundle.patch` 与 `dsh.client`，因此 Git 地址可以直接安装。

> 已验证：以上 Git 地址可被 pnpm 直接解析安装（从 GitHub 拉取代码，无 build 步骤、无 npm 运行时依赖）。

> 首次安装需要能访问 GitHub。如果网络受限，可以先 clone 仓库，再用 **本地绝对路径** 安装（见下）。

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
- 暂不支持拖拽移动、多选批量、外部变更自动监听、全文搜索（后续里程碑）；
- “用外部应用打开”依赖宿主提供 Session Remote，不可用时菜单项隐藏。

更多设计细节与验收记录见 [docs/folder-explorer-plugin.md](docs/folder-explorer-plugin.md)；图标机制与清单见 [docs/file-icons.md](docs/file-icons.md)；「添加到对话」说明见 [docs/add-to-chat.md](docs/add-to-chat.md)。

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