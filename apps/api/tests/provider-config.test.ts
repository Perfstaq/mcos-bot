import { describe, expect, it } from "vitest";

/**
 * A provider that is "configured" with a placeholder is worse than one that is
 * unconfigured: the button renders, the user clicks it, and Google answers with
 * `invalid_client` — an error that points at their OAuth setup rather than at
 * our unset secret. This happened in production.
 */
describe("provider configuration detection", () => {
  const PLACEHOLDER = /^(replace[-_ ]?me|changeme|todo|placeholder|dev-placeholder|xxx+|<.*>)/i;
  const configured = (...parts: (string | undefined)[]): boolean =>
    parts.every((v) => Boolean(v) && !PLACEHOLDER.test(v!.trim()));

  it("accepts a real credential pair", () => {
    expect(configured("633586331485-abc.apps.googleusercontent.com", "GOCSPX-realsecret")).toBe(true);
  });

  it("rejects the placeholders infrastructure actually writes", () => {
    for (const p of ["REPLACE_ME", "replace-me", "CHANGEME", "TODO", "placeholder", "dev-placeholder-key", "xxxxx", "<your-client-id>"]) {
      expect(configured(p, "GOCSPX-realsecret")).toBe(false);
      expect(configured("real-looking-id", p)).toBe(false);
    }
  });

  it("rejects empty and whitespace", () => {
    expect(configured("", "secret")).toBe(false);
    expect(configured(undefined, "secret")).toBe(false);
    expect(configured("  REPLACE_ME  ", "secret")).toBe(false);
  });

  it("requires both halves", () => {
    expect(configured("id-only", undefined)).toBe(false);
  });
});
