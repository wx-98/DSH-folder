/**
 * Host half of the Folder Explorer bundle.
 *
 * Registers the `/folder-explorer/*` HTTP routes used by the browser half.
 * Every route is guarded by the dsh connection fence
 * (`ctx.connection.requestRejection`), validates absolute paths against the
 * caller supplied root (design.md D5) and answers with the JSON contract from
 * design.md D10. Mutating routes are serialised through one promise queue.
 *
 * The browser half lives in ./client.js and is discovered through this
 * package's `dsh.client` declaration.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";

import {
  OpError,
  assertAbsolutePath,
  containsPath,
  copyEntries,
  createEntry,
  deleteEntries,
  listEntries,
  moveEntries,
  renameEntry,
  resolveRealWithin,
  resolveWithin,
  revealPath,
  statEntry,
  toOpError,
  validateName,
} from "./lib/ops.js";

export const name = "folder-explorer";
export const inject = ["webServer", "connection"];

/** Shared route prefix (design.md D10). */
const PREFIX = "/folder-explorer";
/** Hard cap for JSON request bodies: 64 KiB. */
const MAX_BODY_BYTES = 64 * 1024;
/** Hard cap for directory listings (design.md D10). */
const MAX_ENTRIES = 2000;

/** Wire error code -> HTTP status (design.md D10). */
const STATUS_BY_CODE = Object.freeze({
  "bad-request": 400,
  "invalid-name": 400,
  "invalid-path": 400,
  "outside-root": 403,
  forbidden: 403,
  "not-found": 404,
  "already-exists": 409,
  "not-directory": 400,
  "is-directory": 400,
  "permission-denied": 403,
  busy: 409,
  unsupported: 400,
  internal: 500,
  "io-error": 500,
});

const CONFLICT_MODES = Object.freeze(["rename", "skip", "overwrite"]);

/** Errors raised by the transport layer which need an explicit HTTP status. */
class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code wire error code
   * @param {string} message human readable message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Mutation queue (design.md D11): every mutating route shares one promise
// chain, so two requests never interleave. A rejected task never poisons the
// chain for the requests that follow it.
// ---------------------------------------------------------------------------
let mutationChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueueMutation(task) {
  const result = mutationChain.then(() => task());
  mutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} error
 */
function sendError(res, error) {
  if (res.writableEnded) return;
  if (error instanceof HttpError) {
    sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
    return;
  }
  const opError = error instanceof OpError ? error : toOpError(error);
  sendJson(res, STATUS_BY_CODE[opError.code] ?? 500, opError.toWire());
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {URL}
 */
function parseRequestUrl(req) {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    throw new HttpError(400, "bad-request", "Malformed request URL");
  }
}

/**
 * Consume (and discard) the remaining request body so the response can be
 * written without racing the client's upload.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<void>}
 */
function drainRequest(req) {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", resolve);
    req.on("close", resolve);
    req.on("error", () => resolve());
  });
}

/**
 * Read and parse a JSON object body, enforcing the 64 KiB cap and the
 * `application/json` content type. The request stream is always drained, so
 * oversized or wrongly typed requests still receive their 413/415 response.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req) {
  const contentType = String(req.headers["content-type"] ?? "").trim();
  const hasJsonContentType = /^application\/json(?:\s*;|$)/i.test(contentType);
  const declaredLength = Number(req.headers["content-length"]);
  const chunks = [];
  let total = 0;
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES;
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      total += chunk.length;
      if (tooLarge) return;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (hasJsonContentType) chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  if (tooLarge) throw new HttpError(413, "bad-request", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  if (!hasJsonContentType) throw new HttpError(415, "bad-request", 'Content-Type must be "application/json"');
  const buffer = Buffer.concat(chunks);
  const text = buffer.toString("utf8");
  if (text.trim() === "") throw new OpError("bad-request", "Request body must be a JSON object");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpError("bad-request", "Request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpError("bad-request", "Request body must be a JSON object");
  }
  return parsed;
}

/**
 * @param {string} rawRoot
 * @returns {Promise<string>} normalised absolute root directory
 */
async function requireRootDirectory(rawRoot) {
  const root = assertAbsolutePath(rawRoot, "root");
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    throw toOpError(error);
  }
  if (!stat.isDirectory()) throw new OpError("not-directory", `Not a directory: ${root}`, { path: root });
  return root;
}

/**
 * @param {string} target
 * @returns {Promise<string>}
 */
async function requireDirectory(target) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    throw toOpError(error);
  }
  if (!stat.isDirectory()) throw new OpError("not-directory", `Not a directory: ${target}`, { path: target });
  return target;
}

/**
 * @param {URL} url
 * @param {string} field
 * @returns {string}
 */
function requireQuery(url, field) {
  const value = url.searchParams.get(field);
  if (value === null || value === "") {
    throw new OpError("bad-request", `Missing query parameter "${field}"`, { field });
  }
  return value;
}

