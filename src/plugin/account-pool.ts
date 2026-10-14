import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { AccountManager } from "./accounts";
import type { AntigravityConfig } from "./config";
import { createLogger } from "./logger";
import { createProactiveRefreshQueue, type ProactiveRefreshQueue } from "./refresh-queue";
import { initHealthTracker, initTokenTracker } from "./rotation";
import { getStoragePath } from "./storage";
import type { OAuthAuthDetails } from "./types";

const log = createLogger("account-pool");

/** A pool write is a burst of events (temp file, rename, lock file). */
const POOL_FILE_DEBOUNCE_MS = 250;

// ============================================================================
// Pool file watch
// ============================================================================

interface PoolFileWatch {
  watcher: FSWatcher | null;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}

const fileWatches = new Map<string, PoolFileWatch>();

function notifyListeners(entry: PoolFileWatch): void {
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch (error) {
      log.warn("Account pool change handler failed", { error: String(error) });
    }
  }
}

function startWatcher(path: string, entry: PoolFileWatch): FSWatcher | null {
  const file = basename(path);
  try {
    // The directory is watched, not the file: writes replace the file with a
    // rename, and the file may not exist yet.
    const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename && filename.toString() !== file) {
        return;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        notifyListeners(entry);
      }, POOL_FILE_DEBOUNCE_MS);
      entry.timer.unref?.();
    });
    watcher.on("error", (error) => {
      log.warn("Stopped watching the account pool file", { path, error: String(error) });
      watcher.close();
      if (entry.watcher === watcher) {
        entry.watcher = null;
      }
    });
    return watcher;
  } catch (error) {
    log.debug("Cannot watch the account pool file", { path, error: String(error) });
    return null;
  }
}

/**
 * Calls `listener` (debounced) when the pool file changes: the account manager
 * CLI added, signed in, disabled or deleted an account, or another process
 * saved. One watcher per file is shared by every listener in the process.
 * Returns the function that stops listening.
 */
export function watchAccountPoolFile(listener: () => void, path: string = getStoragePath()): () => void {
  let entry = fileWatches.get(path);
  if (!entry) {
    entry = { watcher: null, listeners: new Set() };
    entry.watcher = startWatcher(path, entry);
    fileWatches.set(path, entry);
  }
  entry.listeners.add(listener);
  const watched = entry;
  return () => {
    watched.listeners.delete(listener);
    if (watched.listeners.size > 0) {
      return;
    }
    if (watched.timer) {
      clearTimeout(watched.timer);
    }
    watched.watcher?.close();
    if (fileWatches.get(path) === watched) {
      fileWatches.delete(path);
    }
  };
}

// ============================================================================
// Shared account pool
// ============================================================================

interface SharedPool {
  manager: AccountManager;
  refreshQueue: ProactiveRefreshQueue | null;
  refs: number;
  closed: boolean;
  unwatch: () => void;
}

const pools = new Map<string, Promise<SharedPool>>();

export interface AccountPoolLease {
  readonly manager: AccountManager;
  /** Gives the lease back; the last one stops the pool and writes pending changes. */
  release(): Promise<void>;
}

async function createSharedPool(auth: OAuthAuthDetails, config: AntigravityConfig): Promise<SharedPool> {
  const manager = await AccountManager.loadFromDisk(auth);

  // Health scores and token buckets are keyed by this pool's account indices.
  initHealthTracker(config.health_score ? {
    initial: config.health_score.initial,
    successReward: config.health_score.success_reward,
    rateLimitPenalty: config.health_score.rate_limit_penalty,
    failurePenalty: config.health_score.failure_penalty,
    recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
    minUsable: config.health_score.min_usable,
    maxScore: config.health_score.max_score,
  } : {});
  initTokenTracker(config.token_bucket ? {
    maxTokens: config.token_bucket.max_tokens,
    regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
    initialTokens: config.token_bucket.initial_tokens,
  } : {});

  if (manager.getTotalAccountCount() > 0) {
    manager.requestSaveToDisk();
  }

  let refreshQueue: ProactiveRefreshQueue | null = null;
  if (config.proactive_token_refresh) {
    refreshQueue = createProactiveRefreshQueue({
      enabled: config.proactive_token_refresh,
      bufferSeconds: config.proactive_refresh_buffer_seconds,
      checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
    });
    refreshQueue.setAccountManager(manager);
    refreshQueue.start();
  }

  const unwatch = watchAccountPoolFile(() => {
    manager.syncFromDisk().catch((error) => {
      log.warn("Failed to read the changed account pool", { error: String(error) });
    });
  });

  return { manager, refreshQueue, refs: 0, closed: false, unwatch };
}

/**
 * The account pool of the pool file, shared by every route in this process.
 * OpenCode sets the plugin up once per project directory, and all of them use
 * the same Google accounts, whose quotas and rate limits are per account: one
 * project's 429 must steer the others away too.
 *
 * The first lease loads the pool (seeded from `auth` when the file does not
 * exist yet), starts the proactive token refresh and watches the file, so
 * accounts added or changed by the account manager CLI apply without a
 * restart. The last release stops both and writes pending changes. Settings
 * of the pool itself (token refresh, health scores) come from the config of
 * the first lease.
 */
export async function acquireAccountPool(auth: OAuthAuthDetails, config: AntigravityConfig): Promise<AccountPoolLease> {
  const path = getStoragePath();
  for (;;) {
    let entry = pools.get(path);
    const created = !entry;
    if (!entry) {
      const pending = createSharedPool(auth, config);
      entry = pending;
      pools.set(path, pending);
      pending.catch(() => {
        if (pools.get(path) === pending) {
          pools.delete(path);
        }
      });
    }
    const pool = await entry;
    if (pool.closed) {
      // Its last lease was released while this one waited.
      continue;
    }
    pool.refs += 1;
    if (!created) {
      // The watch keeps the pool current; this covers a missed or unavailable watch.
      await pool.manager.syncFromDisk().catch((error) => {
        log.warn("Failed to re-read the account pool", { error: String(error) });
      });
    }

    let released = false;
    return {
      manager: pool.manager,
      async release() {
        if (released) {
          return;
        }
        released = true;
        pool.refs -= 1;
        if (pool.refs > 0) {
          return;
        }
        pool.closed = true;
        if (pools.get(path) === entry) {
          pools.delete(path);
        }
        pool.unwatch();
        pool.refreshQueue?.stop();
        await pool.manager.dispose();
      },
    };
  }
}
