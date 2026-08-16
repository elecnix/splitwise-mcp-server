/**
 * Pure helpers for building Splitwise create/update expense payloads.
 *
 * Kept free of MCP/SDK imports so the share math is unit-testable offline.
 * See splitwise.ts for the wire format: Splitwise's create_expense endpoint
 * expects FORM-ENCODED fields with participant shares in the legacy
 * `users__N__<field>` key format.
 */

export interface ExpenseShare {
  /** Identify a participant by existing Splitwise user id… */
  user_id?: number;
  /** …or by email + optional names (Splitwise invites unknown emails). */
  email?: string;
  first_name?: string;
  last_name?: string;
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
  category_id?: number;
  shares?: ExpenseShare[];
}

export interface UpdateExpenseArgs {
  description?: string;
  cost?: number;
  currency_code?: string;
  group_id?: number;
  friend_ids?: number[];
  split_equally?: boolean;
  payment?: boolean;
  details?: string;
  date?: string;
  category_id?: number;
  shares?: ExpenseShare[];
}

export interface ExpenseUser {
  user_id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  paid_share: string;
  owed_share: string;
}

export interface CreateExpensePayload {
  description?: string;
  cost?: string;
  currency_code?: string;
  payment?: boolean;
  split_equally?: string;
  users?: ExpenseUser[];
  group_id?: number;
  details?: string;
  date?: string;
  category_id?: number;
}

/**
 * Decide who pays/owes what for a create_expense / update_expense call.
 *
 * - `shares` provided: used verbatim (Splitwise validates that the owed
 *   shares add up to the cost). Each entry must identify a participant by
 *   `user_id` or `email`; the current user must be included (by user_id).
 * - `friend_ids` + equal split: equal split with the exact cent remainder on
 *   the last participant, so the owed shares always add up to the cost.
 * - `friend_ids` + `split_equally=false` without `shares`: rejected with a
 *   clear error (previously produced a payload Splitwise always refused).
 * - A real group (`group_id > 0`) + equal split with no friends/shares:
 *   returns an empty array — the caller then omits `users` entirely and
 *   Splitwise auto-splits equally among all group members (its
 *   `equal_group_split` form).
 * - No friends, shares, or split group: a solo personal expense. Splitwise
 *   requires the sum of owed shares to equal the cost, so the user owes the
 *   full amount to themselves (paid = owed).
 */
export function buildExpenseUsers(
  args: CreateExpenseArgs | UpdateExpenseArgs,
  currentUserId: number
): ExpenseUser[] {
  const cost = String(args.cost);

  if (args.shares && args.shares.length > 0) {
    const users = args.shares.map((s) => {
      if (s.user_id === undefined && !s.email) {
        throw new Error("Each 'shares' entry must provide 'user_id' or 'email'.");
      }
      const u: ExpenseUser = {
        paid_share: String(s.paid_share),
        owed_share: String(s.owed_share),
      };
      if (s.user_id !== undefined) u.user_id = s.user_id;
      if (s.email) u.email = s.email;
      if (s.first_name) u.first_name = s.first_name;
      if (s.last_name) u.last_name = s.last_name;
      return u;
    });
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
          "(array of { user_id|email, paid_share, owed_share })."
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

  // A real group with an equal split and no explicit participants: let
  // Splitwise split among all group members (no `users` array in the payload).
  if (
    args.group_id !== undefined &&
    args.group_id > 0 &&
    args.split_equally !== false
  ) {
    return [];
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
  };
  if (args.group_id !== undefined) payload.group_id = args.group_id;
  const users = buildExpenseUsers(args, currentUserId);
  if (users.length > 0) payload.users = users;
  if (args.details) payload.details = args.details;
  if (args.date) payload.date = args.date;
  if (args.category_id !== undefined) payload.category_id = args.category_id;
  return payload;
}

/**
 * Build an update_expense payload: only fields the caller provided are
 * included, and `users` is only set when participants were explicitly given
 * (updating an expense must not silently overwrite its members).
 */
export function buildUpdateExpensePayload(
  args: UpdateExpenseArgs,
  currentUserId: number
): CreateExpensePayload {
  const payload: CreateExpensePayload = {};
  if (args.description !== undefined) payload.description = args.description;
  if (args.cost !== undefined) payload.cost = String(args.cost);
  if (args.currency_code !== undefined) payload.currency_code = args.currency_code;
  if (args.payment !== undefined) payload.payment = args.payment;
  if (args.group_id !== undefined) payload.group_id = args.group_id;
  if (args.details !== undefined) payload.details = args.details;
  if (args.date !== undefined) payload.date = args.date;
  if (args.category_id !== undefined) payload.category_id = args.category_id;

  // Note: Splitwise's update_expense (by_shares form) rejects `split_equally`;
  // it only accepts explicit `users__N__*` shares.
  const hasParticipants =
    (args.shares && args.shares.length > 0) ||
    (args.friend_ids && args.friend_ids.length > 0);
  if (args.cost !== undefined && !hasParticipants) {
    throw new Error(
      "Changing 'cost' on an existing expense requires 'shares' (or 'friend_ids') " +
        "so Splitwise can re-split the participants."
    );
  }
  if (hasParticipants) {
    const users = buildExpenseUsers(args, currentUserId);
    if (users.length > 0) payload.users = users;
  }
  return payload;
}
