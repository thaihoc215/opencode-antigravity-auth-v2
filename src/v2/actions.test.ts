import { describe, expect, it } from "vitest";
import {
  ACTION_KEY,
  ADD_ACTION,
  assertSameAccount,
  buildActionField,
  parseLoginAction,
  resolveReauthIndex,
  summarizeAccounts,
} from "./actions";

const pool = [
  { email: "a@example.com", refreshToken: "r1", enabled: true },
  { email: "b@example.com", refreshToken: "r2", enabled: false },
  { refreshToken: "r3", verificationRequired: true },
];

describe("summarizeAccounts", () => {
  it("keeps index, email and the flags shown in the form", () => {
    expect(summarizeAccounts(pool)).toEqual([
      { index: 0, email: "a@example.com", enabled: true, verificationRequired: false, revoked: false },
      { index: 1, email: "b@example.com", enabled: false, verificationRequired: false, revoked: false },
      { index: 2, email: undefined, enabled: true, verificationRequired: true, revoked: false },
    ]);
  });
});

describe("buildActionField", () => {
  const cli = 'bun "/plugin/src/v2/cli.ts"';

  it("offers add first, then one re-authenticate option per account", () => {
    const field = buildActionField(summarizeAccounts(pool), cli);
    expect(field).toMatchObject({ key: ACTION_KEY, type: "string", required: true, default: ADD_ACTION });
    expect(field.options).toEqual([
      { value: "add", label: "Add a new account", description: "3 accounts in the pool" },
      { value: "reauth:0", label: "Re-authenticate a@example.com", description: "Account 1" },
      { value: "reauth:1", label: "Re-authenticate b@example.com", description: "Account 2 · disabled" },
      { value: "reauth:2", label: "Re-authenticate account 3", description: "Account 3 · verification required" },
    ]);
  });

  it("tells which accounts Google signed out", () => {
    const field = buildActionField(
      summarizeAccounts([{ email: "a@example.com", enabled: false, revokedAt: 1 }]),
      cli,
    );
    expect(field.options[1]).toEqual({
      value: "reauth:0",
      label: "Re-authenticate a@example.com",
      description: "Account 1 · signed out by Google - sign in again",
    });
  });

  it("points at the account manager CLI for everything the form cannot do", () => {
    const field = buildActionField([], cli);
    expect(field.description).toContain(cli);
    expect(field.description).toMatch(/delete/i);
    expect(field.description).toMatch(/quota/i);
    expect(field.options).toEqual([{ value: "add", label: "Add a new account", description: "No accounts yet" }]);
  });
});

describe("parseLoginAction", () => {
  const accounts = summarizeAccounts(pool);

  it("defaults to adding an account", () => {
    expect(parseLoginAction({}, accounts)).toEqual({ type: "add" });
    expect(parseLoginAction({ action: "add" }, accounts)).toEqual({ type: "add" });
  });

  it("resolves a re-authenticate choice to the account it was built from", () => {
    expect(parseLoginAction({ action: "reauth:1" }, accounts)).toEqual({
      type: "reauth",
      index: 1,
      email: "b@example.com",
    });
  });

  it("rejects an unknown choice", () => {
    expect(() => parseLoginAction({ action: "reauth:9" }, accounts)).toThrow(/Unknown action/);
    expect(() => parseLoginAction({ action: "delete" }, accounts)).toThrow(/Unknown action/);
  });
});

describe("resolveReauthIndex", () => {
  it("finds the account by email even after the pool was reordered", () => {
    const reordered = [pool[1]!, pool[0]!];
    expect(resolveReauthIndex(reordered, { type: "reauth", index: 0, email: "A@example.com" })).toBe(1);
  });

  it("returns undefined when the selected account was removed", () => {
    expect(resolveReauthIndex([pool[1]!], { type: "reauth", index: 0, email: "a@example.com" })).toBeUndefined();
  });

  it("falls back to the index for accounts without an email", () => {
    expect(resolveReauthIndex(pool, { type: "reauth", index: 2 })).toBe(2);
    expect(resolveReauthIndex(pool.slice(0, 2), { type: "reauth", index: 2 })).toBeUndefined();
  });
});

describe("assertSameAccount", () => {
  it("accepts the same account, ignoring case", () => {
    expect(() => assertSameAccount("a@example.com", "A@Example.com")).not.toThrow();
  });

  it("accepts sign-ins where either email is unknown", () => {
    expect(() => assertSameAccount(undefined, "a@example.com")).not.toThrow();
    expect(() => assertSameAccount("a@example.com", undefined)).not.toThrow();
  });

  it("rejects a different Google account and says nothing was changed", () => {
    expect(() => assertSameAccount("a@example.com", "c@example.com")).toThrow(
      "Signed in as c@example.com, but a@example.com was selected. Nothing was changed.",
    );
  });
});