/**
 * @param {Record<string, unknown>} body
 * @param {readonly string[]} allowed
 */
function assertAllowedFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new OpError("bad-request", `Unknown field "${key}"`, { field: key });
    }
  }
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} field
 * @returns {string}
 */
function requireNameField(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    throw new OpError("bad-request", `Missing required field "${field}"`, { field });
  }
  return validateName(body[field]);
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} field
 * @returns {unknown[]}
 */
function requireArrayField(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    throw new OpError("bad-request", `Missing required field "${field}"`, { field });
  }
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new OpError("bad-request", `"${field}" must be a non-empty array of absolute paths`, { field });
  }
  return value;
}

/**
 * @param {Record<string, unknown>} body
 * @returns {"rename"|"skip"|"overwrite"}
 */
function requireConflictField(body) {
  const value = body.conflict;
  if (typeof value !== "string" || !CONFLICT_MODES.includes(value)) {
    throw new OpError("bad-request", '"conflict" must be "rename", "skip" or "overwrite"', { field: "conflict" });
  }
  return /** @type {"rename"|"skip"|"overwrite"} */ (value);
}

/**
 * @param {Record<string, unknown>} body
 * @returns {"file"|"directory"}
 */
function requireKindField(body) {
  const value = body.kind;
  if (value !== "file" && value !== "directory") {
    throw new OpError("bad-request", '"kind" must be "file" or "directory"', { field: "kind" });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Read-only routes (never queued)
// ---------------------------------------------------------------------------

/**
 * GET /folder-explorer/browse?path=<abs>
 *
 * List an arbitrary directory (no root containment) for the "open folder"
 * dialog. Missing `path` defaults to the user home directory.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleBrowse(req, res) {
  const url = parseRequestUrl(req);
  const requested = url.searchParams.get("path");
  const target = requested === null ? assertAbsolutePath(os.homedir(), "path") : assertAbsolutePath(requested, "path");
  const directory = await requireDirectory(target);
  const listing = await listEntries(directory, { maxEntries: MAX_ENTRIES });
  const parent = path.dirname(directory);
  sendJson(res, 200, {
    ok: true,
    path: directory,
    parent: parent === directory ? null : parent,
    entries: listing.entries.map((entry) => ({ name: entry.name, type: entry.type })),
    truncated: listing.truncated,
  });
}

/**
 * GET /folder-explorer/list?root=<abs>&path=<abs>
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleList(req, res) {
  const url = parseRequestUrl(req);
  const root = await requireRootDirectory(requireQuery(url, "root"));
  const requested = url.searchParams.get("path");
  const target = requested === null ? root : await resolveWithin(root, assertAbsolutePath(requested, "path"));
  const listing = await listEntries(target, { maxEntries: MAX_ENTRIES });
  sendJson(res, 200, { ok: true, path: target, entries: listing.entries, truncated: listing.truncated });
}

/**
 * GET /folder-explorer/stat?root=<abs>&path=<abs>
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleStat(req, res) {
  const url = parseRequestUrl(req);
  const root = await requireRootDirectory(requireQuery(url, "root"));
  const requested = url.searchParams.get("path");
  const target = requested === null ? root : await resolveWithin(root, assertAbsolutePath(requested, "path"));
  const stat = await statEntry(target);
  sendJson(res, 200, { ok: true, stat });
}

// ---------------------------------------------------------------------------
// Mutating routes (serialised through the queue)
// ---------------------------------------------------------------------------

/**
 * POST /folder-explorer/create
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleCreate(req, res) {
  const body = await readJsonBody(req);
  assertAllowedFields(body, ["root", "parent", "name", "kind"]);
  const root = await requireRootDirectory(body.root);
  const parent = await resolveRealWithin(root, assertAbsolutePath(body.parent, "parent"));
  const entryName = requireNameField(body, "name");
  const kind = requireKindField(body);
  const result = await enqueueMutation(() => createEntry(parent, entryName, kind));
  sendJson(res, 200, { ok: true, path: result.path });
}

/**
 * POST /folder-explorer/rename
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleRename(req, res) {
  const body = await readJsonBody(req);
  assertAllowedFields(body, ["root", "path", "newName"]);
  const root = await requireRootDirectory(body.root);
  const target = await resolveWithin(root, assertAbsolutePath(body.path, "path"));
  if (target === root) throw new OpError("bad-request", "The root directory cannot be renamed");
  const newName = requireNameField(body, "newName");
  const result = await enqueueMutation(() => renameEntry(target, newName));
  sendJson(res, 200, { ok: true, path: result.path });
}

/**
 * POST /folder-explorer/delete
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleDelete(req, res) {
  const body = await readJsonBody(req);
  assertAllowedFields(body, ["root", "paths", "confirm"]);
  if (body.confirm !== true) {
    throw new OpError("bad-request", '"confirm" must be true', { field: "confirm" });
  }
  const root = await requireRootDirectory(body.root);
  const rawPaths = requireArrayField(body, "paths");
  const targets = [];
  for (const rawPath of rawPaths) {
    const target = await resolveWithin(root, assertAbsolutePath(rawPath, "paths[]"));
    if (target === root) throw new OpError("bad-request", "The root directory cannot be deleted");
    targets.push(target);
  }
  const result = await enqueueMutation(() => deleteEntries(targets, { root }));
  sendJson(res, 200, { ok: true, deleted: result.deleted });
}

/**
 * Shared parser for copy/move bodies.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<{ root: string, sources: string[], targetDir: string, conflict: "rename"|"skip"|"overwrite" }>}
 */
async function parseTransferBody(req) {
  const body = await readJsonBody(req);
  assertAllowedFields(body, ["root", "sources", "targetDir", "conflict"]);
  const root = await requireRootDirectory(body.root);
  const targetDir = await resolveRealWithin(root, assertAbsolutePath(body.targetDir, "targetDir"));
  await requireDirectory(targetDir);
  const conflict = requireConflictField(body);
  const rawSources = requireArrayField(body, "sources");
  const sources = [];
  for (const rawSource of rawSources) {
    const source = await resolveWithin(root, assertAbsolutePath(rawSource, "sources[]"));
    if (containsPath(source, targetDir)) {
      throw new OpError("bad-request", "The target directory is inside a source directory", { source, targetDir });
    }
    sources.push(source);
  }
  return { root, sources, targetDir, conflict };
}

/**
 * POST /folder-explorer/copy
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleCopy(req, res) {
  const { sources, targetDir, conflict } = await parseTransferBody(req);
  const result = await enqueueMutation(() => copyEntries(sources, targetDir, conflict));
  sendJson(res, 200, { ok: true, results: result.results });
}

/**
 * POST /folder-explorer/move
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleMove(req, res) {
  const { sources, targetDir, conflict } = await parseTransferBody(req);
  const result = await enqueueMutation(() => moveEntries(sources, targetDir, conflict));
  sendJson(res, 200, { ok: true, results: result.results });
}

/**
 * POST /folder-explorer/reveal
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleReveal(req, res) {
  const body = await readJsonBody(req);
  assertAllowedFields(body, ["root", "path"]);
  const root = await requireRootDirectory(body.root);
  const target = await resolveWithin(root, assertAbsolutePath(body.path, "path"));
  await enqueueMutation(() => revealPath(target));
  sendJson(res, 200, { ok: true });
}

/**
 * Fallback for unknown `/folder-explorer/*` routes.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleUnknown(req, res) {
  await drainRequest(req);
  const url = parseRequestUrl(req);
  sendJson(res, 404, { ok: false, code: "not-found", message: `Unknown folder-explorer route: ${req.method ?? "?"} ${url.pathname}` });
}

// ---------------------------------------------------------------------------
// Route table + registration
// ---------------------------------------------------------------------------
const ROUTES = Object.freeze([
  { method: "GET", path: `${PREFIX}/browse`, handler: handleBrowse },
  { method: "GET", path: `${PREFIX}/list`, handler: handleList },
  { method: "GET", path: `${PREFIX}/stat`, handler: handleStat },
  { method: "POST", path: `${PREFIX}/create`, handler: handleCreate },
  { method: "POST", path: `${PREFIX}/rename`, handler: handleRename },
  { method: "POST", path: `${PREFIX}/delete`, handler: handleDelete },
  { method: "POST", path: `${PREFIX}/copy`, handler: handleCopy },
  { method: "POST", path: `${PREFIX}/move`, handler: handleMove },
  { method: "POST", path: `${PREFIX}/reveal`, handler: handleReveal },
]);

/**
 * Wrap a route handler with the connection fence and a top level try/catch.
 *
 * @param {any} ctx plugin context
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>} handler
 * @param {string|null} method allowed HTTP method, or null to accept any method
 */
function wrapHandler(ctx, handler, method) {
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (method !== null && req.method !== method) {
      await drainRequest(req);
      res.setHeader("allow", method);
      sendJson(res, 405, { ok: false, code: "bad-request", message: `Method ${req.method ?? "?"} is not allowed` });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

/**
 * Register the Folder Explorer host routes.
 *
 * @param {any} ctx cordis plugin context (`webServer` + `connection` injected)
 * @param {unknown} [_config]
 */
export function apply(ctx, _config) {
  for (const route of ROUTES) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "exact",
          path: route.path,
          handler: wrapHandler(ctx, route.handler, route.method),
        }),
      `folder-explorer: ${route.method} ${route.path}`,
    );
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: wrapHandler(ctx, handleUnknown, null),
      }),
    `folder-explorer: ${PREFIX}/* fallback`,
  );
}
