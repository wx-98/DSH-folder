# Third-Party Notices

本仓库的 `client.js` 内联了从 **Material Icon Theme** 派生的图标图形数据（文件类型图标与文件夹图标，含由其闭合图标生成的展开变体）。

## Material Icon Theme

- 项目：material-extensions/vscode-material-icon-theme
- 来源：<https://github.com/material-extensions/vscode-material-icon-theme>
- 版本参考：仓库 `main` 分支（2026-11 获取）
- 许可：MIT
- 版权：Copyright (c) 2025 Material Extensions

复用的图标（SVG 图形数据内联于 `client.js`，未附带原始 SVG 文件）：

- 文件类型：typescript、javascript、react、json、markdown、html、css、sass、less、yaml、toml、xml、svg、image、zip、pdf、word、powerpoint、table、lock、license、git、python、go、rust、java、docker、database、console、settings、document
- 文件夹：folder-base、folder-src、folder-node、folder-dist、folder-git、folder-docs、folder-config
- 文件夹展开变体：由上述闭合文件夹图标替换为项目构建脚本中的 canonical open-folder path 生成（`src/scripts/svg/generateOpenFolderIcons.ts`）

`other` 类型图标为原创图形，不属于上述第三方素材。

MIT License 全文：

```text
The MIT License (MIT)

Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
