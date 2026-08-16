/**
 * Pure helpers for building Splitwise create_expense payloads.
 *
 * Kept free of MCP/SDK imports so the share math is unit-testable offline.
 * See splitwise.ts for the wire format: Splitwise's create_expense endpoint
 * expects FORM-ENCODED fields with participant shares in the legacy
 * `users__N__<field>` key format.
 */

export interface ExpenseShare {
  user_id: number;
  paid_share: number | string;
  owed_share: number | string;
}

export interface CreateExpenseArgs {
  description: string;
  cost: number;
  currency_code: string;
  group_id?: number;
  friend_ids?: number[];
  split_equally: boolean;
  payment: boolean;
  details?: string;
  date?: string;
  shares?: ExpenseShare[];
}

export interface ExpenseUser {
  user_id: number;
  paid_share: string;
  owed_share: string;
}

export interface CreateExpensePayload {
  description: string;
  cost: string;
  currency_code: string;
  payment: boolean;
  split_equally: string;
  users: ExpenseUser[];
  group_id?: number;
  details?: string;
  date?: string;
}

/**
 * Decide who pays/owes what for a create_expense call.
 *
 * - `shares` provided: used verbatim (Splitwise validates that the owed
 *   shares add up to the cost). The current user must be among them.
 * - `friend_ids` + equal split: equal split with the exact cent remainder on
 *   the last participant, so the owed shares always add up to the cost.
 * - `friend_ids` + `split_equally=false` without `shares`: rejected with a
 *   clear error (previously produced a payload Splitwise always refused).
 * - No friends and no shares: a solo personal expense. Splitwise requires the
 *   sum of owed shares to equal the cost, so the user owes the full amount to
 *   themselves (paid = owed).
 */
export function buildExpenseUsers(
  args: CreateExpenseArgs,
  currentUserId: number
): ExpenseUser[] {
  const cost = String(args.cost);

  if (args.shares && args.shares.length > 0) {
    const users = args.shares.map((s) => ({
      user_id: s.user_id,
      paid_share: String(s.paid_share),
      owed_share: String(s.owed_share),
    }));
    if (!users.some((u) => u.user_id === currentUserId)) {
      throw new Error(
        `The 'shares' array must include the current user (user_id ${currentUserId}).`
      );
    }
    return users;
  }

  const participantIds = args.friend_ids ?? [];
  if (participantIds.length > 0) {
    if (!args.split_equally) {
      throw new Error(
        "split_equally=false requires the 'shares' parameter " +
          "(array of { user_id, paid_share, owed_share })."
      );
    }
    const n = participantIds.length + 1;
    const shareCents = Math.round((Number(cost) * 100) / n);
    const share = (shareCents / 100).toFixed(2);
    // Exact remainder on the last participant so the cost adds up to the cent.
    const remainder = (Number(cost) - (shareCents * (n - 1)) / 100).toFixed(2);
    return [
      { user_id: currentUserId, paid_share: cost, owed_share: share },
      ...participantIds.map((uid, i) => ({
        user_id: uid,
        paid_share: "0.00",
        owed_share: i === participantIds.length - 1 ? remainder : share,
      })),
    ];
  }

  // Solo personal expense (no group required).
  return [{ user_id: currentUserId, paid_share: cost, owed_share: cost }];
}

/**
 * Build the full create_expense payload. `group_id` is included when
 * explicitly provided — including 0, Splitwise's id for the "non-grouped"
 * pseudo-group (it must not be dropped by a truthiness check).
 */
export function buildCreateExpensePayload(
  args: CreateExpenseArgs,
  currentUserId: number
): CreateExpensePayload {
  const payload: CreateExpensePayload = {
    description: args.description,
    cost: String(args.cost),
    currency_code: args.currency_code,
    payment: args.payment,
    split_equally: args.split_equally ? "true" : "false",
    users: buildExpenseUsers(args, currentUserId),
  };
  if (args.group_id !== undefined) payload.group_id = args.group_id;
  if (args.details) payload.details = args.details;
  if (args.date) payload.date = args.date;
  return payload;
}
