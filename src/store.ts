/**
 * Disk-backed responseId store.
 *
 * Upstream's `storage.ts` keeps results in a module-level Map, so a
 * `responseId` lives only as long as the process that produced it. The Pi host
 * bridges that with `sessionManager` (`restoreFromSession` /
 * `loadSessionResults`); the desktop plugin has no equivalent, so this module is
 * the replacement: every stored result is written to the plugin data directory
 * and read back on demand.
 *
 * Memory stays the working set — upstream's own core still holds results and
 * still evicts after 50 — while disk keeps up to `MAX_PERSISTED` entries for
 * `get_search_content` after a reload or a restart. Nothing here changes the
 * shape of a stored result: a file is the same `StoredSearchData` JSON upstream
 * would have kept in its Map.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { storeResult, type StoredSearchData } from "../upstream/storage.ts";

/** Entries kept on disk; upstream's in-memory cap stays at 50. */
const MAX_PERSISTED = 120;
const RESULTS_DIR = "results";
const INDEX_FILE = "index.json";

/**
 * The id alphabet upstream uses for its own fetch cache (`CACHE_ID_PATTERN` in
 * `upstream/storage.ts`). Every file this module touches is named after an id,
 * and those ids arrive from callers: the panel's `results:*` channels and the
 * model's `responseId` argument. An id that cannot be a plain file name is
 * rejected rather than sanitised, because a rewritten id would no longer be
 * findable by whoever asked for it. The length cap also bounds how much of a
 * 1 MB `responseId` can be echoed back in an error message.
 */
const CACHE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface StoredResultSummary {
  id: string;
  type: StoredSearchData["type"];
  timestamp: number;
  /** Page title for a fetch, the joined queries for a search. */
  label: string;
  urlCount: number;
  queryCount: number;
  /** Bytes of the stored file, so the panel can show the weight. */
  size: number;
}

let rootDir: string | null = null;

function storeRoot(): string | null {
  return rootDir ?? process.env.PI_WEB_ACCESS_CACHE_ROOT ?? null;
}

function resultsDir(): string | null {
  const root = storeRoot();
  return root ? join(root, RESULTS_DIR) : null;
}

function indexPath(): string | null {
  const dir = resultsDir();
  return dir ? join(dir, INDEX_FILE) : null;
}

/** True when `id` can name a file in the store. */
function isCacheId(id: unknown): id is string {
  return typeof id === "string" && CACHE_ID_PATTERN.test(id);
}

/**
 * Absolute path for one stored result, or null when the id cannot name a file
 * inside `dir`. `path.join` resolves `..`, so the pattern check is what stops
 * `../../secrets` from escaping; the resolve check keeps that guard from resting
 * on the regex alone if a future caller passes a different `dir`.
 */
function resultFile(dir: string, id: unknown): string | null {
  if (!isCacheId(id)) return null;
  const file = join(dir, `${id}.json`);
  const root = resolve(dir);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return resolve(file).startsWith(prefix) ? file : null;
}

/** Points the store at the plugin data directory. Safe to call on every load. */
export function configureResultStore(dir: string): void {
  rootDir = dir;
  const target = resultsDir();
  if (target) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    pruneTemporaryFiles(target);
  }
}

/** A crashed write leaves `*.tmp` behind and no sweep ever looks for one. */
function pruneTemporaryFiles(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tmp")) continue;
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // Locked by the writer that is still alive; the next sweep gets it.
      }
    }
  } catch {
    // An unreadable directory is reported by the panel's repair action.
  }
}

function isStoredResult(value: unknown): value is StoredSearchData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.timestamp === "number"
    && (record.type === "search" || record.type === "fetch" || record.type === "research");
}

function labelFor(data: StoredSearchData): string {
  if (data.type === "fetch") {
    const first = data.urls?.[0];
    return first?.title || first?.url || "(fetch)";
  }
  if (data.type === "research") return "(source check)";
  const queries = data.queries?.map((item) => item.query).filter(Boolean) ?? [];
  return queries.length > 0 ? queries.join(" / ") : "(search)";
}

/** Index entries are written by this module, so only the two keys the panel
 * needs are mandatory; `id` is also re-checked because the file is editable. */
function isSummary(entry: unknown): entry is StoredResultSummary {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return isCacheId(record.id) && typeof record.timestamp === "number";
}

function readIndex(): StoredResultSummary[] {
  const file = indexPath();
  if (!file || !existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSummary);
  } catch {
    // A corrupt index reads as empty. `upsertIndex` rebuilds it from the result
    // files before writing, so this never silently drops entries.
    return [];
  }
}

function writeIndex(entries: StoredResultSummary[]): void {
  const file = indexPath();
  if (!file) return;
  // Unique per writer: two instances sharing one data directory must not rename
  // each other's half-written temp file into place.
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

/** Summary rebuilt from one result file, or null when it is unreadable. */
function summaryFromFile(dir: string, name: string): StoredResultSummary | null {
  const id = name.slice(0, -".json".length);
  if (!isCacheId(id)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (!isStoredResult(parsed)) return null;
    return {
      id,
      type: parsed.type,
      timestamp: parsed.timestamp,
      label: labelFor(parsed),
      urlCount: parsed.urls?.length ?? 0,
      queryCount: parsed.queries?.length ?? 0,
      size: Buffer.byteLength(JSON.stringify(parsed), "utf8"),
    };
  } catch {
    // Unreadable file: leave it alone rather than deleting a user's data.
    return null;
  }
}

/** Index rebuilt from the result files themselves, newest first. */
function scanFiles(dir: string): StoredResultSummary[] {
  const rebuilt: StoredResultSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (name === INDEX_FILE || !name.endsWith(".json")) continue;
    const summary = summaryFromFile(dir, name);
    if (summary) rebuilt.push(summary);
  }
  return rebuilt.sort((a, b) => b.timestamp - a.timestamp);
}

