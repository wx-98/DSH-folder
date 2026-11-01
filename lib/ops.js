/**
 * Pure filesystem operations for the Folder Explorer host half.
 *
 * Everything in this module is independent from the cordis/Dsh runtime so it
 * can be exercised directly by `node --test test/ops.test.js`. The HTTP layer
 * (index.js) is responsible for the authentication fence, request parsing and
 * serialising mutations; this module is responsible for path containment,
 * filesystem operations and stable error codes.
 *
 * Error model: every expected failure is an {@link OpError} whose `code` is
 * the wire-level error code documented in design.md D10.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Default cap for one directory listing (design.md D10). */
export const DEFAULT_MAX_ENTRIES = 2000;

/** Wire-level error with a stable code and optional structured details. */
export class OpError extends Error {
  /**
   * @param {string} code one of the documented wire error codes
   * @param {string} message human readable message
   * @param {unknown} [details] optional structured details for the client
   */
  constructor(code, message, details) {
    super(message ?? code);
    this.name = "OpError";
    this.code = typeof code === "string" && code.length > 0 ? code : "internal";
    if (details !== undefined) this.details = details;
  }

  /** Serialise to the `{ ok: false, code, message, details? }` wire shape. */
  toWire() {
    const wire = { ok: false, code: this.code, message: this.message };
    if (this.details !== undefined) wire.details = this.details;
    return wire;
  }
}

/** Node fs error code -> wire error code. */
const WIRE_CODE_BY_FS_CODE = Object.freeze({
  ENOENT: "not-found",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  EROFS: "permission-denied",
  EEXIST: "already-exists",
  ERR_FS_CP_EEXIST: "already-exists",
  ENOTEMPTY: "already-exists",
  ENOTDIR: "not-directory",
  EISDIR: "is-directory",
  EBUSY: "busy",
  ENAMETOOLONG: "invalid-name",
  ELOOP: "unsupported",
  ERR_FS_CP_EINVAL: "bad-request",
});

/**
 * Convert an arbitrary thrown value into an {@link OpError}.
 *
 * - OpError is returned unchanged
 * - well known fs error codes are mapped to the documented wire codes
 * - anything else becomes `internal`, preserving the original message
 *
 * @param {unknown} error
 * @returns {OpError}
 */
