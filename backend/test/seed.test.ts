import { describe, expect, it } from "vitest";
import { checkPassword } from "../src/auth/seed.js";

describe("checkPassword", () => {
  const email = "riyad@riyadtech.xyz";
  it("accepts a long, unusual password", () => {
    expect(checkPassword("plum-orbit-lantern-47", email)).toEqual([]);
  });
  it("rejects short, guessable or e-mail-based passwords", () => {
    expect(checkPassword("short1", email).join()).toMatch(/12 characters/);
    expect(checkPassword("password12345", email).join()).toMatch(/easy to guess/);
    expect(checkPassword("riyad-is-great-2026", email).join()).toMatch(/e-mail name/);
    expect(checkPassword("aaaaaaaaaaaaaa", email).join()).toMatch(/repeated/);
    expect(checkPassword(" leading-space-pass", email).join()).toMatch(/space/);
  });
});
