import { describe, expect, it } from "vitest";
import { generateName } from "./generateName";
import { getUserDisplayName } from "./utils";

describe("native visitor display names", () => {
  it("retains username, name, email, identified ID precedence", () => {
    expect(
      getUserDisplayName({
        user_id: "device",
        identified_user_id: "player",
        traits: { username: "[TAG] Player", name: "Name", email: "user@example.test" },
      })
    ).toBe("[TAG] Player");
    expect(
      getUserDisplayName({ identified_user_id: "player", traits: { name: "Name", email: "user@example.test" } })
    ).toBe("Name");
    expect(getUserDisplayName({ identified_user_id: "player", traits: { email: "user@example.test" } })).toBe(
      "user@example.test"
    );
    expect(getUserDisplayName({ identified_user_id: "000123", traits: null })).toBe("000123");
  });

  it.each([{}, [], 42, false, "  ", null])("ignores malformed or empty first field %j", username => {
    expect(getUserDisplayName({ identified_user_id: "player", traits: { username, name: "[TAG] Player" } })).toBe(
      "[TAG] Player"
    );
  });

  it("does not render malformed profile values as objects, zero or undefined", () => {
    expect(getUserDisplayName({ identified_user_id: "000123", traits: { username: {}, name: [], email: 0 } })).toBe(
      "000123"
    );
    expect(
      getUserDisplayName({ user_id: "device", identified_user_id: "", traits: { username: {}, name: [], email: 0 } })
    ).toBe(generateName("device"));
  });
});