export function toOpError(error) {
  if (error instanceof OpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const fsCode = error && typeof error === "object" ? /** @type {{code?: unknown}} */ (error).code : undefined;
  if (typeof fsCode === "string" && Object.prototype.hasOwnProperty.call(WIRE_CODE_BY_FS_CODE, fsCode)) {
    return new OpError(WIRE_CODE_BY_FS_CODE[fsCode], message);
  }
  return new OpError("internal", message);
}

/**
 * Validate a single path segment (file/directory name).
 *
 * Accepts a non-empty string whose trimmed value is not `.` or `..`, contains
 * no path separator (`/` or `\`) and no NUL byte. Returns the trimmed name.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function validateName(value) {
  if (typeof value !== "string") {
    throw new OpError("invalid-name", "Name must be a string");
  }
  const name = value.trim();
  if (name === "") throw new OpError("invalid-name", "Name must not be empty");
  if (name === "." || name === "..") throw new OpError("invalid-name", `Invalid name: ${JSON.stringify(value)}`);
  if (name.includes("/") || name.includes("\\")) throw new OpError("invalid-name", `Invalid name: ${JSON.stringify(value)}`);
  if (name.includes("\u0000")) throw new OpError("invalid-name", "Name must not contain NUL bytes");
  return name;
}

/**
 * Assert that a value is an absolute filesystem path and normalise it.
 *
 * Non-strings are a `bad-request`; relative paths, empty strings and NUL bytes
 * are an `invalid-path`.
 *
 * @param {unknown} value
 * @param {string} [field] field name used in the error message
 * @returns {string} `path.resolve` normalised absolute path
 */
export function assertAbsolutePath(value, field = "path") {
  if (typeof value !== "string") {
    throw new OpError("bad-request", `"${field}" must be an absolute path string`, { field });
  }
  if (value.length === 0 || value.includes("\u0000") || !path.isAbsolute(value)) {
    throw new OpError("invalid-path", `"${field}" must be an absolute path`, { field });
  }
  return path.resolve(value);
}

/**
 * Lexical containment test (no filesystem access).
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean} true when `child` is `parent` itself or a descendant path
 */
export function containsPath(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  return isContained(parentPath, childPath);
}

/**
 * @param {string} parent an already resolved absolute path
 * @param {string} child an already resolved absolute path
 * @returns {boolean}
 */
function isContained(parent, child) {
  if (parent === child) return true;
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  if (relative === "..") return false;
  if (relative.startsWith(`..${path.sep}`)) return false;
  return true;
}

/**
 * Realpath helper that maps fs errors to wire errors.
 *
 * @param {string} target
 * @returns {Promise<string>}
 */
async function realpathOrThrow(target) {
  try {
    return await fs.realpath(target);
  } catch (error) {
    throw toOpError(error);
  }
}

/**
 * Normalise + validate a path that must live inside `root`.
 *
 * Steps (design.md D5):
 * 1. both arguments must be absolute paths;
 * 2. the normalised target must be lexically inside the root (root itself is
 *    allowed and returned immediately);
 * 3. the root and the target's parent directory are realpath'ed and the parent
 *    must still be inside the real root - this rejects `..` and symlink based
 *    escapes;
 * 4. a final symlink node is not followed: containment is validated through
 *    the link's *location*, so rename/delete/reveal may act on the link itself.
 *
 * @param {string} root absolute root directory
 * @param {string} target absolute target path
 * @returns {Promise<string>} normalised absolute target path
 */
export async function resolveWithin(root, target) {
  const rootPath = assertAbsolutePath(root, "root");
  const targetPath = assertAbsolutePath(target, "path");
  if (targetPath === rootPath) return targetPath;
  if (!isContained(rootPath, targetPath)) {
    throw new OpError("outside-root", `Path is outside the root directory: ${targetPath}`, { path: targetPath, root: rootPath });
  }
  const rootReal = await realpathOrThrow(rootPath);
  const parentReal = await realpathOrThrow(path.dirname(targetPath));
  if (!isContained(rootReal, parentReal)) {
    throw new OpError("outside-root", `Path resolves outside the root directory: ${targetPath}`, { path: targetPath, root: rootPath });
  }
  return targetPath;
}

/**
 * Like {@link resolveWithin}, but the target itself (not just its parent) must
 * physically resolve inside the root. This is required for operands we write
 * *through* - the create parent and the copy/move target directory - because a
 * final symlink pointing outside the root must never be followed for writes.
 *
 * A final symlink that points back inside the root stays allowed, so paths that
 * traverse an internal symlink keep working.
 *
 * @param {string} root absolute root directory
 * @param {string} target absolute container path
 * @returns {Promise<string>} normalised absolute target path
 */
export async function resolveRealWithin(root, target) {
  const rootPath = assertAbsolutePath(root, "root");
  const targetPath = await resolveWithin(rootPath, target);
  const rootReal = await realpathOrThrow(rootPath);
  const targetReal = await realpathOrThrow(targetPath);
  if (!isContained(rootReal, targetReal)) {
    throw new OpError("outside-root", `Path resolves outside the root directory: ${targetPath}`, {
      path: targetPath,
      root: rootPath,
    });
  }
  return targetPath;
}

/** @param {import("node:fs").Stats} stat */
function entryType(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

/**
 * Build a listing entry from an lstat result.
 *
 * @param {string} name
 * @param {import("node:fs").Stats} stat
 */
function entryFromStat(name, stat) {
  const entry = { name, type: entryType(stat), mtime: stat.mtimeMs };
  if (stat.isFile()) entry.size = stat.size;
  return entry;
}

/**
 * List one directory level.
 *
 * - directories first, then files/others
 * - natural, case-insensitive name order (`Intl.Collator` numeric + base)
 * - hidden entries included
 * - `type` is `file | directory | other` based on lstat (symlinks are `other`)
 * - at most `maxEntries` entries; `truncated` is true when the directory has more
 *
 * @param {string} dir absolute directory path
 * @param {{ maxEntries?: number }} [options]
 * @returns {Promise<{ path: string, entries: Array<{ name: string, type: "file"|"directory"|"other", size?: number, mtime: number }>, truncated: boolean }>}
 */
export async function listEntries(dir, options = {}) {
  const directory = assertAbsolutePath(dir, "path");
  const requested =
    Number.isInteger(options?.maxEntries) && options.maxEntries > 0 ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  /** @type {import("node:fs").Dirent[]} */
  let dirents;
  try {
    dirents = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw toOpError(error);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const ranked = dirents.map((dirent) => ({ name: dirent.name, directory: dirent.isDirectory() }));
  ranked.sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return collator.compare(left.name, right.name);
  });
  const truncated = ranked.length > requested;
  const selected = truncated ? ranked.slice(0, requested) : ranked;
  const entries = [];
  for (const { name } of selected) {
    let stat;
    try {
      stat = await fs.lstat(path.join(directory, name));
    } catch (error) {
      // The entry disappeared between readdir and lstat: skip the stale entry.
      if (error && /** @type {{code?: unknown}} */ (error).code === "ENOENT") continue;
      throw toOpError(error);
    }
    entries.push(entryFromStat(name, stat));
  }
  return { path: directory, entries, truncated };
}

/**
 * Stat one entry (lstat, so a symlink reports itself as `other`).
 *
 * @param {string} target absolute path
 * @returns {Promise<{ name: string, type: "file"|"directory"|"other", size?: number, mtime: number, mode: number }>}
 */
export async function statEntry(target) {
  const targetPath = assertAbsolutePath(target, "path");
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch (error) {
    throw toOpError(error);
  }
  const result = { name: path.basename(targetPath), type: entryType(stat), mtime: stat.mtimeMs, mode: stat.mode };
  if (stat.isFile()) result.size = stat.size;
  return result;
}

/**
 * Create an empty file or a directory inside an existing parent directory.
 *
 * @param {string} parent absolute existing parent directory
 * @param {string} name single path segment
 * @param {"file"|"directory"} kind
 * @returns {Promise<{ path: string }>}
 */
export async function createEntry(parent, name, kind) {
  const parentPath = assertAbsolutePath(parent, "parent");
  const entryName = validateName(name);
  if (kind !== "file" && kind !== "directory") {
    throw new OpError("bad-request", '"kind" must be "file" or "directory"', { field: "kind" });
  }
  const targetPath = path.join(parentPath, entryName);
  try {
    if (kind === "file") {
      await fs.writeFile(targetPath, "", { flag: "wx" });
    } else {
      await fs.mkdir(targetPath);
    }
  } catch (error) {
    throw toOpError(error);
  }
  return { path: targetPath };
}

/**
 * Rename an entry inside its current directory.
 *
 * A case-only rename is allowed on case-insensitive filesystems: the existing
 * destination is only accepted when it is the very same inode as the source
 * (macOS/Windows), otherwise a real conflict is reported as `already-exists`.
 *
 * @param {string} target absolute path of the entry to rename
 * @param {string} newName new single path segment
 * @returns {Promise<{ path: string }>}
 */
export async function renameEntry(target, newName) {
  const targetPath = assertAbsolutePath(target, "path");
  const entryName = validateName(newName);
  const nextPath = path.join(path.dirname(targetPath), entryName);
  let sourceStat;
  try {
    sourceStat = await fs.lstat(targetPath);
  } catch (error) {
    throw toOpError(error);
  }
  if (nextPath === targetPath) return { path: targetPath };
  const existing = await lstatOrNull(nextPath);
  if (existing !== null) {
    const sameEntry = existing.dev === sourceStat.dev && existing.ino === sourceStat.ino;
    if (!sameEntry) {
      throw new OpError("already-exists", `An entry named ${JSON.stringify(entryName)} already exists`, { path: nextPath });
    }
  }
  try {
    await fs.rename(targetPath, nextPath);
  } catch (error) {
    throw toOpError(error);
  }
  return { path: nextPath };
}

/**
 * Permanently delete entries (recursively for directories).
 *
 * The root directory itself can never be deleted. Every target is re-validated
 * against the root with {@link resolveWithin} as a defence in depth.
 *
 * @param {unknown} targets absolute paths
 * @param {{ root: string }} options
 * @returns {Promise<{ deleted: string[] }>}
 */
export async function deleteEntries(targets, options = {}) {
  const root = assertAbsolutePath(options?.root, "root");
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new OpError("bad-request", '"paths" must be a non-empty array of absolute paths', { field: "paths" });
  }
  const deleted = [];
  for (const rawTarget of targets) {
    const targetPath = assertAbsolutePath(rawTarget, "paths[]");
    if (targetPath === root) {
      throw new OpError("bad-request", "The root directory cannot be deleted");
    }
    const contained = await resolveWithin(root, targetPath);
    try {
      await fs.rm(contained, { recursive: true, force: false });
    } catch (error) {
      throw toOpError(error);
    }
    deleted.push(contained);
  }
  return { deleted };
}