function upsertIndex(summary: StoredResultSummary): void {
  let entries = readIndex();
  if (entries.length === 0) {
    // Either the first write or a corrupt index; rebuilding from the files keeps
    // the earlier entries that a blind overwrite would have erased.
    const dir = resultsDir();
    if (dir && existsSync(dir)) entries = scanFiles(dir);
  }
  entries = entries.filter((entry) => entry.id !== summary.id);
  entries.push(summary);
  entries.sort((a, b) => b.timestamp - a.timestamp);
  const kept = entries.slice(0, MAX_PERSISTED);
  for (const dropped of entries.slice(MAX_PERSISTED)) removeFile(dropped.id);
  writeIndex(kept);
}

function removeFile(id: unknown): void {
  const dir = resultsDir();
  if (!dir) return;
  const file = resultFile(dir, id);
  if (!file) return;
  try {
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    // A file we cannot remove is retried by the next prune.
  }
}

/**
 * Writes one result. Failures are swallowed on purpose: a full disk must not
 * turn a successful fetch into a tool error, because the in-memory copy the
 * core keeps is still enough for this session.
 */
export function persistResult(id: string, data: StoredSearchData): void {
  const dir = resultsDir();
  if (!dir) return;
  const file = resultFile(dir, id);
  if (!file) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
    const text = `${JSON.stringify(data)}\n`;
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
    upsertIndex({
      id,
      type: data.type,
      timestamp: data.timestamp,
      label: labelFor(data),
      urlCount: data.urls?.length ?? 0,
      queryCount: data.queries?.length ?? 0,
      size: Buffer.byteLength(text, "utf8"),
    });
  } catch {
    // see the doc comment above
  }
}

/**
 * Reads one result back from disk and puts it in upstream's in-memory store so
 * the unmodified `get_search_content` can page through it. Returns false when
 * there is no such file or it no longer parses.
 */
export function hydrateResult(id: string): boolean {
  const dir = resultsDir();
  if (!dir) return false;
  const file = resultFile(dir, id);
  if (!file || !existsSync(file)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isStoredResult(parsed)) return false;
    // Upstream's `readCachedFetchData` replaces the content of a `fetch` result
    // older than `CACHE_TTL_MS` (one hour) with an "expired" placeholder. The
    // file on disk is intact, so the in-memory copy is stamped with the current
    // time; the stored timestamp still orders the panel's list.
    const revived: StoredSearchData = parsed.type === "fetch" ? { ...parsed, timestamp: Date.now() } : parsed;
    storeResult(id, revived);
    return true;
  } catch {
    return false;
  }
}

/** Newest first, for the panel's result browser. */
export function listStoredResults(): StoredResultSummary[] {
  return readIndex().sort((a, b) => b.timestamp - a.timestamp);
}

/** Raw stored result for the panel's preview, or null when it is missing. */
export function readStoredResult(id: string): StoredSearchData | null {
  const dir = resultsDir();
  if (!dir) return null;
  const file = resultFile(dir, id);
  if (!file || !existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isStoredResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Removes one stored result from disk and from the index. */
export function dropStoredResult(id: string): boolean {
  if (!isCacheId(id)) return false;
  removeFile(id);
  const entries = readIndex();
  const next = entries.filter((entry) => entry.id !== id);
  writeIndex(next);
  return next.length !== entries.length;
}

/** Drops every result file this module owns; used by the panel's "clear" action. */
export function clearStoredResults(): number {
  const dir = resultsDir();
  if (!dir || !existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (name === INDEX_FILE) continue;
    if (!name.endsWith(".json")) {
      // Leftover temp files from a crashed or interrupted write.
      if (name.endsWith(".tmp")) {
        try {
          rmSync(join(dir, name), { force: true });
        } catch {
          // Still locked by a live writer.
        }
      }
      continue;
    }
    const id = name.slice(0, -".json".length);
    if (!isCacheId(id)) continue;
    removeFile(id);
    removed += 1;
  }
  writeIndex([]);
  return removed;
}

/** Rebuilds the index from the result files when the index is missing or stale. */
export function repairIndex(): number {
  const dir = resultsDir();
  if (!dir || !existsSync(dir)) return 0;
  pruneTemporaryFiles(dir);
  const known = new Set(readIndex().map((entry) => entry.id));
  const rebuilt = scanFiles(dir).filter((entry) => !known.has(entry.id));
  if (rebuilt.length === 0) return 0;
  const merged = [...readIndex(), ...rebuilt].sort((a, b) => b.timestamp - a.timestamp);
  const kept = merged.slice(0, MAX_PERSISTED);
  for (const dropped of merged.slice(MAX_PERSISTED)) removeFile(dropped.id);
  writeIndex(kept);
  const keptIds = new Set(kept.map((entry) => entry.id));
  return rebuilt.filter((entry) => keptIds.has(entry.id)).length;
}
