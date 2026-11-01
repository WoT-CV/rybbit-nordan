import { afterEach, describe, expect, it, vi } from "vitest";
import { getSourceCodeUrl } from "./sourceCodeUrl.js";

afterEach(() => vi.unstubAllEnvs());
describe("public fork source URL", () => {
  it("reads optional runtime configuration without an upstream fallback", () => {
    vi.stubEnv("SOURCE_CODE_URL", undefined);
    expect(getSourceCodeUrl()).toBeUndefined();
    vi.stubEnv("SOURCE_CODE_URL", "https://code.example.com/team/fork/tree/83f7e9e4");
    expect(getSourceCodeUrl()).toBe("https://code.example.com/team/fork/tree/83f7e9e4");
    vi.stubEnv("SOURCE_CODE_URL", "HTTPS://CODE.EXAMPLE.COM:443/team/fork");
    expect(getSourceCodeUrl()).toBe("https://code.example.com/team/fork");
  });
  it.each([
    null,
    3,
    {},
    "",
    "http://code.example.com/fork",
    "javascript:alert(1)",
    "//code.example.com/fork",
    "https:code.example.com/fork",
    "https://",
    "https://user:secret@code.example.com/fork",
    "https://code.example.com/fork?token=secret",
    "https://code.example.com/fork?",
    "https://code.example.com/fork#license",
    "https://code.example.com/fork#",
    " https://code.example.com/fork",
    "https://code.example.com/\nsecret",
    "https://code.example.com\\fork",
  ])("omits invalid input %j", value => {
    expect(getSourceCodeUrl(value)).toBeUndefined();
  });
  it("enforces the length bound before and after URL normalization", () => {
    const root = "https://code.example.com/";
    const atLimit = root + "a".repeat(2048 - root.length);
    expect(getSourceCodeUrl(atLimit)).toBe(atLimit);
    expect(getSourceCodeUrl(atLimit + "a")).toBeUndefined();
    expect(getSourceCodeUrl(root + "é".repeat(400))).toBeUndefined();
    expect(getSourceCodeUrl(root + "révision")).toBe(root + "r%C3%A9vision");
  });
});
