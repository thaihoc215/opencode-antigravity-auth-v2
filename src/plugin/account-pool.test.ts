import { afterEach, describe, expect, it } from "vitest";

import { acquireAccountPool, watchAccountPoolFile, type AccountPoolLease } from "./account-pool";
import { DEFAULT_CONFIG } from "./config";
import { saveAccounts, type AccountStorageV4 } from "./storage";
import type { OAuthAuthDetails } from "./types";

// vitest.setup.ts points the config directory at a temporary folder, so these
// tests read and write a real pool file there.

const auth: OAuthAuthDetails = { type: "oauth", refresh: "r1|p1", access: "a1", expires: Date.now() + 3_600_000 };
const config = { ...DEFAULT_CONFIG, proactive_token_refresh: false };

function pool(...emails: string[]): AccountStorageV4 {
  return {
    version: 4,
    accounts: emails.map((email, index) => ({
      email,
      refreshToken: `r${index + 1}`,
      projectId: `p${index + 1}`,
      addedAt: index + 1,
      lastUsed: 0,
    })),
    activeIndex: 0,
  };
}

const leases: AccountPoolLease[] = [];
async function acquire(): Promise<AccountPoolLease> {
  const lease = await acquireAccountPool(auth, config);
  leases.push(lease);
  return lease;
}

afterEach(async () => {
  for (const lease of leases.splice(0)) {
    await lease.release();
  }
});

describe("acquireAccountPool", () => {
  it("gives every lease in the process the same pool", async () => {
    await saveAccounts(pool("a@example.com", "b@example.com"));

    const first = await acquire();
    const second = await acquire();

    expect(second.manager).toBe(first.manager);
    expect(first.manager.getAccounts().map((account) => account.email)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("keeps the pool while a lease is held and loads it again after the last release", async () => {
    await saveAccounts(pool("a@example.com"));

    const first = await acquire();
    const second = await acquire();
    await first.release();
    const third = await acquire();
    expect(third.manager).toBe(second.manager);

    await second.release();
    await third.release();
    const fresh = await acquire();
    expect(fresh.manager).not.toBe(second.manager);
  });

  it("applies accounts the account manager CLI adds to the file", async () => {
    await saveAccounts(pool("a@example.com"));
    const lease = await acquire();

    await saveAccounts(pool("a@example.com", "b@example.com"));

    await expect.poll(
      () => lease.manager.getAccounts().map((account) => account.email),
      { timeout: 5_000 },
    ).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("watchAccountPoolFile", () => {
  it("notifies listeners once a write settles and stops after unsubscribe", async () => {
    await saveAccounts(pool("a@example.com"));
    let calls = 0;
    const stop = watchAccountPoolFile(() => {
      calls += 1;
    });

    try {
      await saveAccounts(pool("a@example.com", "b@example.com"));
      await expect.poll(() => calls, { timeout: 5_000 }).toBeGreaterThan(0);
    } finally {
      stop();
    }

    const afterStop = calls;
    await saveAccounts(pool("a@example.com", "b@example.com", "c@example.com"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(calls).toBe(afterStop);
  });
});
