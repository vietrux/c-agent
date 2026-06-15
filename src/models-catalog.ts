// Per-model context-window catalog sourced from models.dev.
//
// models.dev publishes a flat map keyed by "<provider>/<model-id>", each entry
// carrying limit.context (the model's context window) and limit.output. We cache
// it on disk and refresh at most once every CATALOG_TTL_MS (7 days), so the agent
// can size its context budget per model instead of using one fixed number.
//
// Lookup is tolerant: the configured model id is matched against the full key
// ("anthropic/claude-opus-4-5") and, failing that, the bare suffix
// ("claude-opus-4-5"). The bare match bridges provider-name mismatches — e.g. the
// NIM config uses "minimaxai/minimax-m2.7" while models.dev keys it under
// "minimax/minimax-m2.7".

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CATALOG_URL = process.env.C_AGENT_MODELS_URL || "https://models.dev/models.json";
const CATALOG_PATH = join(homedir(), ".c-agent", "models.dev.json");
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const FETCH_TIMEOUT_MS = 10_000;

interface CatalogEntry {
  id?: string;
  limit?: { context?: number; output?: number };
}
type Catalog = Record<string, CatalogEntry>;

// In-memory state, populated lazily from disk and refreshed by refreshCatalog().
let catalog: Catalog | null = null;
let contextIndex: Map<string, number> | null = null;

function buildIndex(data: Catalog): Map<string, number> {
  const index = new Map<string, number>();
  for (const [key, entry] of Object.entries(data)) {
    const ctx = entry?.limit?.context;
    if (typeof ctx !== "number" || ctx <= 0) continue;
    index.set(key, ctx);
    // First write wins for a bare id, so an ambiguous suffix keeps one value.
    const bare = key.slice(key.lastIndexOf("/") + 1);
    if (!index.has(bare)) index.set(bare, ctx);
  }
  return index;
}

function setCatalog(data: Catalog): void {
  catalog = data;
  contextIndex = buildIndex(data);
}

/** Load the disk cache once. Missing/corrupt cache => empty catalog (no lookups). */
function ensureLoaded(): void {
  if (catalog) return;
  try {
    const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    // Support both the wrapped cache shape ({ models }) and a raw models.json.
    setCatalog((raw && raw.models) || raw || {});
  } catch {
    setCatalog({});
  }
}

function cacheIsFresh(): boolean {
  try {
    return Date.now() - statSync(CATALOG_PATH).mtimeMs < CATALOG_TTL_MS;
  } catch {
    return false; // no cache yet
  }
}

/**
 * Context window (tokens) for a model id, or undefined if unknown. Reads the disk
 * cache on first call; callers fall back to their own default when undefined.
 */
export function modelContextLimit(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  ensureLoaded();
  const id = modelId.trim();
  return contextIndex!.get(id) ?? contextIndex!.get(id.slice(id.lastIndexOf("/") + 1));
}

/**
 * Refresh the catalog from models.dev if the cache is missing or older than the
 * 7-day TTL. Network/parse failures are swallowed — the stale (or empty) catalog
 * keeps working. On success the in-memory index updates immediately, so a session
 * that started before the fetch finished picks up real limits on the next lookup.
 * Call fire-and-forget at startup: `void refreshCatalog();`
 */
export async function refreshCatalog(force = false): Promise<void> {
  if (!force && cacheIsFresh()) {
    ensureLoaded();
    return;
  }
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return;
    const data = (await res.json()) as Catalog;
    if (!data || typeof data !== "object") return;
    mkdirSync(dirname(CATALOG_PATH), { recursive: true });
    writeFileSync(CATALOG_PATH, JSON.stringify({ fetchedAt: Date.now(), models: data }));
    setCatalog(data);
  } catch {
    ensureLoaded(); // network down — fall back to whatever is on disk
  }
}
