# 添加到对话（Add to Chat）

> 状态：M1 已实现（整文件引用）· 目标 DSH 版本：Web/Desktop 0.2.1-rc.5 · 日期：2026-11-01

## 功能

Folder Explorer 现在支持把文件/文件夹作为引用直接加入当前会话的聊天输入框，类似 Cursor 的 **Add to Chat**：

| 入口 | 位置 | 插入内容 |
|---|---|---|
| 文件树行右键 | 「添加到对话」 | 该文件/文件夹的 `@` 引用 |
| 已打开文件的预览头部 | 「添加到对话」按钮 | 当前打开文件的 `@` 引用 |
| 右侧栏文档预览 tab 右键 | 「添加到对话」 | 该 tab 对应文件的 `@` 引用 |

行为说明：

- 引用格式遵循 DSH 的 `@file` mention 语法：工作区内相对会话 cwd（`@src/a.ts`），工作区外绝对路径（`@/Users/x/a.ts`），含空格用 `@"path with spaces"`，文件夹带尾斜杠（`@src/`）。
- 插入**不会自动发送**，也不会清空/覆盖已有草稿；引用追加到当前草稿，发送时展开为 `@路径` 文本，不读取、不上传文件内容。
- 优先插入 DSH 的引用芯片（可点击打开预览）；宿主接口不可用时降级为纯文本 mention（发送后仍渲染为文件引用）；两者都不可用时给出提示。
- 目标会话取触发入口所属的会话（右栏 tab 的 sessionId），多 pane/后台会话互不影响。

## 实现要点

- 引用构造（`buildMention` / `buildChip`）与插入阶梯集中在 `client.js`，插入顺序：
  1. `ctx.get("conversation").input.shell(sessionId).addFiles([chip], [])`（官方拖拽/@ 菜单同一芯片 seam）；
  2. 降级 `inputActions.captureInsertion() + insertText(mention)`（文档化标准 prop）；
  3. 不可用提示。
- 入口以 `ctx.slots.inject` 注册到 `sidebar.right.tab.document.actions` 与 `sidebar.right.tab.menu.item`；文件树使用插件自带右键菜单。
- 纯客户端：不新增 Host 路由/网络请求/文件读取。

## 已知限制 / 后续

- 只支持**整文件引用**；「在预览中选中文本/行范围 → 添加到对话」需要 DSH 上游给 documentpreview 暴露 selection API（0.2.1-rc.5 无公开 API，且插件规范禁止读取其他插件 DOM），或本插件自建带选区的预览渲染器——列为后续里程碑。
- 不提供引用 pin/持久固定、多选批量添加、拖拽到输入框。
- `addFiles` 等插入 seam 属实现级接口（官方拖拽路径在用），DSH 升级需回归；失败会自动降级到纯文本插入。
