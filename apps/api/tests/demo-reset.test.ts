import { afterEach, describe, expect, it } from "vitest";
import { assertSafeToReset, DEMO_SLUG } from "../src/demo-reset.js";

/**
 * `assertSafeToReset` is the hard guard `main` calls before deleting an
 * organization and everything cascaded under it. `main` itself only runs
 * when demo-reset.ts is executed directly (see the isDirectRun check at the
 * bottom of that file), so it is not exercised by importing the module in a
 * test — same convention as seed-golden.test.ts's `assertNotProduction`
 * suite. This tests the guard function itself, behaviorally.
 */
describe("assertSafeToReset", () => {
  afterEach(() => {
    delete process.env.DEMO_RESET_CONFIRM;
  });

  it("throws when NODE_ENV is production", () => {
    expect(() => assertSafeToReset("production", DEMO_SLUG)).toThrow(/development\/test/);
  });

  it("throws for a staging-style NODE_ENV that a production-only denylist would miss", () => {
    // The whole point of this gate over the shared assertNotProduction
    // denylist: a value that is neither "production" nor an allowed value
    // must still be refused, not waved through because it isn't literally
    // "production".
    expect(() => assertSafeToReset("staging", DEMO_SLUG)).toThrow(/development\/test/);
  });

  it("does not throw for development against the demo slug", () => {
    expect(() => assertSafeToReset("development", DEMO_SLUG)).not.toThrow();
  });

  it("does not throw for test against the demo slug", () => {
    expect(() => assertSafeToReset("test", DEMO_SLUG)).not.toThrow();
  });

  it("throws when the target slug is not the demo slug", () => {
    expect(() => assertSafeToReset("development", "some-real-tenant")).toThrow(
      /some-real-tenant/,
    );
  });

  it("does not throw for a non-demo slug when DEMO_RESET_CONFIRM matches it exactly", () => {
    process.env.DEMO_RESET_CONFIRM = "a-different-demo-workspace";
    expect(() => assertSafeToReset("development", "a-different-demo-workspace")).not.toThrow();
  });

  it("still throws for a non-demo slug when DEMO_RESET_CONFIRM names a different slug", () => {
    process.env.DEMO_RESET_CONFIRM = "a-different-demo-workspace";
    expect(() => assertSafeToReset("development", "some-real-tenant")).toThrow(/some-real-tenant/);
  });

  it("checks NODE_ENV before the slug, so a bad slug cannot mask a bad environment", () => {
    expect(() => assertSafeToReset("production", "some-real-tenant")).toThrow(/development\/test/);
  });
});
