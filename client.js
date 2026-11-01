// Browser half of the Folder Explorer DSH plugin.
// A single self-contained client bundle: no build step, no dependencies beyond the
// module table's "react" baseline. Registers a right-sidebar tab type
// (kind: folder-explorer), its lazily loaded file-tree body and its title chip.
window.__ModuleLoader__.load({
  id: "dsh-folder-explorer",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** This implementation's identity in the tab system and the body/title slot key. */
    const ID = "dsh-folder-explorer";
    /** The tab kind this package owns. */
    const KIND = "folder-explorer";
    /** Locale namespace used for every visible string. */
    const NS = "folderExplorer";
    /** Host route prefix; requests stay relative so the app's base path keeps working. */
    const ROUTE_PREFIX = "folder-explorer";
    /** Where the last successfully opened root is remembered. */
    const ROOT_STORAGE_KEY = "dsh.folder-explorer.root.v1";
    /** How many entries a directory listing may carry before the Host truncates it. */
    const MAX_ENTRIES = 2000;
    const BODY_SLOT = "sidebar.right.pane.tab";
    const TITLE_SLOT = "sidebar.right.pane.tab.title";
    const STYLE_TAG = ID + "/styles";
    /** The native desktop path handlers live here when the Host offers the Session Remote. */
    let remoteSession = null;
    /** The plugin root context once the optional conversation injection has landed. */
    let clientCtx = null;

    // ---------------------------------------------------------------------------
    // Small pure helpers
    // ---------------------------------------------------------------------------

    /** Fill {name} placeholders; missing values stay literal so nothing turns "undefined". */
    function format(template, params) {
      if (typeof template !== "string") return "";
      if (params === undefined || params === null) return template;
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        const value = params[name];
        if (value === undefined || value === null) return match;
        return String(value);
      });
    }

    function isAbsolutePath(value) {
      if (typeof value !== "string" || value === "") return false;
      if (value.startsWith("/")) return true;
      if (/^[A-Za-z]:[/\\]/.test(value)) return true;
      return value.startsWith("\\\\");
    }

    function stripTrailingSeparators(value) {
      const text = typeof value === "string" ? value : "";
      if (text === "" || text === "/") return text;
      const trimmed = text.replace(/[/\\]+$/, "");
      if (trimmed === "") return "/";
      if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + "/";
      return trimmed;
    }

    function joinPath(parent, name) {
      const base = stripTrailingSeparators(parent);
      const leaf = typeof name === "string" ? name : String(name);
      if (base === "") return leaf;
      if (base === "/") return "/" + leaf;
      return base + "/" + leaf;
    }

    function parentPath(value) {
      if (typeof value !== "string" || value === "") return null;
      const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
      if (normalized === "") return null;
      const index = normalized.lastIndexOf("/");
      if (index < 0) return null;
      if (index === 0) return "/";
      const head = normalized.slice(0, index);
      if (/^[A-Za-z]:$/.test(head)) return head + "/";
      return head;
    }

    function baseName(value) {
      if (typeof value !== "string" || value === "") return "";
      const normalized = stripTrailingSeparators(value).replace(/\\/g, "/");
      const index = normalized.lastIndexOf("/");
      return index < 0 ? normalized : normalized.slice(index + 1);
    }

    function relativeToRoot(root, path) {
      if (typeof root !== "string" || typeof path !== "string") return path;
      const normalizedRoot = stripTrailingSeparators(root.replace(/\\/g, "/"));
      const normalizedPath = path.replace(/\\/g, "/");
      if (normalizedPath === normalizedRoot) return ".";
      const prefix = normalizedRoot === "/" ? "/" : normalizedRoot + "/";
      if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length);
      return normalizedPath;
    }

    function isSameOrDescendant(parent, candidate) {
      if (typeof parent !== "string" || typeof candidate !== "string") return false;
      const normalizedParent = stripTrailingSeparators(parent.replace(/\\/g, "/"));
      const normalizedCandidate = candidate.replace(/\\/g, "/");
      if (normalizedCandidate === normalizedParent) return true;
      const prefix = normalizedParent === "/" ? "/" : normalizedParent + "/";
      return normalizedCandidate.startsWith(prefix);
    }

    /** Root-to-target breadcrumbs, POSIX and Windows drive spellings. */
    function pathCrumbs(path) {
      const crumbs = [];
      if (typeof path !== "string" || path === "") return crumbs;
      const normalized = path.replace(/\\/g, "/");
      if (normalized.startsWith("/")) {
        crumbs.push({ path: "/", label: "/" });
        let current = "";
        const parts = normalized.split("/");
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index];
          if (part === "") continue;
          current += "/" + part;
          crumbs.push({ path: current, label: part });
        }
        return crumbs;
      }
      const drive = /^([A-Za-z]:)(\/.*)?$/.exec(normalized);
      if (drive !== null) {
        crumbs.push({ path: drive[1] + "/", label: drive[1] + "/" });
        let current = drive[1];
        const rest = (drive[2] || "").split("/");
        for (let index = 0; index < rest.length; index += 1) {
          const part = rest[index];
          if (part === "") continue;
          current += "/" + part;
          crumbs.push({ path: current, label: part });
        }
      }
      return crumbs;
    }

    /** Natural, case-insensitive name order, so "file2" precedes "file10". */
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

    function orderEntries(entries) {
      const list = Array.isArray(entries) ? entries.slice() : [];
      return list.sort(function (left, right) {
        const leftDirectory = left && left.type === "directory" ? 1 : 0;
        const rightDirectory = right && right.type === "directory" ? 1 : 0;
        const group = rightDirectory - leftDirectory;
        if (group !== 0) return group;
        const leftName = left && typeof left.name === "string" ? left.name : "";
        const rightName = right && typeof right.name === "string" ? right.name : "";
        return collator.compare(leftName, rightName);
      });
    }

    /** Component-encode one id or path segment, keeping ":" literal for drive letters. */
    function encodeSegment(segment) {
      return encodeURIComponent(String(segment)).replace(/%3A/gi, ":");
    }

    /** Encode a "/"-separated path segment by segment. */
    function encodePath(path) {
      return String(path).split("/").map(encodeSegment).join("/");
    }

    /** dsh-resource://file/session/<session>/<absolute path>; the preview tab reads it. */
    function fileAddress(sessionId, path) {
      const normalized = String(path).replace(/\\/g, "/");
      return "dsh-resource://file/session/" + encodeSegment(sessionId) + "/" + encodePath(normalized);
    }

    /** One path segment accepted as a new name; returns a stable error code or null. */
    function validateName(value) {
      if (typeof value !== "string") return "invalid-name";
      const name = value.trim();
      if (name === "" || name === "." || name === "..") return "invalid-name";
      if (/[/\\\u0000]/.test(name)) return "invalid-name";
      return null;
    }

    /** A Host route failure carrying the stable code the UI branches on. */
    class ApiError extends Error {
      constructor(code, detail) {
        super(typeof detail === "string" && detail !== "" ? detail : String(code));
        this.name = "ApiError";
        this.code = typeof code === "string" && code !== "" ? code : "internal";
        this.detail = typeof detail === "string" ? detail : "";
      }
    }

    function isAbortError(error) {
      if (error === null || error === undefined) return false;
      if (typeof error !== "object") return false;
      if (error.name === "AbortError") return true;
      return error.code === 20;
    }

    function toApiError(error) {
      if (error instanceof ApiError) return error;
      if (error !== null && typeof error === "object" && typeof error.code === "string" && error.code !== "") {
        return new ApiError(error.code, typeof error.message === "string" ? error.message : "");
      }
      return new ApiError("internal", "");
    }

    /** Localize one failure; unknown codes get the generic line plus the Host diagnostic. */
    function describeError(translate, error) {
      const failure = toApiError(error);
      const key = "errors." + failure.code;
      const localized = typeof translate === "function" ? translate(key) : key;
      if (typeof localized === "string" && localized !== key) return localized;
      const generic = typeof translate === "function" ? translate("errors.unknown") : "errors.unknown";
      return format(generic, { message: failure.detail !== "" ? failure.detail : failure.code });
    }

    function apiUrl(name, params) {
      const search = new URLSearchParams();
      if (params !== null && typeof params === "object") {
        const keys = Object.keys(params);
        for (let index = 0; index < keys.length; index += 1) {
          const value = params[keys[index]];
          if (value === undefined || value === null) continue;
          search.set(keys[index], String(value));
        }
      }
      const query = search.toString();
      const base = ROUTE_PREFIX + "/" + name;
      return query === "" ? base : base + "?" + query;
    }

    /** Read one Host response: success is {ok:true,...}, failure is {ok:false,code,message}. */
    async function parseResponse(response) {
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (response.ok === true && body !== null && typeof body === "object" && body.ok === true) return body;
      const status = typeof response.status === "number" ? response.status : 0;
      let code = "internal";
      if (body !== null && typeof body === "object" && typeof body.code === "string" && body.code !== "") code = body.code;
      else if (status === 404) code = "not-found";
      else if (status === 409) code = "already-exists";
      else if (status === 403 || status === 401) code = "permission-denied";
      else if (status === 400 || status === 422) code = "bad-request";
      else if (status === 423 || status === 503) code = "busy";
      const detail = body !== null && typeof body === "object" && typeof body.message === "string" ? body.message : "";
      throw new ApiError(code, detail);
    }

    function requestJson(name, params, payload, signal) {
      const options = { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } };
      if (signal !== undefined) options.signal = signal;
      let url = apiUrl(name, params);
      if (payload !== undefined) {
        options.method = "POST";
        options.headers["content-type"] = "application/json";
        options.body = JSON.stringify(payload);
        url = ROUTE_PREFIX + "/" + name;
      }
      return window.fetch(url, options).then(parseResponse);
    }

    function readStoredRoot() {
      try {
        if (typeof window === "undefined" || !window.localStorage) return null;
        const value = window.localStorage.getItem(ROOT_STORAGE_KEY);
        if (typeof value === "string" && value.startsWith("/")) return value;
        return null;
      } catch (error) {
        return null;
      }
    }

    function writeStoredRoot(path) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        window.localStorage.setItem(ROOT_STORAGE_KEY, path);
      } catch (error) {
        // Storage may be denied; the viewer keeps working without persistence.
      }
    }

    function fallbackCopyText(value) {
      try {
        if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") return false;
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.left = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        let ok = false;
        try {
          area.focus();
          area.select();
          ok = document.execCommand("copy") === true;
        } catch (error) {
          ok = false;
        }
        document.body.removeChild(area);
        return ok;
      } catch (error) {
        return false;
      }
    }

    function copyTextToClipboard(value) {
      const text = typeof value === "string" ? value : String(value);
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === "function") {
        return Promise.resolve(clipboard.writeText(text)).then(function () {
          return true;
        }).catch(function () {
          return fallbackCopyText(text);
        });
      }
      return Promise.resolve(fallbackCopyText(text));
    }

    function normalizePasteStatus(status) {
      const value = typeof status === "string" ? status.toLowerCase() : "";
      if (value === "skipped" || value === "skip") return "skipped";
      if (value === "renamed" || value === "rename") return "renamed";
      return "copied";
    }

    function summarizePasteResults(results) {
      const summary = { copied: 0, renamed: 0, skipped: 0 };
      const list = Array.isArray(results) ? results : [];
      for (let index = 0; index < list.length; index += 1) {
        const status = normalizePasteStatus(list[index] && list[index].status);
        summary[status] += 1;
      }
      return summary;
    }

    /** A Session Remote answer is a RemoteResult; tolerate both the result object and its value. */
    function remoteValue(result) {
      if (result === null || result === undefined) return undefined;
      if (result.ok === true) return result.value;
      if (result.ok === false) return undefined;
      if (result.value !== undefined) return result.value;
      return result;
    }

    /** One flat list of visible tree rows: entry rows plus per-directory status rows. */
    function buildRows(levels, expanded, root) {
      const rows = [];
      if (typeof root !== "string") return rows;
      function appendLevel(directoryPath, depth) {
        const level = levels[directoryPath];
        if (level === undefined || level.status === "loading") {
          rows.push({ kind: "note", note: "loading", depth: depth, path: directoryPath });
          return;
        }
        if (level.status === "failed") {
          rows.push({ kind: "note", note: "failed", depth: depth, path: directoryPath, error: level.error });
          return;
        }
        const entries = Array.isArray(level.entries) ? level.entries : [];
        if (entries.length === 0) rows.push({ kind: "note", note: "empty", depth: depth, path: directoryPath });
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const childPath = joinPath(directoryPath, entry.name);
          rows.push({ kind: "entry", entry: entry, path: childPath, depth: depth, parent: directoryPath });
          if (entry.type === "directory" && expanded !== null && expanded !== undefined && expanded[childPath] === true) {
            appendLevel(childPath, depth + 1);
          }
        }
        if (level.truncated === true) rows.push({ kind: "note", note: "truncated", depth: depth, path: directoryPath });
      }
      appendLevel(root, 0);
      return rows;
    }

    function toPosix(value) {
      return typeof value === "string" ? value.replace(/\\/g, "/") : "";
    }

    function relativeInsideCwd(cwd, absPath) {
      if (typeof cwd !== "string" || cwd === "" || typeof absPath !== "string" || absPath === "") return null;
      const root = toPosix(cwd).replace(/\/+$/, "");
      const target = toPosix(absPath);
      if (root === "" || target === "") return null;
      if (target === root) return "";
      const prefix = root === "/" ? "/" : root + "/";
      return target.startsWith(prefix) ? target.slice(prefix.length) : null;
    }

    function buildMention(absPath, cwd, type) {
      if (typeof absPath !== "string" || absPath === "") return null;
      const target = toPosix(absPath);
      if (target === "" || /[\u0000-\u001f\u007f-\u009f"]/u.test(target)) return null;
      const relative = typeof cwd === "string" && cwd !== "" ? relativeInsideCwd(cwd, target) : null;
      let body = relative !== null && relative !== "" ? relative : target;
      if (type === "directory" && !body.endsWith("/")) body += "/";
      return /\s/u.test(body) ? '@"' + body + '"' : "@" + body;
    }

    function buildChip(absPath, cwd, type) {
      const mention = buildMention(absPath, cwd, type);
      const name = mention === null ? "" : baseName(toPosix(absPath).replace(/\/+$/, ""));
      if (name === "") return null;
      const directory = type === "directory";
      return { source: "reference", ref: mention, label: directory ? name + "/" : name, appearance: directory ? "folder" : "file", clipboardText: mention };
    }

    function parseFileAddress(contentId) {
      const prefix = "dsh-resource://file/session/";
      if (typeof contentId !== "string" || !contentId.startsWith(prefix)) return null;
      const rest = contentId.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 1) return null;
      try {
        const sessionId = decodeURIComponent(rest.slice(0, slash));
        const path = rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
        return sessionId === "" || path === "" || path === "/" ? null : { sessionId: sessionId, path: path };
      } catch (error) {
        return null;
      }
    }

    function insertChatReference(deps, request) {
      const d = deps || {};
      const r = request || {};
      const type = r.type === "directory" ? "directory" : "file";
      const chip = buildChip(r.path, d.cwd, type);
      let shell = null;
      try {
        const conversation = d.conversation;
        if (conversation && conversation.input && typeof conversation.input.shell === "function") shell = conversation.input.shell(r.sessionId);
      } catch (error) {
        shell = null;
      }
      if (shell && typeof shell.addFiles === "function" && chip) {
        try {
          if (shell.addFiles([chip], []) === false) return { mode: "chip", ok: false };
          try {
            if (typeof shell.focus === "function") shell.focus();
          } catch (error) {}
          return { mode: "chip", ok: true };
        } catch (error) {}
      }
      try {
        const actions = d.inputActions;
        if (actions && typeof actions.captureInsertion === "function" && typeof actions.insertText === "function") {
          const mention = buildMention(r.path, d.cwd, type);
          if (mention !== null) return { mode: "text", ok: actions.insertText(mention, actions.captureInsertion()) === true };
        }
      } catch (error) {
        return { mode: "unavailable", ok: false };
      }
      return { mode: "unavailable", ok: false };
    }

    function chatInsertOutcome(t, result, path, cwd, type) {
      if (result && result.ok === true) return { tone: "info", text: format(t("addToChat.added"), { name: baseName(toPosix(path)) || path }) };
      const key = buildMention(path, cwd, type) === null ? "addToChat.invalidPath" : result && result.mode === "unavailable" ? "addToChat.unavailable" : "addToChat.failed";
      return { tone: "error", text: t(key) };
    }

    function getRootService(name) {
      try {
        return clientCtx !== null && typeof clientCtx.get === "function" ? clientCtx.get(name) : null;
      } catch (error) {
        return null;
      }
    }

    function sessionCwdFromRoot(sessionId) {
      try {
        const sessions = getRootService("sessions");
        const byId = sessions && sessions.list && typeof sessions.list.getSnapshot === "function" ? sessions.list.getSnapshot().byId : null;
        const session = byId ? byId[sessionId] : null;
        return session && typeof session.cwd === "string" ? session.cwd : "";
      } catch (error) {
        return "";
      }
    }


    // ---------------------------------------------------------------------------
    // Dictionaries: the Chinese dictionary is the key-set source of truth.
    // ---------------------------------------------------------------------------

    const zh = {
      "type.label": "文件夹资源管理器",
      "guide.title": "文件夹资源管理器",
      "guide.description": "打开任意文件夹并管理其中的文件",
      "toolbar.openFolder": "打开文件夹…",
      "toolbar.refresh": "刷新",
      "toolbar.newFile": "新建文件",
      "toolbar.newFolder": "新建文件夹",
      "toolbar.noRoot": "未打开文件夹",
      "tree.ariaLabel": "文件夹内容",
      "state.noRootTitle": "未打开文件夹",
      "state.noRootDescription": "选择一个本地文件夹，即可浏览并管理其中的文件。",
      "state.noWorkspace": "当前会话没有工作目录，请手动打开一个文件夹。",
      "state.noSession": "当前没有会话，仍可打开本地文件夹浏览。",
      loading: "正在读取…",
      empty: "空文件夹",
      truncated: "仅显示前 {count} 项",
      loadFailed: "读取失败：{message}",
      retry: "重试",
      "entry.other": "这不是普通文件或文件夹，无法打开。",
      "menu.ariaLabel": "文件操作菜单",
      "menu.open": "打开",
      "menu.copy": "复制",
      "menu.paste": "粘贴",
      "menu.newFile": "新建文件",
      "menu.newFolder": "新建文件夹",
      "menu.rename": "重命名",
      "menu.delete": "删除",
      "menu.reveal": "在文件管理器中显示",
      "menu.openWith": "用外部应用打开",
      "menu.copyPath": "复制绝对路径",
      "menu.copyRelativePath": "复制相对路径",
      "dialog.cancel": "取消",
      "dialog.create": "创建",
      "dialog.delete": "删除",
      "dialog.chooseFolder": "选择此文件夹",
      "dialog.close": "关闭",
      "dialog.working": "处理中…",
      "dialog.createFileTitle": "新建文件",
      "dialog.createFolderTitle": "新建文件夹",
      "dialog.nameLabel": "名称",
      "dialog.namePlaceholder": "输入名称",
      "dialog.location": "位置：{path}",
      "dialog.deleteTitle": "删除确认",
      "dialog.deleteBody": "确定要永久删除这 {count} 个项目吗？",
      "dialog.deleteWarning": "此操作会永久删除，无法恢复。",
      "dialog.deleteMore": "以及另外 {count} 个项目…",
      "dialog.deleteListLabel": "要删除的项目",
      "dialog.conflictTitle": "存在同名项目",
      "dialog.conflictBody": "目标文件夹中已有 {count} 个同名项目，请选择处理方式：",
      "dialog.conflictPolicyLabel": "冲突处理方式",
      "dialog.conflictRename": "保留两者",
      "dialog.conflictRenameHint": "自动为新项目生成不冲突的名称",
      "dialog.conflictSkip": "跳过",
      "dialog.conflictSkipHint": "不复制同名项目",
      "dialog.conflictOverwrite": "覆盖",
      "dialog.conflictOverwriteHint": "用新项目替换同名项目",
      "dialog.openFolderTitle": "打开文件夹",
      "dialog.openFolderPathLabel": "路径",
      "dialog.openFolderGo": "前往",
      "dialog.openFolderUp": "上级文件夹",
      "dialog.openFolderUseSession": "使用当前会话目录",
      "dialog.openFolderEmpty": "此文件夹下没有子文件夹。",
      "dialog.openFolderHint": "浏览并选择要打开的文件夹。",
      "dialog.appsTitle": "用外部应用打开",
      "dialog.appsBody": "选择要打开此文件的应用：",
      "dialog.appsDefault": "（默认）",
      "toast.itemCopied": "已复制，可粘贴到其他文件夹",
      "toast.pathCopied": "已复制路径",
      "toast.copyFailed": "复制失败：无法访问剪贴板",
      "toast.renamed": "已重命名",
      "toast.createdFile": "已创建文件",
      "toast.createdFolder": "已创建文件夹",
      "toast.deleted": "已删除 {count} 个项目",
      "toast.pasteCopied": "已复制 {count} 个",
      "toast.pasteSkipped": "已跳过 {count} 个",
      "toast.pasteRenamed": "已重命名保存 {count} 个",
      "toast.pasteDone": "粘贴完成",
      "toast.separator": "，",
      "toast.revealed": "已在文件管理器中显示",
      "toast.openedWith": "已用 {app} 打开",
      "toast.openWithFailed": "无法用外部应用打开",
      "toast.noApplications": "没有可用的外部应用",
      "toast.noResource": "无法打开文件：当前不可预览",
      "toast.noSession": "当前没有会话，无法预览文件",
      "toast.pasteEmpty": "剪贴板为空，请先复制文件或文件夹",
      "toast.pasteIntoSelf": "不能把文件夹粘贴到它自身或子文件夹中",
      "toast.busy": "正在处理上一个操作，请稍后再试",
      "errors.unknown": "操作失败：{message}",
      "errors.bad-request": "请求无效。",
      "errors.invalid-name": "名称无效：不能为空、不能包含路径分隔符，也不能是 . 或 ..",
      "errors.invalid-path": "路径无效。",
      "errors.outside-root": "该路径不在当前打开的文件夹内。",
      "errors.not-found": "目标不存在，可能已被移动或删除。",
      "errors.already-exists": "同名项目已存在。",
      "errors.not-directory": "目标不是文件夹。",
      "errors.is-directory": "目标是一个文件夹。",
      "errors.permission-denied": "没有权限执行此操作。",
      "errors.busy": "另一个文件操作正在进行，请稍后再试。",
      "errors.unsupported": "此操作不受支持。",
      "errors.internal": "内部错误，请重试。",
      "addToChat.menu": "添加到对话",
      "addToChat.added": "已添加 {name}",
      "addToChat.unavailable": "暂时无法添加",
      "addToChat.failed": "添加失败",
      "addToChat.invalidPath": "路径无效",
    };

    const en = {
      "type.label": "Folder Explorer",
      "guide.title": "Folder Explorer",
      "guide.description": "Open any folder and manage the files inside it",
      "toolbar.openFolder": "Open Folder…",
      "toolbar.refresh": "Refresh",
      "toolbar.newFile": "New File",
      "toolbar.newFolder": "New Folder",
      "toolbar.noRoot": "No folder open",
      "tree.ariaLabel": "Folder contents",
      "state.noRootTitle": "No folder open",
      "state.noRootDescription": "Choose a local folder to browse and manage its files.",
      "state.noWorkspace": "This session has no workspace directory. Open a folder manually.",
      "state.noSession": "There is no active session, but you can still open a local folder.",
      loading: "Reading…",
      empty: "Empty folder",
      truncated: "Showing only the first {count} entries",
      loadFailed: "Could not read: {message}",
      retry: "Retry",
      "entry.other": "This is not a regular file or folder, so it cannot be opened.",
      "menu.ariaLabel": "File actions",
      "menu.open": "Open",
      "menu.copy": "Copy",
      "menu.paste": "Paste",
      "menu.newFile": "New File",
      "menu.newFolder": "New Folder",
      "menu.rename": "Rename",
      "menu.delete": "Delete",
      "menu.reveal": "Show in File Manager",
      "menu.openWith": "Open With…",
      "menu.copyPath": "Copy Absolute Path",
      "menu.copyRelativePath": "Copy Relative Path",
      "dialog.cancel": "Cancel",
      "dialog.create": "Create",
      "dialog.delete": "Delete",
      "dialog.chooseFolder": "Choose This Folder",
      "dialog.close": "Close",
      "dialog.working": "Working…",
      "dialog.createFileTitle": "New File",
      "dialog.createFolderTitle": "New Folder",
      "dialog.nameLabel": "Name",
      "dialog.namePlaceholder": "Enter a name",
      "dialog.location": "Location: {path}",
      "dialog.deleteTitle": "Confirm Delete",
      "dialog.deleteBody": "Permanently delete these {count} items?",
      "dialog.deleteWarning": "This permanently deletes them and cannot be undone.",
      "dialog.deleteMore": "and {count} more…",
      "dialog.deleteListLabel": "Items to delete",
      "dialog.conflictTitle": "Name Conflicts",
      "dialog.conflictBody": "{count} items already exist in the target folder. Choose how to handle them:",
      "dialog.conflictPolicyLabel": "Conflict handling",
      "dialog.conflictRename": "Keep Both",
      "dialog.conflictRenameHint": "Give the new items non-conflicting names",
      "dialog.conflictSkip": "Skip",
      "dialog.conflictSkipHint": "Do not copy items that already exist",
      "dialog.conflictOverwrite": "Overwrite",
      "dialog.conflictOverwriteHint": "Replace existing items with the new ones",
      "dialog.openFolderTitle": "Open Folder",
      "dialog.openFolderPathLabel": "Path",
      "dialog.openFolderGo": "Go",
      "dialog.openFolderUp": "Parent Folder",
      "dialog.openFolderUseSession": "Use Session Directory",
      "dialog.openFolderEmpty": "No subfolders here.",
      "dialog.openFolderHint": "Browse and choose the folder to open.",
      "dialog.appsTitle": "Open With",
      "dialog.appsBody": "Choose an application to open this file:",
      "dialog.appsDefault": " (default)",
      "toast.itemCopied": "Copied; paste it into another folder",
      "toast.pathCopied": "Path copied",
      "toast.copyFailed": "Copy failed: the clipboard is unavailable",
      "toast.renamed": "Renamed",
      "toast.createdFile": "File created",
      "toast.createdFolder": "Folder created",
      "toast.deleted": "Deleted {count} items",
      "toast.pasteCopied": "Copied {count}",
      "toast.pasteSkipped": "Skipped {count}",
      "toast.pasteRenamed": "Saved {count} with new names",
      "toast.pasteDone": "Paste finished",
      "toast.separator": ", ",
      "toast.revealed": "Shown in the file manager",
      "toast.openedWith": "Opened with {app}",
      "toast.openWithFailed": "Could not open with an external application",
      "toast.noApplications": "No external application is available",
      "toast.noResource": "Could not open the file: preview is unavailable",
      "toast.noSession": "There is no active session, so the file cannot be previewed",
      "toast.pasteEmpty": "The clipboard is empty; copy a file or folder first",
      "toast.pasteIntoSelf": "A folder cannot be pasted into itself or its descendants",
      "toast.busy": "Another file operation is still running; try again shortly",
      "errors.unknown": "Operation failed: {message}",
      "errors.bad-request": "The request was invalid.",
      "errors.invalid-name": "Invalid name: it cannot be empty, contain path separators, or be . or ..",
      "errors.invalid-path": "The path is invalid.",
      "errors.outside-root": "That path is outside the folder currently open.",
      "errors.not-found": "The target no longer exists; it may have been moved or deleted.",
      "errors.already-exists": "An item with that name already exists.",
      "errors.not-directory": "The target is not a folder.",
      "errors.is-directory": "The target is a folder.",
      "errors.permission-denied": "You do not have permission to do that.",
      "errors.busy": "Another file operation is in progress; try again shortly.",
      "errors.unsupported": "That operation is not supported.",
      "errors.internal": "Internal error; please try again.",
      "addToChat.menu": "Add to Chat",
      "addToChat.added": "Added {name}",
      "addToChat.unavailable": "Unable to add",
      "addToChat.failed": "Add failed",
      "addToChat.invalidPath": "Bad path",
    };

    /** Translation fallback used only if the locale service did not inject one. */
    function defaultTranslate(key, params) {
      const template = typeof en[key] === "string" ? en[key] : key;
      return format(template, params);
    }

    // ---------------------------------------------------------------------------
    // Inline SVG icons
    // ---------------------------------------------------------------------------

    function FolderGlyph(props) {
      const options = props || {};
      const size = typeof options.size === "number" ? options.size : 20;
      return h("svg", {
        className: options.className,
        width: size,
        height: size,
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", {
          d: "M2.6 5.3c0-.7.55-1.25 1.25-1.25h3.5c.33 0 .65.13.88.37l1.1 1.08h6.82c.7 0 1.25.56 1.25 1.25v8c0 .7-.55 1.25-1.25 1.25H3.85c-.7 0-1.25-.56-1.25-1.25V5.3Z",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinejoin: "round",
        }));
    }

    function FolderIcon(props) {
      const options = props || {};
      const open = options.open === true;
      return h("svg", {
        className: "dfe-icon",
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", {
          d: open
            ? "M2.6 5.3c0-.7.55-1.25 1.25-1.25h3.5c.33 0 .65.13.88.37l1.1 1.08h6.82c.7 0 1.25.56 1.25 1.25v.9H2.6V5.3Zm.4 3.35h14.9c.78 0 1.32.77 1.06 1.5l-1.72 4.6c-.16.43-.57.72-1.03.72H3.85c-.7 0-1.25-.56-1.25-1.25V8.65h.4Z"
            : "M2.6 5.3c0-.7.55-1.25 1.25-1.25h3.5c.33 0 .65.13.88.37l1.1 1.08h6.82c.7 0 1.25.56 1.25 1.25v8c0 .7-.55 1.25-1.25 1.25H3.85c-.7 0-1.25-.56-1.25-1.25V5.3Z",
          stroke: "currentColor",
          strokeWidth: "1.25",
          strokeLinejoin: "round",
        }));
    }

    function ChevronIcon(props) {
      const options = props || {};
      return h("svg", {
        className: "dfe-chevron" + (options.leaf === true ? " dfe-chevron--leaf" : ""),
        viewBox: "0 0 12 12",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
        "data-open": options.open === true ? "true" : "false",
      },
        h("path", {
          d: "M4.2 2.6 7.6 6l-3.4 3.4",
          stroke: "currentColor",
          strokeWidth: "1.4",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }));
    }

    function RefreshIcon() {
      return h("svg", {
        className: "dfe-tool-icon",
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", {
          d: "M16.2 8.4A6.3 6.3 0 1 0 16.4 12",
          stroke: "currentColor",
          strokeWidth: "1.4",
          strokeLinecap: "round",
        }),
        h("path", { d: "M16.6 4.4v4h-4", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }));
    }

    function NewFileIcon() {
      return h("svg", {
        className: "dfe-tool-icon",
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", { d: "M4.6 2.8h6.1l3.9 3.9v10.5H4.6V2.8Z", stroke: "currentColor", strokeWidth: "1.25", strokeLinejoin: "round" }),
        h("path", { d: "M10.6 2.9v4h4", stroke: "currentColor", strokeWidth: "1.25", strokeLinejoin: "round" }),
        h("path", { d: "M9.4 11.4v4", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round" }),
        h("path", { d: "M7.4 13.4h4", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round" }));
    }

    function NewFolderIcon() {
      return h("svg", {
        className: "dfe-tool-icon",
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", {
          d: "M2.6 5.3c0-.7.55-1.25 1.25-1.25h3.5c.33 0 .65.13.88.37l1.1 1.08h6.82c.7 0 1.25.56 1.25 1.25v8c0 .7-.55 1.25-1.25 1.25H3.85c-.7 0-1.25-.56-1.25-1.25V5.3Z",
          stroke: "currentColor",
          strokeWidth: "1.25",
          strokeLinejoin: "round",
        }),
        h("path", { d: "M10 9.2v4.4", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round" }),
        h("path", { d: "M7.8 11.4h4.4", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round" }));
    }

    function OpenFolderIcon() {
      return h("svg", {
        className: "dfe-tool-icon",
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", {
          d: "M2.6 5.3c0-.7.55-1.25 1.25-1.25h3.5c.33 0 .65.13.88.37l1.1 1.08h6.82c.7 0 1.25.56 1.25 1.25v8c0 .7-.55 1.25-1.25 1.25H3.85c-.7 0-1.25-.56-1.25-1.25V5.3Z",
          stroke: "currentColor",
          strokeWidth: "1.25",
          strokeLinejoin: "round",
        }),
        h("path", { d: "M8 9.2v4.2M8 13.4l-1.8-1.8M8 13.4l1.8-1.8", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round", strokeLinejoin: "round" }));
    }

    function CloseIcon() {
      return h("svg", {
        className: "dfe-tool-icon",
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", { d: "m5.4 5.4 9.2 9.2M14.6 5.4l-9.2 9.2", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }));
    }


    function AddToChatIcon() {
      return h("svg", { width: 16, height: 16, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M3.3 4.3h13.4v9H10.4L6.1 16.4v-3.1H3.3z", stroke: "currentColor", strokeWidth: "1.3", strokeLinejoin: "round" }),
        h("path", { d: "M10 6.6v3.9M8.05 8.55h3.9", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }));
    }

    // Generated icon data for client.js — DO NOT EDIT BY HAND.
    // File + folder icons from Material Icon Theme (MIT); folder open variants are
    // generated from the canonical open-folder path. Original "other" icon.
    const ICON_DEFS = {
      "ts": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M2 2v12h12V2zm4 6h3v1H8v4H7V9H6zm5 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1",
            fill: "#0288d1"
          }
        ]
      },
      "js": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M2 2v12h12V2zm6 6h1v4a1.003 1.003 0 0 1-1 1H7a1.003 1.003 0 0 1-1-1v-1h1v1h1zm3 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1",
            fill: "#ffca28"
          }
        ]
      },
      "react": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6",
            fill: "#00bcd4"
          },
          {
            d: "M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2",
            fill: "#00bcd4"
          },
          {
            d: "M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z",
            fill: "#00bcd4"
          },
          {
            d: "M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369",
            fill: "#00bcd4"
          }
        ]
      },
      "json": {
        viewBox: "0 -960 960 960",
        paths: [
          {
            d: "M560-160v-80h120q17 0 28.5-11.5T720-280v-80q0-38 22-69t58-44v-14q-36-13-58-44t-22-69v-80q0-17-11.5-28.5T680-720H560v-80h120q50 0 85 35t35 85v80q0 17 11.5 28.5T840-560h40v160h-40q-17 0-28.5 11.5T800-360v80q0 50-35 85t-85 35zm-280 0q-50 0-85-35t-35-85v-80q0-17-11.5-28.5T120-400H80v-160h40q17 0 28.5-11.5T160-600v-80q0-50 35-85t85-35h120v80H280q-17 0-28.5 11.5T240-680v80q0 38-22 69t-58 44v14q36 13 58 44t22 69v80q0 17 11.5 28.5T280-240h120v80z",
            fill: "#f9a825"
          }
        ]
      },
      "md": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z",
            fill: "#42a5f5"
          }
        ]
      },
      "html": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z",
            fill: "#e65100"
          }
        ]
      },
      "css": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M20 18h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 20 22h2v2h2v-2c0-.388-.562-.851-1.254-1.034C20.356 20.34 20 18.84 20 18m-3.254 2.966C14.356 20.34 14 18.84 14 18h-2v-2h-2v8h2v-2h4v2h2v-2c0-.388-.562-.851-1.254-1.034",
            fill: "#7e57c2"
          },
          {
            d: "M24 4H4v20a4 4 0 0 0 4 4h16.16A3.84 3.84 0 0 0 28 24.16V8a4 4 0 0 0-4-4m2 14h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 26 22v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2Z",
            fill: "#7e57c2"
          }
        ]
      },
      "scss": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M27.837 5.673a4.33 4.33 0 0 0-2.293-2.701c-2.362-1.261-6.11-1.298-9.548-.092a26.3 26.3 0 0 0-8.76 4.966c-2.752 2.542-3.438 4.925-3.189 6.194.523 2.668 3.274 4.539 5.485 6.042.418.284.822.559 1.175.816-1.429.76-4.261 2.444-5.088 4.248a3.88 3.88 0 0 0-.118 3.332A2.37 2.37 0 0 0 6.869 29.8a5.6 5.6 0 0 0 1.49.2 6.35 6.35 0 0 0 5.19-2.856 6.74 6.74 0 0 0 .864-5.382 7.3 7.3 0 0 1 2.044-.03 3.92 3.92 0 0 1 2.816 1.311 1.82 1.82 0 0 1 .423 1.262 1.55 1.55 0 0 1-.772 1.05c-.234.14-.586.355-.504.803.036.194.198.633.894.512a2.93 2.93 0 0 0 2.145-2.651 4 4 0 0 0-1.197-2.904 5.94 5.94 0 0 0-4.396-1.626 10.6 10.6 0 0 0-2.672.304 20 20 0 0 0-2.203-1.846c-1.712-1.3-3.33-2.529-3.235-4.26.125-2.263 2.468-4.532 6.964-6.744 4.016-1.976 7.254-2.037 8.944-1.438a2 2 0 0 1 1.204.883 2.77 2.77 0 0 1-.36 2.47 9.71 9.71 0 0 1-7.425 4.304 3.86 3.86 0 0 1-3.238-.757c-.278-.302-.593-.645-1.074-.383q-.565.31-.225 1.189a3.9 3.9 0 0 0 2.407 1.92 11.7 11.7 0 0 0 7.128-.671c3.527-1.35 6.681-5.202 5.756-8.787M11.895 24.475a4 4 0 0 1-.192.468 4.5 4.5 0 0 1-.753 1.081 2.83 2.83 0 0 1-2.533 1.107c-.056-.032-.078-.146-.085-.193a3.28 3.28 0 0 1 1.076-2.284 11.3 11.3 0 0 1 2.644-1.933 3.85 3.85 0 0 1-.157 1.754",
            fill: "#ec407a"
          }
        ]
      },
      "less": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M8 3a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2H3v2h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2v-2H8v-5a2 2 0 0 0-2-2 2 2 0 0 0 2-2V5h2V3m6 0a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1v2h-1a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2v-2h2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5h-2V3z",
            fill: "#0277bd"
          }
        ]
      },
      "yaml": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M13 9h5.5L13 3.5zM6 2h8l6 6v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2m12 16v-2H9v2zm-4-4v-2H6v2z",
            fill: "#ff5252"
          }
        ]
      },
      "toml": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M4 6V4h8v2H9v7H7V6z",
            fill: "#cfd8dc"
          },
          {
            d: "M4 1v1H2v12h2v1H1V1zm8 0v1h2v12h-2v1h3V1z",
            fill: "#ef5350"
          }
        ]
      },
      "xml": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2m.12 13.5 3.74 3.74 1.42-1.41-2.33-2.33 2.33-2.33-1.42-1.41zm11.16 0-3.74-3.74-1.42 1.41 2.33 2.33-2.33 2.33 1.42 1.41z",
            fill: "#8bc34a"
          }
        ]
      },
      "svg": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M29.168 14.03a2.7 2.7 0 0 0-1.968-.83 2.51 2.51 0 0 0-1.929.8h-4.443l3.078-3.078a2.835 2.835 0 0 0 2.857-2.842 2.6 2.6 0 0 0-.831-1.969 2.82 2.82 0 0 0-2.014-.788 2.67 2.67 0 0 0-1.968.788 2.36 2.36 0 0 0-.812 1.922L18 11.17V6.726a2.51 2.51 0 0 0 .8-1.929 2.7 2.7 0 0 0-.832-1.968 2.745 2.745 0 0 0-3.936 0 2.7 2.7 0 0 0-.832 1.968 2.51 2.51 0 0 0 .8 1.93v4.443l-3.138-3.138a2.36 2.36 0 0 0-.812-1.922 2.66 2.66 0 0 0-1.968-.788 2.83 2.83 0 0 0-2.014.788 2.6 2.6 0 0 0-.831 1.969 2.74 2.74 0 0 0 .831 2.013 2.8 2.8 0 0 0 2.026.829l3.078 3.078H6.729a2.51 2.51 0 0 0-1.929-.8 2.7 2.7 0 0 0-1.968.831 2.745 2.745 0 0 0 0 3.937 2.7 2.7 0 0 0 1.968.832 2.51 2.51 0 0 0 1.929-.8h4.443l-3.078 3.077a2.835 2.835 0 0 0-2.857 2.842 2.6 2.6 0 0 0 .831 1.969 2.82 2.82 0 0 0 2.014.788 2.67 2.67 0 0 0 1.968-.788 2.36 2.36 0 0 0 .812-1.922L14 20.827v4.444a2.51 2.51 0 0 0-.8 1.929 2.784 2.784 0 0 0 4.768 1.968A2.7 2.7 0 0 0 18.8 27.2a2.51 2.51 0 0 0-.8-1.929v-4.444l3.138 3.138a2.36 2.36 0 0 0 .812 1.922 2.66 2.66 0 0 0 1.968.788 2.83 2.83 0 0 0 2.014-.788 2.6 2.6 0 0 0 .831-1.969 2.74 2.74 0 0 0-.831-2.013 2.8 2.8 0 0 0-2.026-.829L20.828 18h4.443a2.51 2.51 0 0 0 1.93.8 2.784 2.784 0 0 0 1.967-4.769Z",
            fill: "#ffb300"
          }
        ]
      },
      "image": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9",
            fill: "#26a69a"
          }
        ]
      },
      "zip": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M14 17h-2v-2h-2v-2h2v2h2m0-6h-2v2h2v2h-2v-2h-2V9h2V7h-2V5h2v2h2m5-4H5c-1.11 0-2 .89-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2",
            fill: "#afb42b"
          }
        ]
      },
      "pdf": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z",
            fill: "#ef5350"
          }
        ]
      },
      "word": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM7 13l1.5 7h2l1.5-3 1.5 3h2l1.5-7h1v-2h-4v2h1l-.9 4.2L13 15h-2l-1.1 2.2L9 13h1v-2H6v2z",
            fill: "#01579b"
          }
        ]
      },
      "ppt": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM8 11v2h1v6H8v1h4v-1h-1v-2h2a3 3 0 0 0 3-3 3 3 0 0 0-3-3zm5 2a1 1 0 0 1 1 1 1 1 0 0 1-1 1h-2v-2z",
            fill: "#e64a19"
          }
        ]
      },
      "table": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zm4 7.5h-4v2h1l-2 1.67L10 13h1v-2H7v2h1l3 2.5L8 18H7v2h4v-2h-1l2-1.67L14 18h-1v2h4v-2h-1l-3-2.5 3-2.5h1z",
            fill: "#8bc34a"
          }
        ]
      },
      "lock": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M25 12h-3V8a6 6 0 0 0-12 0v4H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V13a1 1 0 0 0-1-1M14 8a2 2 0 0 1 4 0v4h-4Zm2 17a4 4 0 1 1 4-4 4 4 0 0 1-4 4",
            fill: "#ffd54f"
          }
        ]
      },
      "license": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M8 1a5.5 5.5 0 0 0-4 9.26V15l4-1.5 4 1.5v-4.74A5.49 5.49 0 0 0 8 1m0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8m0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
            fill: "#ff5722"
          }
        ]
      },
      "git": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M13.172 2.828 11.78 4.22l1.91 1.91 2 2A2.986 2.986 0 0 1 20 10.81a3.25 3.25 0 0 1-.31 1.31l2.06 2a2.68 2.68 0 0 1 3.37.57 2.86 2.86 0 0 1 .88 2.117 3.02 3.02 0 0 1-.856 2.109A2.9 2.9 0 0 1 23 19.81a2.93 2.93 0 0 1-2.13-.87 2.694 2.694 0 0 1-.56-3.38l-2-2.06a3 3 0 0 1-.31.12V20a3 3 0 0 1 1.44 1.09 2.92 2.92 0 0 1 .56 1.72 2.88 2.88 0 0 1-.878 2.128 2.98 2.98 0 0 1-2.048.871 2.981 2.981 0 0 1-2.514-4.719A3 3 0 0 1 16 20v-6.38a2.96 2.96 0 0 1-1.44-1.09 2.9 2.9 0 0 1-.56-1.72 2.9 2.9 0 0 1 .31-1.31l-3.9-3.9-7.579 7.572a4 4 0 0 0-.001 5.658l10.342 10.342a4 4 0 0 0 5.656 0l10.344-10.344a4 4 0 0 0 0-5.656L18.828 2.828a4 4 0 0 0-5.656 0",
            fill: "#e64a19"
          }
        ]
      },
      "python": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711",
            fill: "#0288d1"
          },
          {
            d: "M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89",
            fill: "#fdd835"
          }
        ]
      },
      "go": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4zm16.954-5H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .003-1.5",
            fill: "#00acc1"
          },
          {
            d: "M26.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z",
            fill: "#00acc1"
          }
        ]
      },
      "rust": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10",
            fill: "#ff7043"
          }
        ]
      },
      "java": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M4 26h24v2H4zM28 4H7a1 1 0 0 0-1 1v13a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 8h-4V6h4Z",
            fill: "#f44336"
          }
        ]
      },
      "docker": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M21.81 10.25c-.06-.04-.56-.43-1.64-.43-.28 0-.56.03-.84.08-.21-1.4-1.38-2.11-1.43-2.14l-.29-.17-.18.27c-.24.36-.43.77-.51 1.19-.2.8-.08 1.56.33 2.21-.49.28-1.29.35-1.46.35H2.62c-.34 0-.62.28-.62.63 0 1.15.18 2.3.58 3.38.45 1.19 1.13 2.07 2 2.61.98.6 2.59.94 4.42.94.79 0 1.61-.07 2.42-.22 1.12-.2 2.2-.59 3.19-1.16A8.3 8.3 0 0 0 16.78 16c1.05-1.17 1.67-2.5 2.12-3.65h.19c1.14 0 1.85-.46 2.24-.85.26-.24.45-.53.59-.87l.08-.24zm-17.96.99h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H3.85c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.43 0h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H6.28c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.47 0h1.75c.1 0 .17-.07.17-.16V9.5c0-.08-.06-.16-.17-.16H8.75c-.08 0-.15.07-.15.16v1.58c0 .09.06.16.15.16m2.44 0h1.77c.08 0 .15-.07.15-.16V9.5c0-.08-.06-.16-.15-.16h-1.77c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16M6.28 9h1.76c.08 0 .16-.09.16-.18V7.25c0-.09-.07-.16-.16-.16H6.28c-.09 0-.16.06-.16.16v1.57c.01.09.07.18.16.18m2.47 0h1.75c.1 0 .17-.09.17-.18V7.25c0-.09-.06-.16-.17-.16H8.75c-.08 0-.15.06-.15.16v1.57c0 .09.06.18.15.18m2.44 0h1.77c.08 0 .15-.09.15-.18V7.25c0-.09-.07-.16-.15-.16h-1.77c-.08 0-.15.06-.15.16v1.57c0 .09.07.18.15.18m0-2.28h1.77c.08 0 .15-.07.15-.16V5c0-.1-.07-.17-.15-.17h-1.77c-.08 0-.15.06-.15.17v1.56c0 .08.07.16.15.16m2.46 4.52h1.76c.09 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16h-1.76c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16",
            fill: "#0288d1"
          }
        ]
      },
      "database": {
        viewBox: "0 0 32 32",
        paths: [
          {
            d: "M16 24c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-8c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-12C10.477 4 6 4.895 6 6v4c0 1.1 4.475 2 10 2s10-.9 10-2V6c0-1.105-4.477-2-10-2",
            fill: "#ffca28"
          }
        ]
      },
      "console": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z",
            fill: "#ff7043"
          }
        ]
      },
      "settings": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M0 0h24v24H0z"
          },
          {
            d: "M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.6.6 0 0 0-.18-.03c-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1q.09.03.18.03c.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64zm-1.98-1.71c.04.31.05.52.05.73s-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4m0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2",
            fill: "#42a5f5"
          }
        ]
      },
      "file": {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M0 0h24v24H0z"
          },
          {
            d: "M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z",
            fill: "#42a5f5"
          }
        ]
      },
      "folder": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232",
            fill: "#8d6e63"
          }
        ]
      },
      "folderOpen": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6",
            fill: "#8d6e63"
          }
        ]
      },
      "folderSrc": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232",
            fill: "#4caf50"
          },
          {
            d: "M9.225 15a.5.5 0 0 1-.12-.014.57.568 0 0 1-.414-.661l1.549-7.872a.566.565 0 0 1 .254-.372.53.53 0 0 1 .4-.067.57.57 0 0 1 .415.662l-1.552 7.872a.56.56 0 0 1-.253.371.53.53 0 0 1-.28.081m3.105-1h-.038a.54.54 0 0 1-.382-.206.583.582 0 0 1 .057-.774l2.664-2.483-2.653-2.312a.583.582 0 0 1-.08-.772.54.54 0 0 1 .377-.218.53.53 0 0 1 .406.129l3.126 2.727a.579.578 0 0 1 .002.862l-3.114 2.904a.536.535 0 0 1-.365.144zm-4.661 0a.536.535 0 0 1-.365-.146L4.186 10.95a.58.58 0 0 1-.005-.846l.01-.01 3.128-2.726a.516.515 0 0 1 .4-.13.54.54 0 0 1 .38.218.583.582 0 0 1-.08.773l-2.65 2.31 2.663 2.482a.579.578 0 0 1 .056.774.536.535 0 0 1-.381.206z",
            fill: "#c8e6c9"
          }
        ]
      },
      "folderSrcOpen": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6",
            fill: "#4caf50"
          },
          {
            d: "M9.225 15a.5.5 0 0 1-.12-.014.57.568 0 0 1-.414-.661l1.549-7.872a.566.565 0 0 1 .254-.372.53.53 0 0 1 .4-.067.57.57 0 0 1 .415.662l-1.552 7.872a.56.56 0 0 1-.253.371.53.53 0 0 1-.28.081m3.105-1h-.038a.54.54 0 0 1-.382-.206.583.582 0 0 1 .057-.774l2.664-2.483-2.653-2.312a.583.582 0 0 1-.08-.772.54.54 0 0 1 .377-.218.53.53 0 0 1 .406.129l3.126 2.727a.579.578 0 0 1 .002.862l-3.114 2.904a.536.535 0 0 1-.365.144zm-4.661 0a.536.535 0 0 1-.365-.146L4.186 10.95a.58.58 0 0 1-.005-.846l.01-.01 3.128-2.726a.516.515 0 0 1 .4-.13.54.54 0 0 1 .38.218.583.582 0 0 1-.08.773l-2.65 2.31 2.663 2.482a.579.578 0 0 1 .056.774.536.535 0 0 1-.381.206z",
            fill: "#c8e6c9"
          }
        ]
      },
      "folderNode": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232",
            fill: "#8bc34a"
          },
          {
            d: "M12.5 6 9 8.036v3.927L12.5 14l3.5-2.037V8.036Z",
            fill: "#dcedc8"
          }
        ]
      },
      "folderNodeOpen": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6",
            fill: "#8bc34a"
          },
          {
            d: "M12.5 6 9 8.036v3.927L12.5 14l3.5-2.037V8.036Z",
            fill: "#dcedc8"
          }
        ]
      },
      "folderDist": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232",
            fill: "#e57373"
          },
          {
            d: "M15 7h-2V6l-1-1h-2L9 6v1H7a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1m-5 0V6h2v1z",
            fill: "#ffcdd2"
          }
        ]
      },
      "folderDistOpen": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6",
            fill: "#e57373"
          },
          {
            d: "M15 7h-2V6l-1-1h-2L9 6v1H7a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1m-5 0V6h2v1z",
            fill: "#ffcdd2"
          }
        ]
      },
      "folderGit": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232",
            fill: "#ff7043"
          },
          {
            d: "m6.297 9.295 2.892-2.897.846.85a.99.99 0 0 0 .465 1.116v2.772a1 1 0 0 0-.5.865 1.001 1.001 0 0 0 2.001 0 1 1 0 0 0-.5-.865V8.704l1.035 1.046a.6.6 0 0 0-.035.25 1.001 1.001 0 1 0 1.001-1.001.6.6 0 0 0-.25.035l-1.287-1.285a.99.99 0 0 0-.575-1.171 1.05 1.05 0 0 0-.64-.045l-.851-.846.396-.39a.987.987 0 0 1 1.41 0l3.998 3.998a.987.987 0 0 1 0 1.41l-3.998 3.998a.987.987 0 0 1-1.41 0l-3.998-3.998a.987.987 0 0 1 0-1.41",
            fill: "#ffccbc"
          }
        ]
      },
      "folderGitOpen": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6",
            fill: "#ff7043"
          },
          {
            d: "m6.297 9.295 2.892-2.897.846.85a.99.99 0 0 0 .465 1.116v2.772a1 1 0 0 0-.5.865 1.001 1.001 0 0 0 2.001 0 1 1 0 0 0-.5-.865V8.704l1.035 1.046a.6.6 0 0 0-.035.25 1.001 1.001 0 1 0 1.001-1.001.6.6 0 0 0-.25.035l-1.287-1.285a.99.99 0 0 0-.575-1.171 1.05 1.05 0 0 0-.64-.045l-.851-.846.396-.39a.987.987 0 0 1 1.41 0l3.998 3.998a.987.987 0 0 1 0 1.41l-3.998 3.998a.987.987 0 0 1-1.41 0l-3.998-3.998a.987.987 0 0 1 0-1.41",
            fill: "#ffccbc"
          }
        ]
      },
      "folderDocs": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232",
            fill: "#0277bd"
          },
          {
            d: "M12 5H8.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V8Zm0 8H9v-1h3zm2-2H9v-1h5zm-2.414-2.586V6L14 8.414Z",
            fill: "#b3e5fc"
          }
        ]
      },
      "folderDocsOpen": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6",
            fill: "#0277bd"
          },
          {
            d: "M12 5H8.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V8Zm0 8H9v-1h3zm2-2H9v-1h5zm-2.414-2.586V6L14 8.414Z",
            fill: "#b3e5fc"
          }
        ]
      },
      "folderConfig": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232",
            fill: "#00acc1"
          },
          {
            d: "M11.5 12.075A1.6 1.6 0 0 1 9.882 10.5a1.62 1.62 0 1 1 1.62 1.575m3.437-1.138a4 4 0 0 0 .032-.438 4 4 0 0 0-.032-.45l.976-.733a.223.223 0 0 0 .056-.288l-.926-1.556a.23.23 0 0 0-.283-.1l-1.15.45a3.4 3.4 0 0 0-.783-.44l-.171-1.193A.23.23 0 0 0 12.425 6h-1.85a.23.23 0 0 0-.231.189l-.171 1.193a3.4 3.4 0 0 0-.781.44l-1.152-.45a.23.23 0 0 0-.282.1l-.926 1.556a.22.22 0 0 0 .056.288l.975.734a4 4 0 0 0-.032.45 4 4 0 0 0 .032.437l-.975.746a.22.22 0 0 0-.056.288l.925 1.558a.235.235 0 0 0 .283.099l1.152-.455a3.2 3.2 0 0 0 .781.446l.171 1.192a.23.23 0 0 0 .232.189h1.85a.23.23 0 0 0 .232-.189l.17-1.192a3.4 3.4 0 0 0 .783-.446l1.15.455a.24.24 0 0 0 .284-.1l.924-1.557a.223.223 0 0 0-.055-.288Z",
            fill: "#80deea"
          }
        ]
      },
      "folderConfigOpen": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6",
            fill: "#00acc1"
          },
          {
            d: "M11.5 12.075A1.6 1.6 0 0 1 9.882 10.5a1.62 1.62 0 1 1 1.62 1.575m3.437-1.138a4 4 0 0 0 .032-.438 4 4 0 0 0-.032-.45l.976-.733a.223.223 0 0 0 .056-.288l-.926-1.556a.23.23 0 0 0-.283-.1l-1.15.45a3.4 3.4 0 0 0-.783-.44l-.171-1.193A.23.23 0 0 0 12.425 6h-1.85a.23.23 0 0 0-.231.189l-.171 1.193a3.4 3.4 0 0 0-.781.44l-1.152-.45a.23.23 0 0 0-.282.1l-.926 1.556a.22.22 0 0 0 .056.288l.975.734a4 4 0 0 0-.032.45 4 4 0 0 0 .032.437l-.975.746a.22.22 0 0 0-.056.288l.925 1.558a.235.235 0 0 0 .283.099l1.152-.455a3.2 3.2 0 0 0 .781.446l.171 1.192a.23.23 0 0 0 .232.189h1.85a.23.23 0 0 0 .232-.189l.17-1.192a3.4 3.4 0 0 0 .783-.446l1.15.455a.24.24 0 0 0 .284-.1l.924-1.557a.223.223 0 0 0-.055-.288Z",
            fill: "#80deea"
          }
        ]
      },
      "other": {
        viewBox: "0 0 16 16",
        paths: [
          {
            d: "M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Zm0 1.4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z",
            fill: "#8b949e"
          },
          {
            d: "M8 4.6c.4 0 .8.3.8.8v3.2a.8.8 0 0 1-1.6 0V5.4c0-.5.4-.8.8-.8Zm0 6.4a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z",
            fill: "#8b949e"
          }
        ]
      }
    };

    const FILE_ICON_MAP = {
      "exactNames": {
        "package.json": "json",
        "package-lock.json": "lock",
        "pnpm-lock.yaml": "lock",
        "yarn.lock": "lock",
        "cargo.lock": "lock",
        "dockerfile": "docker",
        "makefile": "console",
        "license": "license",
        "licence": "license",
        "copying": "license",
        ".gitignore": "git",
        ".gitattributes": "git",
        ".gitmodules": "git",
        ".npmrc": "settings",
        ".editorconfig": "settings"
      },
      "extensions": {
        "ts": "ts",
        "mts": "ts",
        "cts": "ts",
        "tsx": "react",
        "jsx": "react",
        "js": "js",
        "mjs": "js",
        "cjs": "js",
        "json": "json",
        "jsonc": "json",
        "json5": "json",
        "md": "md",
        "mdx": "md",
        "html": "html",
        "htm": "html",
        "css": "css",
        "scss": "scss",
        "sass": "scss",
        "less": "less",
        "yaml": "yaml",
        "yml": "yaml",
        "toml": "toml",
        "xml": "xml",
        "svg": "svg",
        "png": "image",
        "jpg": "image",
        "jpeg": "image",
        "gif": "image",
        "webp": "image",
        "ico": "image",
        "bmp": "image",
        "avif": "image",
        "zip": "zip",
        "tar": "zip",
        "gz": "zip",
        "tgz": "zip",
        "bz2": "zip",
        "xz": "zip",
        "7z": "zip",
        "rar": "zip",
        "zst": "zip",
        "pdf": "pdf",
        "doc": "word",
        "docx": "word",
        "rtf": "word",
        "odt": "word",
        "ppt": "ppt",
        "pptx": "ppt",
        "odp": "ppt",
        "xls": "table",
        "xlsx": "table",
        "csv": "table",
        "tsv": "table",
        "ods": "table",
        "lock": "lock",
        "sh": "console",
        "bash": "console",
        "zsh": "console",
        "fish": "console",
        "ps1": "console",
        "bat": "console",
        "cmd": "console",
        "py": "python",
        "go": "go",
        "rs": "rust",
        "java": "java",
        "sql": "database",
        "db": "database",
        "sqlite": "database",
        "sqlite3": "database",
        "env": "settings",
        "ini": "settings",
        "cfg": "settings",
        "conf": "settings",
        "properties": "settings",
        "txt": "file",
        "log": "file"
      },
      "folderNames": {
        ".git": "folderGit",
        ".github": "folderGit",
        "node_modules": "folderNode",
        "src": "folderSrc",
        "dist": "folderDist",
        "build": "folderDist",
        "out": "folderDist",
        "docs": "folderDocs",
        "doc": "folderDocs",
        "config": "folderConfig",
        ".config": "folderConfig"
      }
    };

    const FOLDER_ICON_MAP = FILE_ICON_MAP.folderNames;


    /** Own-property lookup; the icon maps must never match Object.prototype keys. */
    function hasOwn(object, key) {
      return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
    }

    /**
     * The icon id for one tree entry: themed folder variants (open or closed),
     * exact-name file flags, then the longest known extension suffix.
     *
     * @param {{ type?: string, name?: string }} entry one listing entry
     * @param {boolean} expanded whether a directory row is expanded
     * @returns {string} an ICON_DEFS key; never throws
     */
    function resolveIcon(entry, expanded) {
      if (entry === null || entry === undefined || typeof entry !== "object") return "file";
      const type = entry.type;
      if (type === "other") return "other";
      const rawName = typeof entry.name === "string" ? entry.name : "";
      const name = rawName.toLowerCase();
      if (type === "directory") {
        let iconId = "folder";
        if (name !== "" && hasOwn(FOLDER_ICON_MAP, name) && typeof FOLDER_ICON_MAP[name] === "string" && FOLDER_ICON_MAP[name] !== "") {
          iconId = FOLDER_ICON_MAP[name];
        }
        return expanded === true ? iconId + "Open" : iconId;
      }
      if (name === "") return "file";
      if (hasOwn(FILE_ICON_MAP.exactNames, name) && typeof FILE_ICON_MAP.exactNames[name] === "string") {
        return FILE_ICON_MAP.exactNames[name];
      }
      const segments = name.split(".");
      for (let start = 1; start < segments.length; start += 1) {
        const suffix = segments.slice(start).join(".");
        if (suffix === "") continue;
        if (hasOwn(FILE_ICON_MAP.extensions, suffix) && typeof FILE_ICON_MAP.extensions[suffix] === "string") {
          return FILE_ICON_MAP.extensions[suffix];
        }
      }
      return "file";
    }

    /** One inline SVG icon definition; decorative only, so it is hidden from AT. */
    function IconSvg(props) {
      const options = props || {};
      const requested = typeof options.id === "string" ? options.id : "file";
      let definition = hasOwn(ICON_DEFS, requested) ? ICON_DEFS[requested] : undefined;
      if (definition === undefined || definition === null) definition = ICON_DEFS.file;
      if (definition === undefined || definition === null) return null;
      const paths = Array.isArray(definition.paths) ? definition.paths : [];
      return h("svg", {
        className: "dfe-icon",
        viewBox: typeof definition.viewBox === "string" ? definition.viewBox : "0 0 16 16",
        width: 16,
        height: 16,
        "aria-hidden": "true",
        focusable: "false",
      }, paths.map(function (path, index) {
        return h("path", {
          key: index,
          d: path !== null && path !== undefined && typeof path.d === "string" ? path.d : "",
          fill: path !== null && path !== undefined && path.fill !== undefined ? path.fill : "none",
          fillRule: path !== null && path !== undefined ? path.fillRule : undefined,
          clipRule: path !== null && path !== undefined ? path.clipRule : undefined,
        });
      }));
    }

    // ---------------------------------------------------------------------------
    // Styles: theme tokens only, with light-theme fallbacks.
    // ---------------------------------------------------------------------------

    const CSS_TEXT = [
      ".dfe-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#1f2328);background:transparent;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;position:relative}",
      ".dfe-toolbar{display:flex;align-items:center;gap:4px;height:38px;padding:0 6px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));flex:none;min-width:0;box-sizing:border-box}",
      ".dfe-root-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;margin-right:6px;unicode-bidi:plaintext;direction:ltr}",
      ".dfe-toolbar-actions{display:flex;align-items:center;gap:2px;flex:none}",
      ".dfe-toolbar-sep{width:1px;height:16px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.08));margin:0 2px;flex:none}",
      ".dfe-tool{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;flex:none;box-sizing:border-box}",
      ".dfe-tool svg{width:15px;height:15px}",
      ".dfe-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dfe-tool:disabled{opacity:.4;cursor:default}",
      ".dfe-tool:focus-visible,.dfe-row:focus-visible,.dfe-btn:focus-visible,.dfe-link:focus-visible,.dfe-menu-item:focus-visible,.dfe-browse-row:focus-visible,.dfe-crumb:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4a7dff);outline-offset:-2px}",
      ".dfe-body{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 4px 12px 6px;scrollbar-gutter:stable}",
      ".dfe-tree{display:flex;flex-direction:column;min-height:100%;outline:none;border-radius:var(--dsw-radius-sm,6px)}",
      ".dfe-tree:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4a7dff);outline-offset:-2px}",
      ".dfe-row{display:flex;align-items:center;gap:6px;width:100%;min-width:0;padding:3px 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-height:26px;box-sizing:border-box;user-select:none}",
      ".dfe-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dfe-row[aria-selected='true']{background:var(--dsw-alias-interactive-bg-active,rgba(64,120,255,.13))}",
      ".dfe-row[data-dfe-type='other']{color:var(--dsw-alias-label-tertiary,#8b949e);cursor:default}",
      ".dfe-row-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dfe-chevron{flex:none;width:12px;height:12px;color:var(--dsw-alias-label-tertiary,#8b949e);transition:transform .12s ease}",
      ".dfe-chevron[data-open='true']{transform:rotate(90deg)}",
      ".dfe-chevron--leaf{visibility:hidden}",
      ".dfe-icon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary,#8b949e)}",
      ".dfe-note{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:3px 8px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px;white-space:pre-wrap;min-height:24px;box-sizing:border-box}",
      ".dfe-note--error{color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dfe-note-text{min-width:0;overflow-wrap:anywhere}",
      ".dfe-link{border:0;background:none;color:var(--dsw-alias-link,#0969da);cursor:pointer;font:inherit;font-size:12px;padding:0 2px;border-radius:var(--dsw-radius-xs,4px)}",
      ".dfe-link:hover{text-decoration:underline}",
      ".dfe-spinner{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.15));border-top-color:var(--dsw-alias-label-secondary,#57606a);animation:dfe-spin .8s linear infinite;display:inline-block;box-sizing:border-box}",
      "@keyframes dfe-spin{to{transform:rotate(360deg)}}",
      ".dfe-empty-state{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:18px 14px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dfe-empty-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dfe-empty-desc{margin:0;font-size:12px;line-height:1.6;max-width:32em}",
      ".dfe-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;padding:0 12px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;cursor:pointer;box-sizing:border-box}",
      ".dfe-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dfe-btn:disabled{opacity:.5;cursor:default}",
      ".dfe-btn--primary{background:var(--dsw-alias-button-primary-fill,#1f6feb);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}",
      ".dfe-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1a5fd0)}",
      ".dfe-btn--danger{color:var(--dsw-alias-state-error-primary,#cf222e);border-color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dfe-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(207,34,46,.1))}",
      ".dfe-rename-input{flex:1 1 auto;min-width:0;height:22px;padding:0 4px;border:1px solid var(--dsw-focus-ring-color,#4a7dff);border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;box-sizing:border-box}",
      ".dfe-rename-error{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#cf222e);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:11px;font-weight:700;cursor:help}",
      ".dfe-menu{position:fixed;z-index:60;min-width:200px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:4px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#fff));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));outline:none;box-sizing:border-box}",
      ".dfe-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 10px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap;box-sizing:border-box}",
      ".dfe-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dfe-menu-item:disabled{opacity:.45;cursor:default}",
      ".dfe-menu-item--danger{color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dfe-menu-item--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(207,34,46,.1))}",
      ".dfe-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
      ".dfe-modal-backdrop{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-modal-scrim,rgba(0,0,0,.28))}",
      ".dfe-modal{display:flex;flex-direction:column;width:min(460px,100%);max-height:calc(100vh - 48px);border-radius:var(--dsw-radius-lg,10px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-prominent,0 16px 40px rgba(0,0,0,.24));color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;overflow:hidden;box-sizing:border-box}",
      ".dfe-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));flex:none}",
      ".dfe-modal-title{margin:0;font-size:13px;font-weight:600}",
      ".dfe-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}",
      ".dfe-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));flex:none;flex-wrap:wrap}",
      ".dfe-input{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px}",
      ".dfe-input:focus{outline:2px solid var(--dsw-focus-ring-color,#4a7dff);outline-offset:-1px}",
      ".dfe-field-label{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dfe-dialog-text{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#57606a);overflow-wrap:anywhere}",
      ".dfe-warn{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#9a6700))}",
      ".dfe-error{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#cf222e);overflow-wrap:anywhere}",
      ".dfe-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;max-height:180px;overflow:auto}",
      ".dfe-list-item{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;padding:2px 8px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dfe-radio{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;border:1px solid transparent}",
      ".dfe-radio:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dfe-radio input{margin:2px 0 0 0;flex:none}",
      ".dfe-radio-desc{display:block;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px}",
      ".dfe-app-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}",
      ".dfe-app-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dfe-app-icon{width:16px;height:16px;border-radius:3px;flex:none}",
      ".dfe-app-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dfe-app-default{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;flex:none}",
      ".dfe-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:80;max-width:min(520px,calc(100vw - 32px));padding:8px 14px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;line-height:1.5;pointer-events:none;box-sizing:border-box}",
      ".dfe-toast[data-tone='error']{color:var(--dsw-alias-state-error-primary,#cf222e);border-color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dfe-toast:empty{display:none}",
      ".dfe-browse-crumbs{display:flex;flex-wrap:wrap;gap:2px;align-items:center;min-height:22px}",
      ".dfe-crumb{border:0;background:none;padding:1px 3px;border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-link,#0969da);cursor:pointer;font:inherit;font-size:12px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dfe-crumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dfe-crumb-sep{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;flex:none}",
      ".dfe-browse-path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);word-break:break-all;margin:0}",
      ".dfe-browse-list{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-sm,6px);max-height:220px;min-height:110px;overflow:auto;padding:4px;display:flex;flex-direction:column;gap:1px}",
      ".dfe-browse-row{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;min-height:24px;box-sizing:border-box}",
      ".dfe-browse-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
      ".dfe-browse-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".dfe-browse-status{display:flex;align-items:center;gap:8px;padding:8px 6px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}",
      ".dfe-browse-form{display:flex;gap:6px;align-items:center}",
      ".dfe-title-icon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dfe-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
    ].join("\n");

    /** Install the stylesheet once per document; repeated plugin loads refresh its text. */
    function installStyles() {
      if (typeof document === "undefined" || !document.head) return;
      const selector = 'style[data-dfe-style="' + STYLE_TAG + '"]';
      let tag = null;
      try {
        tag = document.querySelector(selector);
      } catch (error) {
        tag = null;
      }
      if (tag === null) {
        tag = document.createElement("style");
        tag.setAttribute("data-dfe-style", STYLE_TAG);
        document.head.appendChild(tag);
      }
      tag.textContent = CSS_TEXT;
    }

    /** Drop the stylesheet on plugin unload; keep it while any viewer is still mounted. */
    function removeStyles() {
      if (typeof document === "undefined") return;
      try {
        if (document.querySelector('[data-dfe-plugin="' + ID + '"]') !== null) return;
        const tag = document.querySelector('style[data-dfe-style="' + STYLE_TAG + '"]');
        if (tag !== null && tag.parentNode !== null && tag.parentNode !== undefined) {
          tag.parentNode.removeChild(tag);
        }
      } catch (error) {
        // The tag may already be gone.
      }
    }

    // ---------------------------------------------------------------------------
    // Shared presentational controls
    // ---------------------------------------------------------------------------

    function ToolButton(props) {
      return h("button", {
        type: "button",
        className: "dfe-tool",
        title: props.label,
        "aria-label": props.label,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, h(props.icon));
    }

    /** Constant polite live region; the text is the only thing that changes. */
    function ToastRegion(props) {
      const toast = props.toast;
      return h("div", {
        className: "dfe-toast",
        role: "status",
        "aria-live": "polite",
        "data-tone": toast === null ? "info" : toast.tone,
      }, toast === null ? "" : toast.message);
    }

    /** A focus-trapped sheet: Escape closes, Tab cycles inside, focus returns on unmount. */
    function Modal(props) {
      const containerRef = React.useRef(null);
      const previousFocusRef = React.useRef(null);
      React.useEffect(function () {
        previousFocusRef.current = typeof document === "undefined" ? null : document.activeElement;
        const container = containerRef.current;
        if (container !== null) {
          let target = container.querySelector("[data-autofocus]");
          if (target === null) {
            target = container.querySelector("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])");
          }
          if (target !== null && typeof target.focus === "function") {
            try {
              target.focus();
            } catch (error) {
              // Focus is best effort.
            }
          }
        }
        return function () {
          const previous = previousFocusRef.current;
          if (previous !== null && previous !== undefined && typeof previous.focus === "function") {
            try {
              if (typeof document.contains !== "function" || document.contains(previous)) previous.focus();
            } catch (error) {
              // The previous target may be gone.
            }
          }
        };
      }, []);
      function handleKeyDown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const container = containerRef.current;
        if (container === null) return;
        const focusable = Array.prototype.slice.call(container.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"));
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey === true && document.activeElement === first) {
          event.preventDefault();
          if (typeof last.focus === "function") last.focus();
        } else if (event.shiftKey !== true && document.activeElement === last) {
          event.preventDefault();
          if (typeof first.focus === "function") first.focus();
        }
      }
      return h("div", {
        className: "dfe-modal-backdrop",
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onClose();
        },
      },
        h("div", {
          className: "dfe-modal",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": props.title,
          ref: containerRef,
          onKeyDown: handleKeyDown,
        },
          h("div", { className: "dfe-modal-head" },
            h("h2", { className: "dfe-modal-title" }, props.title),
            h("button", {
              type: "button",
              className: "dfe-tool",
              "aria-label": props.closeLabel,
              title: props.closeLabel,
              onClick: props.onClose,
            }, h(CloseIcon))),
          h("div", { className: "dfe-modal-body" }, props.children),
          props.footer !== undefined && props.footer !== null
            ? h("div", { className: "dfe-modal-foot" }, props.footer)
            : null));
    }

    /** Fixed-position row menu, clamped to the viewport, with roving keyboard focus. */
    function ContextMenu(props) {
      const menuRef = React.useRef(null);
      const previousFocusRef = React.useRef(null);
      const positionState = React.useState(function () {
        return { left: props.x, top: props.y };
      });
      const position = positionState[0];
      const setPosition = positionState[1];
      React.useLayoutEffect(function () {
        const node = menuRef.current;
        if (node === null) return;
        previousFocusRef.current = typeof document === "undefined" ? null : document.activeElement;
        const rect = node.getBoundingClientRect();
        const width = rect.width > 0 ? rect.width : 220;
        const height = rect.height > 0 ? rect.height : 40;
        let left = props.x;
        let top = props.y;
        if (typeof window !== "undefined") {
          if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
          if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
        }
        if (left !== props.x || top !== props.y) setPosition({ left: left, top: top });
        const first = node.querySelector('[role="menuitem"]:not([disabled])');
        if (first !== null && typeof first.focus === "function") {
          try {
            first.focus();
          } catch (error) {
            // Focus is best effort.
          }
        }
        return function () {
          const previous = previousFocusRef.current;
          if (previous !== null && previous !== undefined && typeof previous.focus === "function") {
            try {
              if (typeof document.contains !== "function" || document.contains(previous)) previous.focus();
            } catch (error) {
              // The previous target may be gone.
            }
          }
        };
      }, []);
      React.useEffect(function () {
        function moveFocus(step) {
          const node = menuRef.current;
          if (node === null) return;
          const items = Array.prototype.slice.call(node.querySelectorAll('[role="menuitem"]:not([disabled])'));
          if (items.length === 0) return;
          const active = document.activeElement;
          let index = items.indexOf(active);
          if (index < 0) index = step > 0 ? -1 : 0;
          let next = index + step;
          if (next < 0) next = items.length - 1;
          if (next >= items.length) next = 0;
          if (typeof items[next].focus === "function") items[next].focus();
        }
        function onDocumentKeyDown(event) {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveFocus(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            moveFocus(-1);
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            const node = menuRef.current;
            if (node !== null) {
              const items = node.querySelectorAll('[role="menuitem"]:not([disabled])');
              if (items.length > 0 && typeof items[0].focus === "function") items[0].focus();
            }
            return;
          }
          if (event.key === "End") {
            event.preventDefault();
            const node = menuRef.current;
            if (node !== null) {
              const items = node.querySelectorAll('[role="menuitem"]:not([disabled])');
              if (items.length > 0) {
                const last = items[items.length - 1];
                if (typeof last.focus === "function") last.focus();
              }
            }
            return;
          }
          if (event.key === "Tab") props.onClose();
        }
        function onDocumentMouseDown(event) {
          const node = menuRef.current;
          if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
          props.onClose();
        }
        function onWindowChange() {
          props.onClose();
        }
        document.addEventListener("keydown", onDocumentKeyDown, true);
        document.addEventListener("mousedown", onDocumentMouseDown, true);
        window.addEventListener("resize", onWindowChange);
        window.addEventListener("blur", onWindowChange);
        return function () {
          document.removeEventListener("keydown", onDocumentKeyDown, true);
          document.removeEventListener("mousedown", onDocumentMouseDown, true);
          window.removeEventListener("resize", onWindowChange);
          window.removeEventListener("blur", onWindowChange);
        };
      }, []);
      const items = Array.isArray(props.items) ? props.items : [];
      return h("div", {
        className: "dfe-menu",
        role: "menu",
        "aria-label": props.label,
        ref: menuRef,
        style: { left: position.left, top: position.top },
        onContextMenu: function (event) {
          event.preventDefault();
        },
        onMouseDown: function (event) {
          event.stopPropagation();
        },
      }, items.map(function (item, index) {
        if (item.separator === true) {
          return h("div", { className: "dfe-menu-sep", role: "separator", key: "sep-" + index });
        }
        return h("button", {
          key: typeof item.id === "string" ? item.id : "item-" + index,
          type: "button",
          role: "menuitem",
          tabIndex: -1,
          className: "dfe-menu-item" + (item.danger === true ? " dfe-menu-item--danger" : ""),
          disabled: item.disabled === true,
          onClick: function () {
            if (typeof item.onSelect === "function") item.onSelect();
            props.onClose();
          },
        }, item.label);
      }));
    }

    function DialogCancelButton(props) {
      return h("button", {
        type: "button",
        className: "dfe-btn",
        onClick: props.onClick,
        disabled: props.disabled === true,
      }, props.label);
    }

    function NameDialog(props) {
      const dialog = props.dialog;
      const t = props.t;
      const busy = dialog.busy === true;
      const title = dialog.mode === "createFolder" ? t("dialog.createFolderTitle") : t("dialog.createFileTitle");
      return h(Modal, {
        title: title,
        closeLabel: t("dialog.close"),
        onClose: busy ? function () {} : props.onCancel,
        footer: [
          h(DialogCancelButton, { key: "cancel", label: t("dialog.cancel"), onClick: props.onCancel, disabled: busy }),
          h("button", {
            key: "submit",
            type: "button",
            className: "dfe-btn dfe-btn--primary",
            disabled: busy,
            onClick: props.onSubmit,
          }, busy ? t("dialog.working") : t("dialog.create")),
        ],
      },
        h("label", { className: "dfe-field-label", htmlFor: "dfe-name-input" }, t("dialog.nameLabel")),
        h("input", {
          id: "dfe-name-input",
          className: "dfe-input",
          type: "text",
          value: dialog.value,
          placeholder: t("dialog.namePlaceholder"),
          disabled: busy,
          "data-autofocus": "true",
          "aria-invalid": dialog.error !== null && dialog.error !== undefined ? "true" : undefined,
          onChange: function (event) {
            props.onChange(event.target.value);
          },
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onSubmit();
            }
          },
        }),
        dialog.error !== null && dialog.error !== undefined
          ? h("p", { className: "dfe-error", role: "alert" }, dialog.error)
          : null,
        h("p", { className: "dfe-dialog-text" }, format(t("dialog.location"), { path: dialog.targetDir })));
    }

    function DeleteDialog(props) {
      const dialog = props.dialog;
      const t = props.t;
      const busy = dialog.busy === true;
      const nodes = Array.isArray(dialog.nodes) ? dialog.nodes : [];
      const shown = nodes.slice(0, 8);
      return h(Modal, {
        title: t("dialog.deleteTitle"),
        closeLabel: t("dialog.close"),
        onClose: busy ? function () {} : props.onCancel,
        footer: [
          h("button", {
            key: "cancel",
            type: "button",
            className: "dfe-btn",
            "data-autofocus": "true",
            disabled: busy,
            onClick: props.onCancel,
          }, t("dialog.cancel")),
          h("button", {
            key: "delete",
            type: "button",
            className: "dfe-btn dfe-btn--danger",
            disabled: busy,
            onClick: props.onConfirm,
          }, busy ? t("dialog.working") : t("dialog.delete")),
        ],
      },
        h("p", { className: "dfe-dialog-text" }, format(t("dialog.deleteBody"), { count: nodes.length })),
        h("ul", { className: "dfe-list", "aria-label": t("dialog.deleteListLabel") },
          shown.map(function (node, index) {
            return h("li", { className: "dfe-list-item", key: "delete-" + index }, node.name);
          })),
        nodes.length > shown.length
          ? h("p", { className: "dfe-dialog-text" }, format(t("dialog.deleteMore"), { count: nodes.length - shown.length }))
          : null,
        h("p", { className: "dfe-warn" }, t("dialog.deleteWarning")),
        dialog.error !== null && dialog.error !== undefined
          ? h("p", { className: "dfe-error", role: "alert" }, dialog.error)
          : null);
    }

    function DialogRadio(props) {
      return h("label", { className: "dfe-radio" },
        h("input", {
          type: "radio",
          name: "dfe-conflict-policy",
          value: props.value,
          checked: props.checked,
          disabled: props.disabled === true,
          "data-autofocus": props.autofocus === true ? "true" : undefined,
          onChange: function () {
            props.onSelect(props.value);
          },
        }),
        h("span", null,
          h("span", null, props.label),
          h("span", { className: "dfe-radio-desc" }, props.description)));
    }

    function ConflictDialog(props) {
      const dialog = props.dialog;
      const t = props.t;
      const busy = dialog.busy === true;
      const conflicts = typeof dialog.conflicts === "number" ? dialog.conflicts : 0;
      const options = [
        { value: "rename", label: t("dialog.conflictRename"), description: t("dialog.conflictRenameHint") },
        { value: "skip", label: t("dialog.conflictSkip"), description: t("dialog.conflictSkipHint") },
        { value: "overwrite", label: t("dialog.conflictOverwrite"), description: t("dialog.conflictOverwriteHint") },
      ];
      return h(Modal, {
        title: t("dialog.conflictTitle"),
        closeLabel: t("dialog.close"),
        onClose: busy ? function () {} : props.onCancel,
        footer: [
          h(DialogCancelButton, { key: "cancel", label: t("dialog.cancel"), onClick: props.onCancel, disabled: busy }),
          h("button", {
            key: "paste",
            type: "button",
            className: "dfe-btn dfe-btn--primary",
            disabled: busy,
            onClick: props.onConfirm,
          }, busy ? t("dialog.working") : t("menu.paste")),
        ],
      },
        h("p", { className: "dfe-dialog-text" }, format(t("dialog.conflictBody"), { count: conflicts })),
        h("div", { role: "radiogroup", "aria-label": t("dialog.conflictPolicyLabel") },
          options.map(function (option, index) {
            return h(DialogRadio, {
              key: option.value,
              value: option.value,
              label: option.label,
              description: option.description,
              checked: dialog.policy === option.value,
              disabled: busy,
              autofocus: index === 0,
              onSelect: props.onPolicyChange,
            });
          })),
        dialog.error !== null && dialog.error !== undefined
          ? h("p", { className: "dfe-error", role: "alert" }, dialog.error)
          : null);
    }

    function AppsDialog(props) {
      const dialog = props.dialog;
      const t = props.t;
      const busy = dialog.busy === true;
      const apps = Array.isArray(dialog.apps) ? dialog.apps : [];
      return h(Modal, {
        title: t("dialog.appsTitle"),
        closeLabel: t("dialog.close"),
        onClose: busy ? function () {} : props.onCancel,
        footer: [
          h(DialogCancelButton, { key: "cancel", label: t("dialog.cancel"), onClick: props.onCancel, disabled: busy }),
        ],
      },
        h("p", { className: "dfe-dialog-text" }, t("dialog.appsBody")),
        h("div", null, apps.map(function (app, index) {
          const label = typeof app.name === "string" && app.name !== "" ? app.name : String(app.id);
          return h("button", {
            key: typeof app.id === "string" ? app.id : "app-" + index,
            type: "button",
            className: "dfe-app-row",
            "data-autofocus": index === 0 ? "true" : undefined,
            disabled: busy,
            onClick: function () {
              props.onChoose(app);
            },
          },
            typeof app.icon === "string" && app.icon !== ""
              ? h("img", { className: "dfe-app-icon", src: app.icon, alt: "", draggable: "false" })
              : h(FolderGlyph, { size: 16, className: "dfe-app-icon" }),
            h("span", { className: "dfe-app-name" }, label),
            app.default === true ? h("span", { className: "dfe-app-default" }, t("dialog.appsDefault")) : null);
        })),
        dialog.error !== null && dialog.error !== undefined
          ? h("p", { className: "dfe-error", role: "alert" }, dialog.error)
          : null);
    }

    /** The "Open Folder" browser: one level at a time, breadcrumbs, path entry. */
    function OpenFolderDialog(props) {
      const t = props.t;
      const initialPath = typeof props.initialPath === "string" ? props.initialPath : "";
      const mountedRef = React.useRef(true);
      const controllerRef = React.useRef(null);
      const viewState = React.useState(function () {
        return { status: "loading", path: initialPath, parent: null, entries: [], error: null, truncated: false };
      });
      const view = viewState[0];
      const setView = viewState[1];
      const draftState = React.useState(initialPath);
      const draft = draftState[0];
      const setDraft = draftState[1];
      const busyState = React.useState(false);
      const busy = busyState[0];
      const setBusy = busyState[1];
      const chooseErrorState = React.useState(null);
      const chooseError = chooseErrorState[0];
      const setChooseError = chooseErrorState[1];
      function load(targetPath) {
        if (controllerRef.current !== null) controllerRef.current.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        const requested = typeof targetPath === "string" && targetPath !== "" ? targetPath : null;
        setView({ status: "loading", path: requested !== null ? requested : "", parent: null, entries: [], error: null, truncated: false });
        const params = requested !== null ? { path: requested } : {};
        requestJson("browse", params, undefined, controller.signal).then(function (body) {
          if (!mountedRef.current || controller.signal.aborted) return;
          const path = typeof body.path === "string" ? body.path : requested !== null ? requested : "";
          const entries = Array.isArray(body.entries) ? body.entries : [];
          setView({
            status: "ready",
            path: path,
            parent: typeof body.parent === "string" ? body.parent : null,
            entries: entries,
            error: null,
            truncated: body.truncated === true,
          });
          setDraft(path);
          setChooseError(null);
        }).catch(function (error) {
          if (!mountedRef.current || isAbortError(error)) return;
          setView({
            status: "failed",
            path: requested !== null ? requested : "",
            parent: null,
            entries: [],
            error: toApiError(error),
            truncated: false,
          });
        });
      }
      React.useEffect(function () {
        mountedRef.current = true;
        load(initialPath);
        return function () {
          mountedRef.current = false;
          if (controllerRef.current !== null) controllerRef.current.abort();
        };
      }, []);
      function choosePath(path) {
        if (busy) return;
        setBusy(true);
        setChooseError(null);
        Promise.resolve().then(function () {
          return props.onChoose(path);
        }).catch(function (error) {
          if (!mountedRef.current) return;
          setChooseError(describeError(t, error));
        }).then(function () {
          if (mountedRef.current) setBusy(false);
        });
      }
      function chooseCurrent() {
        if (view.status !== "ready") return;
        choosePath(view.path);
      }
      function chooseSession() {
        if (typeof props.sessionCwd !== "string" || props.sessionCwd === "") return;
        choosePath(props.sessionCwd);
      }
      function submitPath(event) {
        if (event !== undefined && event !== null) event.preventDefault();
        const value = typeof draft === "string" ? draft.trim() : "";
        load(value === "" ? undefined : value);
      }
      const directories = view.status === "ready"
        ? orderEntries(view.entries.filter(function (entry) {
          return entry !== null && typeof entry === "object" && entry.type === "directory";
        }))
        : [];
      const upPath = typeof view.parent === "string" ? view.parent : parentPath(view.path);
      const crumbs = pathCrumbs(view.path);
      const footer = [];
      if (typeof props.sessionCwd === "string" && props.sessionCwd !== "") {
        footer.push(h("button", {
          key: "session",
          type: "button",
          className: "dfe-btn",
          disabled: busy,
          onClick: chooseSession,
        }, t("dialog.openFolderUseSession")));
      }
      footer.push(h(DialogCancelButton, { key: "cancel", label: t("dialog.cancel"), onClick: props.onClose, disabled: busy }));
      footer.push(h("button", {
        key: "choose",
        type: "button",
        className: "dfe-btn dfe-btn--primary",
        disabled: busy || view.status !== "ready",
        onClick: chooseCurrent,
      }, busy ? t("dialog.working") : t("dialog.chooseFolder")));
      let listContent = null;
      if (view.status === "loading") {
        listContent = h("div", { className: "dfe-browse-status" },
          h("span", { className: "dfe-spinner", "aria-hidden": "true" }),
          t("loading"));
      } else if (view.status === "failed") {
        listContent = h("div", { className: "dfe-browse-status" },
          h("span", { className: "dfe-note-text" }, describeError(t, view.error)),
          h("button", {
            type: "button",
            className: "dfe-link",
            onClick: function () {
              load(view.path === "" ? undefined : view.path);
            },
          }, t("retry")));
      } else if (directories.length === 0) {
        listContent = h("div", { className: "dfe-browse-status" }, t("dialog.openFolderEmpty"));
      } else {
        listContent = directories.map(function (entry, index) {
          return h("button", {
            key: entry.name + "-" + index,
            type: "button",
            className: "dfe-browse-row",
            onClick: function () {
              load(joinPath(view.path, entry.name));
            },
          },
            h(FolderIcon, { open: false }),
            h("span", { className: "dfe-browse-row-name" }, entry.name));
        });
      }
      return h(Modal, {
        title: t("dialog.openFolderTitle"),
        closeLabel: t("dialog.close"),
        onClose: busy ? function () {} : props.onClose,
        footer: footer,
      },
        h("form", {
          className: "dfe-browse-form",
          onSubmit: submitPath,
        },
          h("input", {
            className: "dfe-input",
            type: "text",
            value: draft,
            "data-autofocus": "true",
            "aria-label": t("dialog.openFolderPathLabel"),
            placeholder: t("dialog.openFolderPathLabel"),
            onChange: function (event) {
              setDraft(event.target.value);
            },
          }),
          h("button", { type: "submit", className: "dfe-btn" }, t("dialog.openFolderGo"))),
        crumbs.length > 0
          ? h("div", { className: "dfe-browse-crumbs", role: "navigation", "aria-label": t("dialog.openFolderPathLabel") },
            crumbs.map(function (crumb, index) {
              const parts = [];
              if (index > 0) parts.push(h("span", { key: "sep-" + index, className: "dfe-crumb-sep", "aria-hidden": "true" }, "/"));
              parts.push(h("button", {
                key: "crumb-" + index,
                type: "button",
                className: "dfe-crumb",
                title: crumb.path,
                onClick: function () {
                  load(crumb.path);
                },
              }, crumb.label));
              return parts;
            }))
          : null,
        h("p", { className: "dfe-browse-path" }, view.path === "" ? t("loading") : view.path),
        upPath !== null
          ? h("button", {
            type: "button",
            className: "dfe-browse-row",
            onClick: function () {
              load(upPath);
            },
          },
            h(ChevronIcon, { open: false }),
            h("span", { className: "dfe-browse-row-name" }, t("dialog.openFolderUp")))
          : null,
        h("div", { className: "dfe-browse-list" }, listContent),
        h("p", { className: "dfe-dialog-text" }, t("dialog.openFolderHint")),
        chooseError !== null ? h("p", { className: "dfe-error", role: "alert" }, chooseError) : null);
    }

    // ---------------------------------------------------------------------------
    // Tree row (memoized: rows only re-render when their own props change)
    // ---------------------------------------------------------------------------

    function DirectoryRowView(props) {
      const row = props.row;
      const entry = row.entry;
      const t = props.t;
      const type = entry.type === "directory" ? "directory" : entry.type === "file" ? "file" : "other";
      const isDirectory = type === "directory";
      const inputRef = React.useRef(null);
      React.useEffect(function () {
        if (props.renaming === true && inputRef.current !== null) {
          try {
            inputRef.current.focus();
            inputRef.current.select();
          } catch (error) {
            // Focus is best effort.
          }
        }
      }, [props.renaming]);
      const children = [];
      children.push(h(ChevronIcon, { key: "chevron", open: props.expanded === true, leaf: isDirectory !== true }));
      children.push(h(IconSvg, { key: "icon", id: resolveIcon(entry, props.expanded === true) }));
      if (props.renaming === true) {
        children.push(h("input", {
          key: "rename",
          ref: inputRef,
          className: "dfe-rename-input",
          type: "text",
          value: props.renamingValue,
          "aria-label": t("dialog.nameLabel"),
          "aria-invalid": props.renamingError !== null && props.renamingError !== undefined ? "true" : undefined,
          disabled: props.renamingBusy === true,
          onChange: function (event) {
            if (typeof props.onRenameChange === "function") props.onRenameChange(event.target.value);
          },
          onKeyDown: function (event) {
            if (typeof props.onRenameKeyDown === "function") props.onRenameKeyDown(event);
          },
          onBlur: function () {
            if (typeof props.onRenameBlur === "function") props.onRenameBlur();
          },
          onClick: function (event) {
            event.stopPropagation();
          },
          onContextMenu: function (event) {
            event.stopPropagation();
          },
        }));
        if (props.renamingError !== null && props.renamingError !== undefined) {
          children.push(h("span", {
            key: "rename-error",
            className: "dfe-rename-error",
            role: "alert",
            title: props.renamingError,
            "aria-label": props.renamingError,
          }, "!"));
        }
      } else {
        children.push(h("span", { key: "name", className: "dfe-row-name" }, entry.name));
      }
      const attributes = {
        role: "treeitem",
        "aria-level": row.depth + 1,
        "aria-selected": props.selected === true,
        "data-dfe-path": row.path,
        "data-dfe-type": type,
        className: "dfe-row",
        style: { paddingLeft: 8 + row.depth * 16 },
        tabIndex: -1,
        onClick: function (event) {
          event.stopPropagation();
          if (typeof props.onRowClick === "function") props.onRowClick(row);
        },
        onContextMenu: function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (typeof props.onRowContextMenu === "function") props.onRowContextMenu(row, event);
        },
      };
      if (isDirectory) attributes["aria-expanded"] = props.expanded === true;
      if (type === "other") attributes.title = t("entry.other");
      return h("div", attributes, children);
    }

    const DirectoryRow = React.memo(DirectoryRowView);

    // Defensive fallbacks: the slot framework normally injects both hooks.
    function NO_SESSIONS() {
      return undefined;
    }
    function NO_TAB_INFO() {
      return undefined;
    }

    function useSessionCwd(useSessions, sessionId) {
      const useStore = typeof useSessions === "function" ? useSessions : NO_SESSIONS;
      return useStore(function (state) {
        const byId = state ? state.byId : null;
        const session = byId && sessionId !== null && sessionId !== undefined ? byId[sessionId] : null;
        return session ? session.cwd : undefined;
      });
    }

    function AddToChatDocumentAction(rawProps) {
      const props = rawProps || {};
      const sessionId = props.sessionId;
      const cwdHook = useSessionCwd(props.useSessions, sessionId);
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const [toast, setToast] = React.useState(null);
      React.useEffect(installStyles, []);
      React.useEffect(function () {
        if (toast === null) return undefined;
        const timer = setTimeout(setToast, 3600, null);
        return function () {
          clearTimeout(timer);
        };
      }, [toast]);
      function handleClick() {
        const absolutePath = typeof props.absolutePath === "string" ? props.absolutePath : "";
        const cwd = typeof cwdHook === "string" && cwdHook !== "" ? cwdHook : sessionCwdFromRoot(sessionId);
        const outcome = insertChatReference({ conversation: getRootService("conversation"), inputActions: props.inputActions, cwd: cwd }, { sessionId: sessionId, path: absolutePath, type: "file" });
        setToast(chatInsertOutcome(t, outcome, absolutePath, cwd, "file"));
      }
      return h(React.Fragment, null,
        h("button", { type: "button", className: "dfe-tool", title: t("addToChat.menu"), "aria-label": t("addToChat.menu"), onClick: handleClick }, h(AddToChatIcon)),
        toast ? h("div", { className: "dfe-toast", role: "status", "aria-live": "polite" }, toast.text) : null);
    }

    function AddToChatTabMenuAction(rawProps) {
      const props = rawProps || {};
      const tab = props.tab;
      const parsed = parseFileAddress(tab && typeof tab.contentId === "string" ? tab.contentId : "");
      const sessionId = parsed !== null ? parsed.sessionId : props.sessionId;
      const cwd = parsed !== null ? sessionCwdFromRoot(sessionId) : "";
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const [notice, setNotice] = React.useState(null);
      React.useEffect(function () {
        installStyles();
        if (!notice) return undefined;
        const timer = setTimeout(function () {
          if (typeof props.dismiss === "function") props.dismiss();
        }, 2800);
        return function () {
          clearTimeout(timer);
        };
      }, [notice]);
      if (parsed === null || !tab || tab.kind !== "text") return null;
      function handleClick() {
        let outcome = null;
        try {
          outcome = insertChatReference({ conversation: getRootService("conversation"), inputActions: props.inputActions, cwd: cwd }, { sessionId: sessionId, path: parsed.path, type: "file" });
        } catch (error) {
          outcome = null;
        }
        if (!outcome || outcome.ok !== true) {
          setNotice(chatInsertOutcome(t, outcome, parsed.path, cwd, "file").text);
          return;
        }
        if (typeof props.dismiss === "function") props.dismiss();
      }
      return h(React.Fragment, null,
        h("button", { type: "button", role: "menuitem", className: "dfe-menu-item", onClick: handleClick }, h(AddToChatIcon), h("span", null, t("addToChat.menu"))),
        notice ? h("div", { role: "status", "aria-live": "polite" }, notice) : null);
    }

    /**
     * The explorer body: toolbar, lazily loaded tree, row menu, dialogs, toasts.
     * All hooks stay unconditional; every action is declared inside the component
     * and reached from memoized rows through actionsRef.
     */
    function ExplorerBody(rawProps) {
      const props = rawProps || {};
      const sessionId = props.sessionId;
      const useSessions = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS;
      const useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : NO_TAB_INFO;
      const tabInfo = useTabInfo();
      const providedT = typeof props.t === "function" ? props.t : defaultTranslate;
      const cwd = useSessionCwd(useSessions, sessionId);

      const treeRef = React.useRef(null);
      const mountedRef = React.useRef(false);
      const rootRef = React.useRef(null);
      const rootEpochRef = React.useRef(0);
      const levelsRef = React.useRef({});
      const expandedRef = React.useRef({});
      const pendingLevelsRef = React.useRef(new Map());
      const activeRequestsRef = React.useRef(new Set());
      const busyRef = React.useRef(null);
      const tRef = React.useRef(providedT);
      const actionsRef = React.useRef(null);
      const toastSeqRef = React.useRef(0);

      tRef.current = providedT;

      const rootState = React.useState(function () {
        const stored = readStoredRoot();
        if (stored !== null) return stored;
        if (typeof cwd === "string" && isAbsolutePath(cwd)) return cwd;
        return null;
      });
      const root = rootState[0];
      const setRoot = rootState[1];
      const levelsState = React.useState({});
      const levels = levelsState[0];
      const setLevels = levelsState[1];
      const expandedState = React.useState({});
      const expanded = expandedState[0];
      const setExpanded = expandedState[1];
      const selectedState = React.useState(null);
      const selectedPath = selectedState[0];
      const setSelectedPath = selectedState[1];
      const renamingState = React.useState(null);
      const renaming = renamingState[0];
      const setRenaming = renamingState[1];
      const menuState = React.useState(null);
      const menu = menuState[0];
      const setMenu = menuState[1];
      const dialogState = React.useState(null);
      const dialog = dialogState[0];
      const setDialog = dialogState[1];
      const openFolderState = React.useState(false);
      const openFolderOpen = openFolderState[0];
      const setOpenFolderOpen = openFolderState[1];
      const openFolderInitialState = React.useState("");
      const openFolderInitial = openFolderInitialState[0];
      const setOpenFolderInitial = openFolderInitialState[1];
      const clipboardState = React.useState(null);
      const clipboard = clipboardState[0];
      const setClipboard = clipboardState[1];
      const busyState = React.useState(null);
      const busy = busyState[0];
      const setBusy = busyState[1];
      const toastState = React.useState(null);
      const toast = toastState[0];
      const setToast = toastState[1];

      // Latest-value mirrors: async continuations and stable row dispatchers read these.
      rootRef.current = root;
      levelsRef.current = levels;
      expandedRef.current = expanded;
      busyRef.current = busy;

      const tt = React.useCallback(function (key, params) {
        return format(tRef.current(key), params);
      }, []);

      const describe = React.useCallback(function (error) {
        return describeError(tRef.current, error);
      }, []);

      const showToast = React.useCallback(function (message, tone) {
        if (!mountedRef.current) return;
        toastSeqRef.current += 1;
        setToast({ id: toastSeqRef.current, message: message, tone: tone === "error" ? "error" : "info" });
      }, []);

      const ensureRowVisible = React.useCallback(function (path) {
        const tree = treeRef.current;
        if (tree === null || typeof path !== "string") return;
        const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        let node = null;
        try {
          node = tree.querySelector('[data-dfe-path="' + escaped + '"]');
        } catch (error) {
          node = null;
        }
        if (node !== null && typeof node.scrollIntoView === "function") {
          try {
            node.scrollIntoView({ block: "nearest" });
          } catch (error) {
            // Scrolling is best effort.
          }
        }
      }, []);

        const loadLevel = React.useCallback(function (directoryPath, options) {
        const currentRoot = rootRef.current;
        if (typeof directoryPath !== "string" || typeof currentRoot !== "string") return;
        const previous = pendingLevelsRef.current.get(directoryPath);
        if (previous !== undefined) previous.abort();
        const controller = new AbortController();
        pendingLevelsRef.current.set(directoryPath, controller);
        const epoch = rootEpochRef.current;
        const silent = options !== null && options !== undefined && options.silent === true;
        if (!silent) {
          setLevels(function (prev) {
            const next = Object.assign({}, prev);
            next[directoryPath] = { status: "loading", entries: [], truncated: false };
            return next;
          });
        }
        requestJson("list", { root: currentRoot, path: directoryPath }, undefined, controller.signal).then(function (body) {
          if (pendingLevelsRef.current.get(directoryPath) === controller) pendingLevelsRef.current.delete(directoryPath);
          if (!mountedRef.current || controller.signal.aborted === true || epoch !== rootEpochRef.current) return;
          const entries = orderEntries(Array.isArray(body.entries) ? body.entries : []);
          setLevels(function (prev) {
            const next = Object.assign({}, prev);
            next[directoryPath] = { status: "ready", entries: entries, truncated: body.truncated === true };
            return next;
          });
        }).catch(function (error) {
          if (pendingLevelsRef.current.get(directoryPath) === controller) pendingLevelsRef.current.delete(directoryPath);
          if (!mountedRef.current || isAbortError(error) || epoch !== rootEpochRef.current) return;
          const failure = toApiError(error);
          setLevels(function (prev) {
            const next = Object.assign({}, prev);
            next[directoryPath] = { status: "failed", entries: [], truncated: false, error: failure };
            return next;
          });
        });
      }, []);

      function abortActiveRequests() {
        activeRequestsRef.current.forEach(function (controller) {
          controller.abort();
        });
        activeRequestsRef.current.clear();
        pendingLevelsRef.current.forEach(function (controller) {
          controller.abort();
        });
        pendingLevelsRef.current.clear();
      }

      function newOperationSignal() {
        const controller = new AbortController();
        activeRequestsRef.current.add(controller);
        return {
          controller: controller,
          signal: controller.signal,
          done: function () {
            activeRequestsRef.current.delete(controller);
          },
        };
      }

      React.useEffect(function () {
        mountedRef.current = true;
        installStyles();
        return function () {
          mountedRef.current = false;
          abortActiveRequests();
        };
      }, []);

      React.useEffect(function () {
        if (toast === null) return undefined;
        const timer = setTimeout(function () {
          if (mountedRef.current) setToast(null);
        }, 3600);
        return function () {
          clearTimeout(timer);
        };
      }, [toast]);

      React.useEffect(function () {
        rootEpochRef.current += 1;
        pendingLevelsRef.current.forEach(function (controller) {
          controller.abort();
        });
        pendingLevelsRef.current.clear();
        setMenu(null);
        setDialog(null);
        setRenaming(null);
        if (root === null) {
          setExpanded({});
          setLevels({});
          setSelectedPath(null);
          return;
        }
        const nextExpanded = {};
        nextExpanded[root] = true;
        setExpanded(nextExpanded);
        setLevels({});
        setSelectedPath(null);
        loadLevel(root, { silent: false });
      }, [root, loadLevel]);

      React.useEffect(function () {
        if (root !== null) return;
        if (typeof cwd === "string" && isAbsolutePath(cwd)) setRoot(cwd);
      }, [cwd, root]);

      const rows = React.useMemo(function () {
        return buildRows(levels, expanded, root);
      }, [levels, expanded, root]);

      const entryRows = React.useMemo(function () {
        return rows.filter(function (row) {
          return row.kind === "entry";
        });
      }, [rows]);

      const dispatchRowClick = React.useCallback(function (row) {
        const actions = actionsRef.current;
        if (actions !== null) actions.rowClick(row);
      }, []);

      const dispatchRowContextMenu = React.useCallback(function (row, event) {
        const actions = actionsRef.current;
        if (actions !== null) actions.rowContextMenu(row, event);
      }, []);

      const dispatchRenameChange = React.useCallback(function (value) {
        const actions = actionsRef.current;
        if (actions !== null) actions.renameChange(value);
      }, []);

      const dispatchRenameKeyDown = React.useCallback(function (event) {
        const actions = actionsRef.current;
        if (actions !== null) actions.renameKeyDown(event);
      }, []);

      const dispatchRenameBlur = React.useCallback(function () {
        const actions = actionsRef.current;
        if (actions !== null) actions.renameBlur();
      }, []);

        function beginBusy(key) {
        if (busyRef.current !== null) return false;
        busyRef.current = key;
        setBusy(key);
        return true;
      }

      function endBusy() {
        busyRef.current = null;
        if (mountedRef.current) setBusy(null);
      }

      function focusTree() {
        const tree = treeRef.current;
        if (tree === null || typeof tree.focus !== "function") return;
        try {
          tree.focus();
        } catch (error) {
          // Focus is best effort.
        }
      }

      function findSelectedRow() {
        for (let index = 0; index < entryRows.length; index += 1) {
          if (entryRows[index].path === selectedPath) return entryRows[index];
        }
        return null;
      }

      function findRowByPath(path) {
        for (let index = 0; index < entryRows.length; index += 1) {
          if (entryRows[index].path === path) return entryRows[index];
        }
        return null;
      }

      function nodeForRow(row) {
        return { path: row.path, name: row.entry.name, type: row.entry.type };
      }

      function selectPath(path, visible) {
        setSelectedPath(path);
        if (visible !== false) ensureRowVisible(path);
      }

      function rowClick(row) {
        setSelectedPath(row.path);
        focusTree();
        if (row.entry.type === "directory") toggleDirectory(row.path);
        else if (row.entry.type === "file") openFileAt(row.path);
      }

      function rowContextMenu(row, event) {
        if (event !== null && event !== undefined) {
          event.preventDefault();
          event.stopPropagation();
        }
        setSelectedPath(row.path);
        setMenu({
          x: event !== null && event !== undefined && typeof event.clientX === "number" ? event.clientX : 0,
          y: event !== null && event !== undefined && typeof event.clientY === "number" ? event.clientY : 0,
          node: nodeForRow(row),
        });
      }

      function closeMenu() {
        setMenu(null);
      }

      function toggleDirectory(path, force) {
        const currentlyExpanded = expandedRef.current[path] === true;
        const shouldExpand = typeof force === "boolean" ? force : !currentlyExpanded;
        if (shouldExpand === currentlyExpanded) return;
        setExpanded(function (prev) {
          const next = Object.assign({}, prev);
          if (shouldExpand) next[path] = true;
          else delete next[path];
          return next;
        });
        const level = levelsRef.current[path];
        if (shouldExpand && (level === undefined || level.status !== "ready")) {
          loadLevel(path, { silent: false });
        }
      }

      function openFileAt(path) {
        const tab = tabInfo === null || tabInfo === undefined ? null : tabInfo.tab;
        const tabActions = tab === null || tab === undefined ? null : tab.actions;
        if (tabActions === null || tabActions === undefined || typeof tabActions.openResource !== "function") {
          showToast(tt("toast.noResource"), "error");
          return;
        }
        if (sessionId === null || sessionId === undefined || sessionId === "") {
          showToast(tt("toast.noSession"), "error");
          return;
        }
        try {
          tabActions.openResource(fileAddress(sessionId, path));
        } catch (error) {
          showToast(tt("toast.noResource"), "error");
        }
      }

      function copyPathFor(node, relative) {
        const rootPath = rootRef.current;
        let text = node.path;
        if (relative === true) text = typeof rootPath === "string" ? relativeToRoot(rootPath, node.path) : node.path;
        copyTextToClipboard(text).then(function (ok) {
          if (!mountedRef.current) return;
          showToast(ok ? tt("toast.pathCopied") : tt("toast.copyFailed"), ok ? "info" : "error");
        });
      }

      function copyNode(node) {
        setClipboard({ op: "copy", sources: [node.path], names: [node.name] });
        showToast(tt("toast.itemCopied"), "info");
      }

      function targetDirectoryForSelection() {
        const rootPath = rootRef.current;
        const row = findSelectedRow();
        if (row === null) return rootPath;
        if (row.entry.type === "directory") return row.path;
        const parent = parentPath(row.path);
        return parent !== null ? parent : rootPath;
      }

      function showPasteSummary(results) {
        const summary = summarizePasteResults(results);
        const parts = [];
        if (summary.copied > 0) parts.push(format(tt("toast.pasteCopied"), { count: summary.copied }));
        if (summary.renamed > 0) parts.push(format(tt("toast.pasteRenamed"), { count: summary.renamed }));
        if (summary.skipped > 0) parts.push(format(tt("toast.pasteSkipped"), { count: summary.skipped }));
        showToast(parts.length === 0 ? tt("toast.pasteDone") : parts.join(tt("toast.separator")), "info");
      }

      function pasteInto(targetDir) {
        const clip = clipboard;
        if (clip === null || clip === undefined || !Array.isArray(clip.sources) || clip.sources.length === 0) {
          showToast(tt("toast.pasteEmpty"), "error");
          return;
        }
        if (busyRef.current !== null) {
          showToast(tt("toast.busy"), "error");
          return;
        }
        const target = typeof targetDir === "string" ? targetDir : targetDirectoryForSelection();
        if (typeof target !== "string") return;
        for (let index = 0; index < clip.sources.length; index += 1) {
          if (isSameOrDescendant(clip.sources[index], target)) {
            showToast(tt("toast.pasteIntoSelf"), "error");
            return;
          }
        }
        let conflicts = 0;
        const level = levelsRef.current[target];
        if (level !== undefined && level.status === "ready") {
          const existing = new Set();
          const entries = Array.isArray(level.entries) ? level.entries : [];
          for (let index = 0; index < entries.length; index += 1) existing.add(entries[index].name);
          const names = Array.isArray(clip.names) ? clip.names : [];
          for (let index = 0; index < names.length; index += 1) {
            if (existing.has(names[index])) conflicts += 1;
          }
        }
        if (conflicts > 0) {
          setDialog({ kind: "conflict", targetDir: target, conflicts: conflicts, policy: "rename", busy: false, error: null });
          return;
        }
        performPaste(target, "rename").then(function (outcome) {
          if (!mountedRef.current) return;
          if (outcome.ok === true) showPasteSummary(outcome.results);
          else if (outcome.error !== null && outcome.error !== undefined) showToast(describe(outcome.error), "error");
        });
      }

        function moveSelection(delta) {
        if (entryRows.length === 0) return;
        let index = -1;
        for (let cursor = 0; cursor < entryRows.length; cursor += 1) {
          if (entryRows[cursor].path === selectedPath) {
            index = cursor;
            break;
          }
        }
        let next;
        if (index < 0) next = delta > 0 ? 0 : entryRows.length - 1;
        else next = Math.min(entryRows.length - 1, Math.max(0, index + delta));
        const row = entryRows[next];
        setSelectedPath(row.path);
        ensureRowVisible(row.path);
      }

      function activateSelection() {
        const row = findSelectedRow();
        if (row === null) return;
        if (row.entry.type === "directory") toggleDirectory(row.path);
        else if (row.entry.type === "file") openFileAt(row.path);
      }

      function collapseSelection() {
        const row = findSelectedRow();
        const rootPath = rootRef.current;
        if (row === null) return;
        if (row.entry.type === "directory" && expandedRef.current[row.path] === true) {
          toggleDirectory(row.path, false);
          return;
        }
        const parent = parentPath(row.path);
        if (parent !== null && parent !== rootPath) {
          setSelectedPath(parent);
          ensureRowVisible(parent);
        }
      }

      function expandSelection() {
        const row = findSelectedRow();
        if (row === null) return;
        if (row.entry.type !== "directory") return;
        if (expandedRef.current[row.path] !== true) {
          toggleDirectory(row.path, true);
          return;
        }
        const level = levelsRef.current[row.path];
        if (level !== undefined && level.status === "ready" && Array.isArray(level.entries) && level.entries.length > 0) {
          const childPath = joinPath(row.path, level.entries[0].name);
          const child = findRowByPath(childPath);
          if (child !== null) {
            setSelectedPath(child.path);
            ensureRowVisible(child.path);
          }
        }
      }

      function selectedNodeOrNull() {
        const row = findSelectedRow();
        return row === null ? null : nodeForRow(row);
      }

      function beginRenameFor(node) {
        if (node === null || node === undefined) return;
        if (busyRef.current !== null) return;
        if (node.path === rootRef.current) return;
        setMenu(null);
        setDialog(null);
        setSelectedPath(node.path);
        setRenaming({ path: node.path, name: node.name, value: node.name, error: null, busy: false });
      }

      function renameChange(value) {
        setRenaming(function (prev) {
          if (prev === null) return prev;
          return { path: prev.path, name: prev.name, value: value, error: null, busy: prev.busy };
        });
      }

      function renameKeyDown(event) {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          commitRename();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setRenaming(null);
        }
      }

      function renameBlur() {
        setRenaming(function (prev) {
          if (prev === null || prev.busy === true) return prev;
          return null;
        });
      }

      function copySelection() {
        const node = selectedNodeOrNull();
        if (node === null) return;
        copyNode(node);
      }

      function pasteSelection() {
        const target = targetDirectoryForSelection();
        if (typeof target === "string") pasteInto(target);
      }

      function renameSelectionNode() {
        const node = selectedNodeOrNull();
        if (node === null) return;
        beginRenameFor(node);
      }

      function deleteSelectionNode() {
        const node = selectedNodeOrNull();
        if (node === null) return;
        openDeleteDialog(node);
      }

      function handleTreeKeyDown(event) {
        const target = event.target;
        if (target !== null && target !== undefined) {
          const tag = typeof target.tagName === "string" ? target.tagName : "";
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true) return;
        }
        if (menu !== null || dialog !== null || openFolderOpen === true) return;
        if (event.key === "Escape") {
          if (renaming !== null) {
            event.preventDefault();
            setRenaming(null);
          }
          return;
        }
        if (renaming !== null) return;
        const primary = event.metaKey === true || event.ctrlKey === true;
        if (primary === true && event.altKey !== true) {
          const lower = typeof event.key === "string" ? event.key.toLowerCase() : "";
          if (lower === "c") {
            event.preventDefault();
            copySelection();
            return;
          }
          if (lower === "v") {
            event.preventDefault();
            pasteSelection();
            return;
          }
          return;
        }
        if (event.altKey === true) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveSelection(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveSelection(-1);
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          expandSelection();
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          collapseSelection();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          activateSelection();
          return;
        }
        if (event.key === "F2") {
          event.preventDefault();
          renameSelectionNode();
          return;
        }
        if (event.key === "Delete") {
          event.preventDefault();
          deleteSelectionNode();
        }
      }

      function openCreateDialog(mode) {
        const rootPath = rootRef.current;
        if (typeof rootPath !== "string") return;
        const targetDir = targetDirectoryForSelection();
        if (typeof targetDir !== "string") return;
        setMenu(null);
        setDialog({ kind: "name", mode: mode, targetDir: targetDir, value: "", error: null, busy: false });
      }

      function openDeleteDialog(node) {
        if (node === null || node === undefined) return;
        if (node.path === rootRef.current) return;
        setMenu(null);
        setDialog({ kind: "delete", nodes: [{ path: node.path, name: node.name, type: node.type }], busy: false, error: null });
      }

      function openOpenFolderDialog() {
        const currentRoot = rootRef.current;
        let initial = "";
        if (typeof currentRoot === "string") initial = currentRoot;
        else if (typeof cwd === "string" && cwd !== "") initial = cwd;
        setMenu(null);
        setOpenFolderInitial(initial);
        setOpenFolderOpen(true);
      }

      function closeDialog() {
        setDialog(null);
      }

      function changeDialogName(value) {
        setDialog(function (prev) {
          if (prev === null || prev.kind !== "name") return prev;
          return { kind: "name", mode: prev.mode, targetDir: prev.targetDir, value: value, error: null, busy: prev.busy };
        });
      }

        function remapCachedPath(fromPath, toPath) {
        function remap(key) {
          if (key === fromPath) return toPath;
          if (key.indexOf(fromPath + "/") === 0) return toPath + key.slice(fromPath.length);
          return key;
        }
        setExpanded(function (prev) {
          const next = {};
          let changed = false;
          Object.keys(prev).forEach(function (key) {
            const mapped = remap(key);
            if (mapped !== key) changed = true;
            next[mapped] = prev[key];
          });
          return changed ? next : prev;
        });
        setLevels(function (prev) {
          const next = {};
          let changed = false;
          Object.keys(prev).forEach(function (key) {
            const mapped = remap(key);
            if (mapped !== key) changed = true;
            next[mapped] = prev[key];
          });
          return changed ? next : prev;
        });
      }

      function forgetCachedPath(target) {
        function hidden(key) {
          return key === target || key.indexOf(target + "/") === 0;
        }
        setExpanded(function (prev) {
          let changed = false;
          const next = {};
          Object.keys(prev).forEach(function (key) {
            if (hidden(key)) {
              changed = true;
              return;
            }
            next[key] = prev[key];
          });
          return changed ? next : prev;
        });
        setLevels(function (prev) {
          let changed = false;
          const next = {};
          Object.keys(prev).forEach(function (key) {
            if (hidden(key)) {
              changed = true;
              return;
            }
            next[key] = prev[key];
          });
          return changed ? next : prev;
        });
      }

      function commitRename() {
        const current = renaming;
        if (current === null || current.busy === true) return;
        const nextName = typeof current.value === "string" ? current.value.trim() : "";
        if (nextName === current.name) {
          setRenaming(null);
          return;
        }
        const validation = validateName(nextName);
        if (validation !== null) {
          setRenaming({ path: current.path, name: current.name, value: current.value, error: describe(new ApiError(validation, "")), busy: false });
          return;
        }
        setRenaming({ path: current.path, name: current.name, value: current.value, error: null, busy: true });
        performRename(current.path, nextName).then(function (outcome) {
          if (!mountedRef.current) return;
          if (outcome.ok === true) {
            setSelectedPath(outcome.path);
            setRenaming(null);
            showToast(tt("toast.renamed"), "info");
          } else if (outcome.error !== null && outcome.error !== undefined) {
            const failure = outcome.error;
            setRenaming(function (prev) {
              if (prev === null || prev.path !== current.path) return prev;
              return { path: prev.path, name: prev.name, value: prev.value, error: describe(failure), busy: false };
            });
          }
        });
      }

      function performRename(oldPath, newName) {
        if (!beginBusy("rename")) return Promise.resolve({ ok: false, error: new ApiError("busy", "") });
        const op = newOperationSignal();
        const rootPath = rootRef.current;
        return requestJson("rename", undefined, { root: rootPath, path: oldPath, newName: newName }, op.signal).then(function (body) {
          if (!mountedRef.current) return { ok: false, aborted: true };
          const parent = parentPath(oldPath);
          let newPath = parent === null ? joinPath(rootPath, newName) : joinPath(parent, newName);
          if (typeof body.path === "string" && body.path !== "") newPath = body.path;
          remapCachedPath(oldPath, newPath);
          if (parent !== null) loadLevel(parent, { silent: true });
          return { ok: true, path: newPath };
        }).catch(function (error) {
          if (isAbortError(error)) return { ok: false, aborted: true };
          return { ok: false, error: toApiError(error) };
        }).then(function (outcome) {
          op.done();
          endBusy();
          return outcome;
        });
      }

      function performCreate(mode, targetDir, name) {
        if (!beginBusy("create")) return Promise.resolve({ ok: false, error: new ApiError("busy", "") });
        const op = newOperationSignal();
        const rootPath = rootRef.current;
        const kind = mode === "createFolder" ? "directory" : "file";
        return requestJson("create", undefined, { root: rootPath, parent: targetDir, name: name, kind: kind }, op.signal).then(function (body) {
          if (!mountedRef.current) return { ok: false, aborted: true };
          const createdPath = typeof body.path === "string" && body.path !== "" ? body.path : joinPath(targetDir, name);
          setExpanded(function (prev) {
            if (prev[targetDir] === true) return prev;
            const next = Object.assign({}, prev);
            next[targetDir] = true;
            return next;
          });
          loadLevel(targetDir, { silent: true });
          return { ok: true, path: createdPath };
        }).catch(function (error) {
          if (isAbortError(error)) return { ok: false, aborted: true };
          return { ok: false, error: toApiError(error) };
        }).then(function (outcome) {
          op.done();
          endBusy();
          return outcome;
        });
      }

      function submitNameDialog() {
        const current = dialog;
        if (current === null || current.kind !== "name" || current.busy === true) return;
        const name = typeof current.value === "string" ? current.value.trim() : "";
        const validation = validateName(name);
        if (validation !== null) {
          setDialog(function (prev) {
            if (prev === null || prev.kind !== "name") return prev;
            return { kind: "name", mode: prev.mode, targetDir: prev.targetDir, value: prev.value, error: describe(new ApiError(validation, "")), busy: false };
          });
          return;
        }
        setDialog(function (prev) {
          if (prev === null || prev.kind !== "name") return prev;
          return { kind: "name", mode: prev.mode, targetDir: prev.targetDir, value: prev.value, error: null, busy: true };
        });
        performCreate(current.mode, current.targetDir, name).then(function (outcome) {
          if (!mountedRef.current) return;
          if (outcome.ok === true) {
            setSelectedPath(outcome.path);
            setDialog(null);
            showToast(tt(current.mode === "createFolder" ? "toast.createdFolder" : "toast.createdFile"), "info");
          } else if (outcome.error !== null && outcome.error !== undefined) {
            const failure = outcome.error;
            setDialog(function (prev) {
              if (prev === null || prev.kind !== "name") return prev;
              return { kind: "name", mode: prev.mode, targetDir: prev.targetDir, value: prev.value, error: describe(failure), busy: false };
            });
          }
        });
      }

      function performDelete(nodes) {
        if (!beginBusy("delete")) return Promise.resolve({ ok: false, error: new ApiError("busy", "") });
        const op = newOperationSignal();
        const rootPath = rootRef.current;
        const paths = nodes.map(function (node) {
          return node.path;
        });
        return requestJson("delete", undefined, { root: rootPath, paths: paths, confirm: true }, op.signal).then(function () {
          if (!mountedRef.current) return { ok: false, aborted: true };
          for (let index = 0; index < paths.length; index += 1) forgetCachedPath(paths[index]);
          const parents = [];
          for (let index = 0; index < nodes.length; index += 1) {
            const parent = parentPath(nodes[index].path);
            if (parent !== null && parents.indexOf(parent) < 0) parents.push(parent);
          }
          for (let index = 0; index < parents.length; index += 1) loadLevel(parents[index], { silent: true });
          return { ok: true, count: paths.length };
        }).catch(function (error) {
          if (isAbortError(error)) return { ok: false, aborted: true };
          return { ok: false, error: toApiError(error) };
        }).then(function (outcome) {
          op.done();
          endBusy();
          return outcome;
        });
      }

      function submitDelete() {
        const current = dialog;
        if (current === null || current.kind !== "delete" || current.busy === true) return;
        const nodes = current.nodes.slice();
        setDialog(function (prev) {
          if (prev === null || prev.kind !== "delete") return prev;
          return { kind: "delete", nodes: prev.nodes, busy: true, error: null };
        });
        performDelete(nodes).then(function (outcome) {
          if (!mountedRef.current) return;
          if (outcome.ok === true) {
            setSelectedPath(null);
            setDialog(null);
            showToast(format(tt("toast.deleted"), { count: outcome.count }), "info");
          } else if (outcome.error !== null && outcome.error !== undefined) {
            const failure = outcome.error;
            const message = describe(failure);
            showToast(message, "error");
            setDialog(function (prev) {
              if (prev === null || prev.kind !== "delete") return prev;
              return { kind: "delete", nodes: prev.nodes, busy: false, error: message };
            });
          }
        });
      }

      function performPaste(targetDir, policy) {
        if (!beginBusy("paste")) return Promise.resolve({ ok: false, error: new ApiError("busy", "") });
        const clip = clipboard;
        if (clip === null || clip === undefined || !Array.isArray(clip.sources) || clip.sources.length === 0) {
          endBusy();
          return Promise.resolve({ ok: false, error: new ApiError("bad-request", "") });
        }
        const op = newOperationSignal();
        const rootPath = rootRef.current;
        const sources = clip.sources.slice();
        return requestJson("copy", undefined, { root: rootPath, sources: sources, targetDir: targetDir, conflict: policy }, op.signal).then(function (body) {
          if (!mountedRef.current) return { ok: false, aborted: true };
          setExpanded(function (prev) {
            if (prev[targetDir] === true) return prev;
            const next = Object.assign({}, prev);
            next[targetDir] = true;
            return next;
          });
          loadLevel(targetDir, { silent: true });
          return { ok: true, results: Array.isArray(body.results) ? body.results : [] };
        }).catch(function (error) {
          if (isAbortError(error)) return { ok: false, aborted: true };
          return { ok: false, error: toApiError(error) };
        }).then(function (outcome) {
          op.done();
          endBusy();
          return outcome;
        });
      }

      function submitConflictPaste() {
        const current = dialog;
        if (current === null || current.kind !== "conflict" || current.busy === true) return;
        const policy = typeof current.policy === "string" ? current.policy : "rename";
        setDialog(function (prev) {
          if (prev === null || prev.kind !== "conflict") return prev;
          return { kind: "conflict", targetDir: prev.targetDir, conflicts: prev.conflicts, policy: prev.policy, busy: true, error: null };
        });
        performPaste(current.targetDir, policy).then(function (outcome) {
          if (!mountedRef.current) return;
          if (outcome.ok === true) {
            setDialog(null);
            showPasteSummary(outcome.results);
          } else if (outcome.error !== null && outcome.error !== undefined) {
            const failure = outcome.error;
            setDialog(function (prev) {
              if (prev === null || prev.kind !== "conflict") return prev;
              return { kind: "conflict", targetDir: prev.targetDir, conflicts: prev.conflicts, policy: prev.policy, busy: false, error: describe(failure) };
            });
          }
        });
      }

      function changeConflictPolicy(value) {
        setDialog(function (prev) {
          if (prev === null || prev.kind !== "conflict") return prev;
          return { kind: "conflict", targetDir: prev.targetDir, conflicts: prev.conflicts, policy: value, busy: prev.busy, error: null };
        });
      }

      function revealNode(node) {
        if (!beginBusy("reveal")) {
          showToast(tt("toast.busy"), "error");
          return;
        }
        const op = newOperationSignal();
        requestJson("reveal", undefined, { root: rootRef.current, path: node.path }, op.signal).then(function () {
          if (mountedRef.current) showToast(tt("toast.revealed"), "info");
        }).catch(function (error) {
          if (!isAbortError(error) && mountedRef.current) showToast(describe(error), "error");
        }).then(function () {
          op.done();
          endBusy();
        });
      }

      function openWithApplication(node, application, announce) {
        if (remoteSession === null || remoteSession === undefined) {
          return Promise.resolve({ ok: false });
        }
        const appId = application !== null && application !== undefined && typeof application.id === "string" ? application.id : "";
        let request;
        try {
          request = Promise.resolve(remoteSession.openWorkspacePath({ path: node.path, application: appId }));
        } catch (error) {
          request = Promise.reject(error);
        }
        return request.then(function (result) {
          const ok = result !== null && result !== undefined && result.ok === true;
          if (announce === true && mountedRef.current) {
            if (ok) {
              const appName = application !== null && application !== undefined && typeof application.name === "string" ? application.name : appId;
              showToast(format(tt("toast.openedWith"), { app: appName }), "info");
            } else {
              showToast(tt("toast.openWithFailed"), "error");
            }
          }
          return { ok: ok };
        }).catch(function () {
          if (announce === true && mountedRef.current) showToast(tt("toast.openWithFailed"), "error");
          return { ok: false };
        });
      }

      function openWithNode(node) {
        if (remoteSession === null || remoteSession === undefined) {
          showToast(tt("toast.noApplications"), "error");
          return;
        }
        if (!beginBusy("open-with")) {
          showToast(tt("toast.busy"), "error");
          return;
        }
        let request;
        try {
          request = Promise.resolve(remoteSession.workspacePathApplications({ path: node.path }));
        } catch (error) {
          request = Promise.reject(error);
        }
        request.then(function (result) {
          if (!mountedRef.current) return undefined;
          const applications = remoteValue(result);
          if (!Array.isArray(applications)) {
            showToast(tt("toast.openWithFailed"), "error");
            return undefined;
          }
          if (applications.length === 0) {
            showToast(tt("toast.noApplications"), "error");
            return undefined;
          }
          if (applications.length === 1) return openWithApplication(node, applications[0], true);
          setDialog({ kind: "apps", node: node, apps: applications, busy: false, error: null });
          return undefined;
        }).catch(function () {
          if (mountedRef.current) showToast(tt("toast.openWithFailed"), "error");
        }).then(function () {
          endBusy();
        });
      }

      function chooseApplication(node, application) {
        const current = dialog;
        if (current === null || current.kind !== "apps" || current.busy === true) return;
        if (!beginBusy("open-with-app")) {
          showToast(tt("toast.busy"), "error");
          return;
        }
        setDialog(function (prev) {
          if (prev === null || prev.kind !== "apps") return prev;
          return { kind: "apps", node: prev.node, apps: prev.apps, busy: true, error: null };
        });
        openWithApplication(node, application, true).then(function (outcome) {
          endBusy();
          if (!mountedRef.current) return;
          if (outcome.ok === true) {
            setDialog(null);
          } else {
            setDialog(function (prev) {
              if (prev === null || prev.kind !== "apps") return prev;
              return { kind: "apps", node: prev.node, apps: prev.apps, busy: false, error: tt("toast.openWithFailed") };
            });
          }
        });
      }

      function refreshAll() {
        const rootPath = rootRef.current;
        if (typeof rootPath !== "string") return;
        loadLevel(rootPath, { silent: true });
        const expandedMap = expandedRef.current;
        Object.keys(expandedMap).forEach(function (path) {
          if (path !== rootPath) loadLevel(path, { silent: true });
        });
      }

      function retryLevel(path) {
        loadLevel(path, { silent: false });
      }

      function chooseRoot(path) {
        if (typeof path !== "string" || !isAbsolutePath(path)) return Promise.reject(new ApiError("invalid-path", ""));
        const op = newOperationSignal();
        return requestJson("browse", { path: path }, undefined, op.signal).then(function () {
          op.done();
          if (!mountedRef.current) return;
          setOpenFolderOpen(false);
          setRoot(path);
          writeStoredRoot(path);
        }, function (error) {
          op.done();
          throw error;
        });
      }

      function buildMenuItems(node) {
        const items = [];
        function add(id, label, onSelect, options) {
          const item = Object.assign({ id: id, label: label, onSelect: onSelect }, options || {});
          items.push(item);
        }
        function separator() {
          if (items.length === 0) return;
          const last = items[items.length - 1];
          if (last !== undefined && last.separator === true) return;
          items.push({ id: "sep-" + items.length, separator: true });
        }
        const nodeType = node.type;
        if (nodeType === "file" || nodeType === "other") {
          if (nodeType === "file") {
            add("open", tt("menu.open"), function () {
              openFileAt(node.path);
            });
            add("copy", tt("menu.copy"), function () {
              copyNode(node);
            });
            separator();
          }
          add("reveal", tt("menu.reveal"), function () {
            revealNode(node);
          });
          if (nodeType === "file" && remoteSession !== null && remoteSession !== undefined) {
            add("open-with", tt("menu.openWith"), function () {
              openWithNode(node);
            });
          }
          separator();
        } else if (nodeType === "directory") {
          add("new-file", tt("menu.newFile"), function () {
            openCreateDialog("createFile");
          });
          add("new-folder", tt("menu.newFolder"), function () {
            openCreateDialog("createFolder");
          });
          add("paste", tt("menu.paste"), function () {
            pasteInto(node.path);
          }, { disabled: clipboard === null || clipboard === undefined });
          separator();
          add("copy", tt("menu.copy"), function () {
            copyNode(node);
          });
          add("reveal", tt("menu.reveal"), function () {
            revealNode(node);
          });
          separator();
        }
        if (nodeType === "file" || nodeType === "directory") {
          separator();
          add("add-to-chat", tt("addToChat.menu"), function () {
            const chatType = node.type === "directory" ? "directory" : "file";
            let chatCwd = typeof cwd === "string" ? cwd : "";
            if (chatCwd === "") chatCwd = sessionCwdFromRoot(sessionId);
            const outcome = insertChatReference({ conversation: getRootService("conversation"), inputActions: props.inputActions, cwd: chatCwd }, { sessionId: sessionId, path: node.path, type: chatType });
            const feedback = chatInsertOutcome(tt, outcome, node.path, chatCwd, chatType);
            showToast(feedback.text, feedback.tone);
          });
        }
        if (nodeType !== "file" && nodeType !== "directory" && nodeType !== "other") return items;
        add("copy-path", tt("menu.copyPath"), function () {
          copyPathFor(node, false);
        });
        add("copy-relative-path", tt("menu.copyRelativePath"), function () {
          copyPathFor(node, true);
        });
        separator();
        add("rename", tt("menu.rename"), function () {
          beginRenameFor(node);
        });
        add("delete", tt("menu.delete"), function () {
          openDeleteDialog(node);
        }, { danger: true });
        return items;
      }

      actionsRef.current = {
        rowClick: rowClick,
        rowContextMenu: rowContextMenu,
        renameChange: renameChange,
        renameKeyDown: renameKeyDown,
        renameBlur: renameBlur,
      };

      function renderRow(row) {
        if (row.kind === "note") {
          const paddingLeft = 12 + row.depth * 16;
          if (row.note === "loading") {
            return h("div", {
              className: "dfe-note",
              key: row.path + "::loading",
              role: "presentation",
              style: { paddingLeft: paddingLeft },
            },
              h("span", { className: "dfe-spinner", "aria-hidden": "true" }),
              tt("loading"));
          }
          if (row.note === "empty") {
            return h("div", {
              className: "dfe-note",
              key: row.path + "::empty",
              role: "presentation",
              style: { paddingLeft: paddingLeft },
            }, tt("empty"));
          }
          if (row.note === "truncated") {
            return h("div", {
              className: "dfe-note",
              key: row.path + "::truncated",
              role: "presentation",
              style: { paddingLeft: paddingLeft },
            }, format(tt("truncated"), { count: MAX_ENTRIES }));
          }
          const failure = row.error === null || row.error === undefined ? new ApiError("internal", "") : row.error;
          return h("div", {
            className: "dfe-note dfe-note--error",
            key: row.path + "::failed",
            role: "presentation",
            style: { paddingLeft: paddingLeft },
          },
            h("span", { className: "dfe-note-text" }, format(tt("loadFailed"), { message: describe(failure) })),
            h("button", {
              type: "button",
              className: "dfe-link",
              onClick: function () {
                retryLevel(row.path);
              },
            }, tt("retry")));
        }
        const isDirectory = row.entry.type === "directory";
        const isRenaming = renaming !== null && renaming.path === row.path;
        return h(DirectoryRow, {
          key: row.path,
          row: row,
          selected: row.path === selectedPath,
          expanded: isDirectory && expanded[row.path] === true,
          renaming: isRenaming,
          renamingValue: isRenaming ? renaming.value : "",
          renamingError: isRenaming ? renaming.error : null,
          renamingBusy: isRenaming ? renaming.busy === true : false,
          t: providedT,
          onRowClick: dispatchRowClick,
          onRowContextMenu: dispatchRowContextMenu,
          onRenameChange: dispatchRenameChange,
          onRenameKeyDown: dispatchRenameKeyDown,
          onRenameBlur: dispatchRenameBlur,
        });
      }

      let emptyDescription = tt("state.noRootDescription");
      if (sessionId === null || sessionId === undefined || sessionId === "") emptyDescription = tt("state.noSession");
      else if (typeof cwd !== "string" || cwd === "") emptyDescription = tt("state.noWorkspace");

      const toolbar = h("div", { className: "dfe-toolbar" },
        h("span", {
          className: "dfe-root-label",
          title: root === null ? undefined : root,
        }, root === null ? tt("toolbar.noRoot") : root),
        h("div", { className: "dfe-toolbar-actions" },
          busy !== null ? h("span", { className: "dfe-spinner", "aria-hidden": "true" }) : null,
          h(ToolButton, {
            label: tt("toolbar.openFolder"),
            onClick: openOpenFolderDialog,
            icon: OpenFolderIcon,
          }),
          h(ToolButton, {
            label: tt("toolbar.refresh"),
            onClick: refreshAll,
            disabled: root === null || busy !== null,
            icon: RefreshIcon,
          }),
          h("span", { className: "dfe-toolbar-sep" }),
          h(ToolButton, {
            label: tt("toolbar.newFile"),
            onClick: function () {
              openCreateDialog("createFile");
            },
            disabled: root === null || busy !== null,
            icon: NewFileIcon,
          }),
          h(ToolButton, {
            label: tt("toolbar.newFolder"),
            onClick: function () {
              openCreateDialog("createFolder");
            },
            disabled: root === null || busy !== null,
            icon: NewFolderIcon,
          })));

      let bodyContent = null;
      if (root === null) {
        bodyContent = h("div", { className: "dfe-body" },
          h("div", { className: "dfe-empty-state", "data-dfe-state": "no-root" },
            h("p", { className: "dfe-empty-title" }, tt("state.noRootTitle")),
            h("p", { className: "dfe-empty-desc" }, emptyDescription),
            h("button", {
              type: "button",
              className: "dfe-btn dfe-btn--primary",
              onClick: openOpenFolderDialog,
            }, tt("toolbar.openFolder"))));
      } else {
        bodyContent = h("div", { className: "dfe-body" },
          h("div", {
            className: "dfe-tree",
            role: "tree",
            "aria-label": tt("tree.ariaLabel"),
            tabIndex: 0,
            ref: treeRef,
            onKeyDown: handleTreeKeyDown,
          }, rows.map(renderRow)));
      }

      let dialogElement = null;
      if (dialog !== null && dialog.kind === "name") {
        dialogElement = h(NameDialog, {
          dialog: dialog,
          t: providedT,
          onChange: changeDialogName,
          onCancel: closeDialog,
          onSubmit: submitNameDialog,
        });
      } else if (dialog !== null && dialog.kind === "delete") {
        dialogElement = h(DeleteDialog, {
          dialog: dialog,
          t: providedT,
          onCancel: closeDialog,
          onConfirm: submitDelete,
        });
      } else if (dialog !== null && dialog.kind === "conflict") {
        dialogElement = h(ConflictDialog, {
          dialog: dialog,
          t: providedT,
          onCancel: closeDialog,
          onConfirm: submitConflictPaste,
          onPolicyChange: changeConflictPolicy,
        });
      } else if (dialog !== null && dialog.kind === "apps") {
        dialogElement = h(AppsDialog, {
          dialog: dialog,
          t: providedT,
          onCancel: closeDialog,
          onChoose: function (application) {
            chooseApplication(dialog.node, application);
          },
        });
      }

      const openFolderElement = openFolderOpen === true
        ? h(OpenFolderDialog, {
          t: providedT,
          initialPath: openFolderInitial,
          sessionCwd: typeof cwd === "string" ? cwd : "",
          onClose: function () {
            setOpenFolderOpen(false);
          },
          onChoose: chooseRoot,
        })
        : null;

      const menuElement = menu === null
        ? null
        : h(ContextMenu, {
          key: "context-menu",
          x: menu.x,
          y: menu.y,
          items: buildMenuItems(menu.node),
          label: tt("menu.ariaLabel"),
          onClose: closeMenu,
        });

      return h("div", {
        className: "dfe-root",
        "data-dfe-plugin": ID,
        "aria-busy": busy !== null ? "true" : undefined,
      },
        toolbar,
        bodyContent,
        menuElement,
        dialogElement,
        openFolderElement,
        h(ToastRegion, { toast: toast }));
    }

    /** The title chip: a folder glyph followed by the tab's own title text. */
    function ExplorerTitle(rawProps) {
      const props = rawProps || {};
      const useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : NO_TAB_INFO;
      const tabInfo = useTabInfo();
      const tr = typeof props.t === "function" ? props.t : defaultTranslate;
      const tab = tabInfo === null || tabInfo === undefined ? null : tabInfo.tab;
      let title = "";
      if (tab !== null && tab !== undefined && typeof tab.title === "string") title = tab.title;
      if (title === "") title = tr("type.label");
      return h(React.Fragment, null,
        h(FolderGlyph, { size: 16, className: "dfe-title-icon" }),
        h("span", { className: "dfe-title-text" }, title));
    }

    /** Required browser services: the tab registry, the keyed slots, copy, shortcuts. */
    const inject = ["slots", "locale", "sidebarRightTabs", "sidebarRight", "shortcuts"];

    /** Client plugin body: register dictionaries, the tab type, its body and its title. */
    function apply(ctx) {
      ctx.effect(function () {
        installStyles();
        return function () {
          removeStyles();
        };
      }, "folder-explorer: styles");
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "folder-explorer: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.inject(["remote.session"], function (scoped) {
        try {
          remoteSession = scoped.remote.session;
        } catch (error) {
          remoteSession = null;
        }
      });
      ctx.inject(["conversation"], function (scope) {
        clientCtx = scope;
      });
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: function () {
            return t("type.label");
          },
          guide: [{
            id: "explorer",
            order: 20,
            title: function () {
              return t("guide.title");
            },
            description: function () {
              return t("guide.description");
            },
            icon: FolderGlyph,
          }],
        });
      }, "folder-explorer: tab type");
      ctx.effect(function () {
        return ctx.slots.inject(BODY_SLOT, function () {
          return ctx.slots.register({ name: BODY_SLOT, key: ID, locale: NS }, ExplorerBody);
        });
      }, "folder-explorer: body");
      ctx.effect(function () {
        return ctx.slots.inject(TITLE_SLOT, function () {
          return ctx.slots.register({ name: TITLE_SLOT, key: ID, locale: NS }, ExplorerTitle);
        });
      }, "folder-explorer: title");
      ctx.effect(function () {
        const disposers = [["sidebar.right.tab.document.actions", AddToChatDocumentAction], ["sidebar.right.tab.menu.item", AddToChatTabMenuAction]].map(function (seat) {
          return ctx.slots.inject(seat[0], function () {
            return ctx.slots.register({ name: seat[0], id: "folder-explorer.add-to-chat", locale: NS }, seat[1]);
          });
        });
        return function () {
          disposers.forEach(function (dispose) {
            dispose();
          });
        };
      }, "folder-explorer: add-to-chat slots");
    }

    return {
      inject: inject,
      apply: apply,
      // Offline test hook only: undefined unless the harness explicitly opts in.
      __test: typeof window !== "undefined" && window.__DFE_TEST__ === true
        ? { resolveIcon: resolveIcon, ICON_DEFS: ICON_DEFS, FILE_ICON_MAP: FILE_ICON_MAP, FOLDER_ICON_MAP: FOLDER_ICON_MAP, buildMention: buildMention, buildChip: buildChip, parseFileAddress: parseFileAddress, insertChatReference: insertChatReference }
        : undefined,
    };
  },
});