/** @param {unknown} value */
function normalizeSources(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OpError("bad-request", '"sources" must be a non-empty array of absolute paths', { field: "sources" });
  }
  return value.map((rawSource, index) => {
    const sourcePath = assertAbsolutePath(rawSource, `sources[${index}]`);
    const base = path.basename(sourcePath);
    if (base === "") {
      throw new OpError("bad-request", `Unsupported source path: ${sourcePath}`, { field: `sources[${index}]` });
    }
    return sourcePath;
  });
}

/** @param {unknown} value */
function normalizeConflict(value) {
  if (value === undefined || value === null) return "rename";
  if (value === "rename" || value === "skip" || value === "overwrite") return value;
  throw new OpError("bad-request", '"conflict" must be "rename", "skip" or "overwrite"', { field: "conflict" });
}

/** @param {string} targetDir */
async function requireDirectoryTarget(targetDir) {
  const directory = assertAbsolutePath(targetDir, "targetDir");
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch (error) {
    throw toOpError(error);
  }
  if (!stat.isDirectory()) {
    throw new OpError("not-directory", `Not a directory: ${directory}`, { path: directory });
  }
  return directory;
}

/**
 * Reject a paste/move target that is the source itself or inside a source
 * directory (design.md D5: "复制/移动目标位于源内部直接拒绝").
 *
 * @param {string[]} sources
 * @param {string} targetDirectory
 */
