import { describe, expect, it } from "vitest";
import {
  buildCreateExpensePayload,
  buildExpenseUsers,
  buildUpdateExpensePayload,
  type CreateExpenseArgs,
  type UpdateExpenseArgs,
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

function uargs(overrides: Partial<UpdateExpenseArgs> = {}): UpdateExpenseArgs {
  return { ...overrides };
}

describe("buildExpenseUsers", () => {
  it("splits equally to the cent with the remainder on the last participant", () => {
    const users = buildExpenseUsers(args({ cost: 10.0, friend_ids: [1, 2] }), ME);
    expect(users).toEqual([
      { user_id: ME, paid_share: "10", owed_share: "3.33" },
      { user_id: 1, paid_share: "0.00", owed_share: "3.33" },
      { user_id: 2, paid_share: "0.00", owed_share: "3.34" },
    ]);
    const sum = users.reduce((acc, u) => acc + Number(u.owed_share), 0);
    expect(sum).toBeCloseTo(10.0, 2);
  });

  it("splits evenly when the cost divides cleanly", () => {
    const users = buildExpenseUsers(args({ cost: 12.0, friend_ids: [1, 2] }), ME);
    expect(users.map((u) => u.owed_share)).toEqual(["4.00", "4.00", "4.00"]);
  });

  it("creates a solo personal expense with no group or friends (owed = paid)", () => {
    const users = buildExpenseUsers(args({ cost: 2.5 }), ME);
    expect(users).toEqual([{ user_id: ME, paid_share: "2.5", owed_share: "2.5" }]);
  });

  it("returns empty array for a real group with equal split (no users = auto-split)", () => {
    const users = buildExpenseUsers(args({ cost: 10.0, group_id: 5 }), ME);
    expect(users).toEqual([]);
  });

  it("creates solo personal when group_id=0 with equal split (no members)", () => {
    const users = buildExpenseUsers(args({ cost: 10.0, group_id: 0 }), ME);
    expect(users).toEqual([{ user_id: ME, paid_share: "10", owed_share: "10" }]);
  });

  it("uses explicit shares verbatim (user_id)", () => {
    const users = buildExpenseUsers(
      args({
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

  it("supports shares with email entries", () => {
    const users = buildExpenseUsers(
      args({
        shares: [
          { user_id: ME, paid_share: "10.00", owed_share: "5.00" },
          { email: "new@example.com", first_name: "New", last_name: "User", paid_share: "0.00", owed_share: "5.00" },
        ],
      }),
      ME
    );
    expect(users).toEqual([
      { user_id: ME, paid_share: "10.00", owed_share: "5.00" },
      { email: "new@example.com", first_name: "New", last_name: "User", paid_share: "0.00", owed_share: "5.00" },
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

  it("rejects a share entry without user_id or email", () => {
    expect(() => {
      buildExpenseUsers(
        args({
          shares: [
            { user_id: ME, paid_share: "5", owed_share: "5" },
            { paid_share: "0", owed_share: "5" } as any,
          ],
        }),
        ME
      );
    }).toThrow(/must provide 'user_id' or 'email'/);
  });

  it("handles a 1-cent expense split two ways without a negative remainder", () => {
    const users = buildExpenseUsers(args({ cost: 0.01, friend_ids: [1] }), ME);
    expect(users.every((u) => Number(u.owed_share) >= 0)).toBe(true);
    expect(users.reduce((acc, u) => acc + Number(u.owed_share), 0)).toBeCloseTo(0.01, 2);
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

  it("keeps a positive group_id and omits users for equal split in a real group", () => {
    const payload = buildCreateExpensePayload(args({ group_id: 42 }), ME);
    expect(payload.group_id).toBe(42);
    expect("users" in payload).toBe(false);
  });

  it("passes through details, date, and category_id when provided", () => {
    const payload = buildCreateExpensePayload(
      args({ details: "dinner", date: "2026-08-16", category_id: 5 }),
      ME
    );
    expect(payload.details).toBe("dinner");
    expect(payload.date).toBe("2026-08-16");
    expect(payload.category_id).toBe(5);
  });

  it("stringifies cost and keeps split_equally as a string flag", () => {
    const payload = buildCreateExpensePayload(args({ cost: 3.75 }), ME);
    expect(payload.cost).toBe("3.75");
    expect(payload.split_equally).toBe("true");
  });
});

describe("buildUpdateExpensePayload", () => {
  it("only includes fields that were provided", () => {
    const payload = buildUpdateExpensePayload(
      uargs({ description: "Updated", date: "2026-08-16" }),
      ME
    );
    expect(payload.description).toBe("Updated");
    expect(payload.date).toBe("2026-08-16");
    expect(payload.cost).toBeUndefined();
    expect(payload.currency_code).toBeUndefined();
    expect(payload.users).toBeUndefined();
  });

  it("includes users when shares are provided", () => {
    const payload = buildUpdateExpensePayload(
      uargs({ shares: [{ user_id: ME, paid_share: "10", owed_share: "10" }] }),
      ME
    );
    expect(payload.users).toBeDefined();
    expect(payload.users).toHaveLength(1);
  });

  it("includes group_id when provided", () => {
    const payload = buildUpdateExpensePayload(
      uargs({ group_id: 42 }),
      ME
    );
    expect(payload.group_id).toBe(42);
  });

  it("rejects a cost change without participants", () => {
    expect(() =>
      buildUpdateExpensePayload(uargs({ cost: 15 }), ME)
    ).toThrow(/Changing 'cost'.*requires 'shares'/);
  });

  it("allows a cost change when shares are provided", () => {
    const payload = buildUpdateExpensePayload(
      uargs({
        cost: 15,
        shares: [{ user_id: ME, paid_share: "15", owed_share: "15" }],
      }),
      ME
    );
    expect(payload.cost).toBe("15");
    expect(payload.users).toHaveLength(1);
  });
});