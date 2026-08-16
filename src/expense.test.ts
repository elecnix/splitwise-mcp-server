import { describe, expect, it } from "vitest";
import {
  buildCreateExpensePayload,
  buildExpenseUsers,
  type CreateExpenseArgs,
} from "./expense";

const ME = 11443411;

function args(overrides: Partial<CreateExpenseArgs> = {}): CreateExpenseArgs {
  return {
    description: "Test expense",
    cost: 10.0,
    currency_code: "CAD",
    split_equally: true,
    payment: false,
    ...overrides,
  };
}

describe("buildExpenseUsers", () => {
  it("splits equally to the cent with the remainder on the last participant", () => {
    const users = buildExpenseUsers(args({ cost: 10.0, friend_ids: [1, 2] }), ME);
    expect(users).toEqual([
      { user_id: ME, paid_share: "10", owed_share: "3.33" },
      { user_id: 1, paid_share: "0.00", owed_share: "3.33" },
      { user_id: 2, paid_share: "0.00", owed_share: "3.34" },
    ]);
    // Owed shares always add up to the cost.
    const sum = users.reduce((acc, u) => acc + Number(u.owed_share), 0);
    expect(sum).toBeCloseTo(10.0, 2);
  });

  it("splits evenly when the cost divides cleanly", () => {
    const users = buildExpenseUsers(args({ cost: 12.0, friend_ids: [1, 2] }), ME);
    expect(users.map((u) => u.owed_share)).toEqual(["4.00", "4.00", "4.00"]);
  });

  it("creates a solo personal expense with no group or friends (owed = paid)", () => {
    const users = buildExpenseUsers(args({ cost: 2.5 }), ME);
    expect(users).toEqual([
      { user_id: ME, paid_share: "2.5", owed_share: "2.5" },
    ]);
  });

  it("uses explicit shares verbatim", () => {
    const users = buildExpenseUsers(
      args({
        cost: 25.0,
        shares: [
          { user_id: ME, paid_share: "25.00", owed_share: "10.00" },
          { user_id: 7, paid_share: "0.00", owed_share: "15.00" },
        ],
      }),
      ME
    );
    expect(users).toEqual([
      { user_id: ME, paid_share: "25.00", owed_share: "10.00" },
      { user_id: 7, paid_share: "0.00", owed_share: "15.00" },
    ]);
  });

  it("rejects shares that omit the current user", () => {
    expect(() =>
      buildExpenseUsers(
        args({
          shares: [{ user_id: 7, paid_share: "0.00", owed_share: "10.00" }],
        }),
        ME
      )
    ).toThrow(/must include the current user/);
  });

  it("rejects split_equally=false without shares", () => {
    expect(() =>
      buildExpenseUsers(args({ split_equally: false, friend_ids: [1] }), ME)
    ).toThrow(/requires the 'shares' parameter/);
  });

  it("handles a 1-cent expense split two ways without a negative remainder", () => {
    const users = buildExpenseUsers(args({ cost: 0.01, friend_ids: [1] }), ME);
    const sum = users.reduce((acc, u) => acc + Number(u.owed_share), 0);
    expect(sum).toBeCloseTo(0.01, 2);
    expect(users.every((u) => Number(u.owed_share) >= 0)).toBe(true);
  });
});

describe("buildCreateExpensePayload", () => {
  it("includes group_id 0 (non-grouped pseudo-group) in the payload", () => {
    const payload = buildCreateExpensePayload(args({ group_id: 0 }), ME);
    expect(payload.group_id).toBe(0);
  });

  it("omits group_id when not provided", () => {
    const payload = buildCreateExpensePayload(args(), ME);
    expect("group_id" in payload).toBe(false);
  });

  it("keeps a positive group_id", () => {
    const payload = buildCreateExpensePayload(args({ group_id: 42 }), ME);
    expect(payload.group_id).toBe(42);
  });

  it("passes through details and date when provided", () => {
    const payload = buildCreateExpensePayload(
      args({ details: "dinner", date: "2026-08-16" }),
      ME
    );
    expect(payload.details).toBe("dinner");
    expect(payload.date).toBe("2026-08-16");
  });

  it("stringifies cost and keeps split_equally as a string flag", () => {
    const payload = buildCreateExpensePayload(args({ cost: 3.75 }), ME);
    expect(payload.cost).toBe("3.75");
    expect(payload.split_equally).toBe("true");
  });
});