function assertNoNestedTarget(sources, targetDirectory) {
  for (const source of sources) {
    if (containsPath(source, targetDirectory)) {
      throw new OpError("bad-request", "The target directory is inside a source directory", {
        source,
        targetDir: targetDirectory,
      });
    }
  }
}

/** @param {string} target absolute path */
async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error && /** @type {{code?: unknown}} */ (error).code === "ENOENT") return null;
    throw toOpError(error);
  }
}

/**
 * Find a non-conflicting sibling name: `name copy`, `name copy 2`, ...
 *
 * @param {string} target absolute destination path that already exists
 * @returns {Promise<string>}
 */
async function findAvailableName(target) {
  const directory = path.dirname(target);
  const base = path.basename(target);
  const extension = path.extname(base);
  const stem = extension === "" ? base : base.slice(0, base.length - extension.length);
  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`;
    const candidate = path.join(directory, `${stem}${suffix}${extension}`);
    if ((await lstatOrNull(candidate)) === null) return candidate;
  }
  throw new OpError("already-exists", `Could not find a non-conflicting name for ${JSON.stringify(base)}`);
}

/**
 * Copy sources into a target directory (files and directories, recursive).
 *
 * @param {unknown} sources absolute source paths
 * @param {string} targetDir absolute existing target directory
 * @param {"rename"|"skip"|"overwrite"} [conflict]
 * @returns {Promise<{ results: Array<{ source: string, path: string, status: "copied"|"skipped"|"renamed" }> }>}
 */
export async function copyEntries(sources, targetDir, conflict = "rename") {
  const sourcePaths = normalizeSources(sources);
  const targetDirectory = await requireDirectoryTarget(targetDir);
  const mode = normalizeConflict(conflict);
  assertNoNestedTarget(sourcePaths, targetDirectory);
  const results = [];
  for (const sourcePath of sourcePaths) {
    const base = path.basename(sourcePath);
    let destination = path.join(targetDirectory, base);
    const samePath = destination === sourcePath;
    const existing = samePath ? true : (await lstatOrNull(destination)) !== null;
    let status = "copied";
    if (existing) {
      if (mode === "skip") {
        results.push({ source: sourcePath, path: destination, status: "skipped" });
        continue;
      }
      if (mode === "overwrite") {
        if (samePath) {
          throw new OpError("bad-request", "Cannot overwrite a source with itself", { source: sourcePath });
        }
        try {
          await fs.rm(destination, { recursive: true, force: true });
        } catch (error) {
          throw toOpError(error);
        }
      } else {
        destination = await findAvailableName(destination);
        status = "renamed";
      }
    }
    if (destination === sourcePath) {
      throw new OpError("bad-request", "Source and destination are the same path", { source: sourcePath });
    }
    try {
      await fs.cp(sourcePath, destination, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    } catch (error) {
      throw toOpError(error);
    }
    results.push({ source: sourcePath, path: destination, status });
  }
  return { results };
}

/**
 * Move one entry, falling back to copy+delete when the filesystem returns
 * `EXDEV` (source and destination on different mounts).
 *
 * @param {string} sourcePath
 * @param {string} destination
 */
async function moveOne(sourcePath, destination) {
  try {
    await fs.rename(sourcePath, destination);
    return;
  } catch (error) {
    if (!error || /** @type {{code?: unknown}} */ (error).code !== "EXDEV") throw toOpError(error);
  }
  try {
    await fs.cp(sourcePath, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    await fs.rm(sourcePath, { recursive: true, force: false });
  } catch (error) {
    throw toOpError(error);
  }
}

/**
 * Move sources into a target directory.
 *
 * @param {unknown} sources absolute source paths
 * @param {string} targetDir absolute existing target directory
 * @param {"rename"|"skip"|"overwrite"} [conflict]
 * @returns {Promise<{ results: Array<{ source: string, path: string, status: "copied"|"skipped"|"renamed" }> }>}
 */
export async function moveEntries(sources, targetDir, conflict = "rename") {
  const sourcePaths = normalizeSources(sources);
  const targetDirectory = await requireDirectoryTarget(targetDir);
  const mode = normalizeConflict(conflict);
  assertNoNestedTarget(sourcePaths, targetDirectory);
  const results = [];
  for (const sourcePath of sourcePaths) {
    let destination = path.join(targetDirectory, path.basename(sourcePath));
    if (destination === sourcePath) {
      throw new OpError("bad-request", "Source and destination are the same path", { source: sourcePath });
    }
    const existing = (await lstatOrNull(destination)) !== null;
    let status = "copied";
    if (existing) {
      if (mode === "skip") {
        results.push({ source: sourcePath, path: destination, status: "skipped" });
        continue;
      }
      if (mode === "overwrite") {
        try {
          await fs.rm(destination, { recursive: true, force: true });
        } catch (error) {
          throw toOpError(error);
        }
      } else {
        destination = await findAvailableName(destination);
        status = "renamed";
      }
    }
    await moveOne(sourcePath, destination);
    results.push({ source: sourcePath, path: destination, status });
  }
  return { results };
}

/**
 * Reveal a path in the platform file manager.
 *
 * - darwin: `open -R <path>`
 * - win32: `explorer /select,<path>`
 * - linux/other: `xdg-open <dirname(path)>`
 *
 * The child process is detached with ignored stdio so the host never waits for
 * the file manager. Spawn failures surface as `internal` (the command is part
 * of the host environment, not of the requested path).
 *
 * @param {string} target absolute path to reveal
 * @returns {Promise<void>}
 */
export async function revealPath(target) {
  const targetPath = assertAbsolutePath(target, "path");
  const platform = process.platform;
  let command;
  /** @type {string[]} */
  let args;
  if (platform === "darwin") {
    command = "open";
    args = ["-R", targetPath];
  } else if (platform === "win32") {
    command = "explorer";
    args = [`/select,${targetPath}`];
  } else {
    command = "xdg-open";
    args = [path.dirname(targetPath)];
  }
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    child = spawn(command, args, { detached: true, stdio: "ignore" });
  } catch (error) {
    throw new OpError("internal", `Failed to reveal path: ${error instanceof Error ? error.message : String(error)}`);
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new OpError("internal", `Failed to reveal path: ${error instanceof Error ? error.message : String(error)}`));
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(undefined);
    });
  });
}
