/**
 * Minimal Splitwise v3.0 REST client.
 * Workers can't run the Python `splitwise` library, so we talk to the
 * Splitwise HTTP API directly. Auth is a per-user OAuth access token in
 * Bearer mode — each user's token gives access to their own account only.
 *
 * Every endpoint from the Splitwise OpenAPI spec
 * (https://dev.splitwise.com) is covered. Payloads that carry indexed
 * participant arrays (`users__{N}__{field}`, the format the official
 * `splitwise` Python library uses) are form-encoded; simple objects are
 * sent as JSON.
 */

const BASE = "https://secure.splitwise.com/api/v3.0";

export interface SplitwiseProfile {
  id: number;
  first_name: string;
  last_name: string;
  email?: string;
  default_currency?: string;
  locale?: string;
}

export interface SplitwiseUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  balance?: number;
  paid_share?: string;
  owed_share?: string;
  net_balance?: string;
  registration_status?: string;
  balances?: { currency_code: string; amount: string }[];
}

// Responses from Splitwise wrap most collections in a top-level field.
interface GroupResponse {
  group: Record<string, any>;
}
interface GroupsResponse {
  groups: Record<string, any>[];
}
interface FriendsResponse {
  friends: Record<string, any>[];
}
interface ExpensesResponse {
  expenses: Record<string, any>[];
}
interface UserResponse {
  user: SplitwiseUser;
}

type QueryParams = Record<string, string | number | undefined>;

export class SplitwiseClient {
  constructor(private accessToken: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Splitwise API ${res.status}: ${JSON.stringify(body?.errors || body)}`
      );
    }
    return body as T;
  }

  private queryString(params: QueryParams): string {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) q.set(key, String(value));
    }
    return q.toString() ? `?${q}` : "";
  }

  private async postJson<T>(
    path: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * POST with form-encoding for payloads that carry indexed participant
   * arrays (e.g. `users__0__user_id`). Splitwise silently drops array
   * participants from JSON bodies on some endpoints, so indexed fields are
   * always serialized this way. Scalar/boolean values become strings.
   */
  private async postForm<T>(
    path: string,
    payload: Record<string, any>
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) continue; // handled below
      form.set(key, String(value));
    }
    for (const [key, value] of Object.entries(payload)) {
      if (!Array.isArray(value)) continue;
      value.forEach((item: Record<string, any>, i: number) => {
        for (const [k, v] of Object.entries(item)) {
          if (v === undefined || v === null) continue;
          form.set(`${key}__${i}__${k}`, String(v));
        }
      });
    }
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }

  /** Splitwise returns HTTP 200 with an `errors` object on validation failures. */
  private throwIfErrors(body: any): void {
    const errs = body?.errors;
    if (errs && Object.keys(errs).length > 0) {
      const msgs = Object.entries(errs).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((m) => `${k}: ${m}`)
      );
      throw new Error(`Splitwise API error: ${msgs.join("; ")}`);
    }
  }

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------

  async getCurrentUser(): Promise<SplitwiseUser> {
    const r = await this.request<UserResponse>("/get_current_user");
    return r.user;
  }

  async getUser(id: number): Promise<Record<string, any>> {
    const r = await this.request<{ user: Record<string, any> }>(
      `/get_user/${id}`
    );
    return r.user;
  }

  async updateUser(
    id: number,
    data: {
      first_name?: string;
      last_name?: string;
      email?: string;
      locale?: string;
      default_currency?: string;
    }
  ): Promise<Record<string, any>> {
    const r = await this.postJson<{ user: Record<string, any> }>(
      `/update_user/${id}`,
      data
    );
    return r.user ?? r;
  }

  // ------------------------------------------------------------------
  // Friends
  // ------------------------------------------------------------------

  async getFriends(): Promise<Record<string, any>[]> {
    const r = await this.request<FriendsResponse>("/get_friends");
    return r.friends || [];
  }

  async getFriend(id: number): Promise<Record<string, any>> {
    const r = await this.request<{ friend: Record<string, any> }>(
      `/get_friend/${id}`
    );
    return r.friend;
  }

  /** Invite a friend by email. Returns the (possibly pending) friend. */
  async createFriend(
    email: string,
    first_name?: string,
    last_name?: string
  ): Promise<Record<string, any>> {
    const payload: Record<string, unknown> = { user_email: email };
    if (first_name) payload.user_first_name = first_name;
    if (last_name) payload.user_last_name = last_name;
    const r = await this.postJson<{ friend: Record<string, any> }>(
      "/create_friend",
      payload
    );
    return r.friend;
  }

  /** Invite several friends at once. */
  async createFriends(
    users: { email: string; first_name?: string; last_name?: string }[]
  ): Promise<{ users: Record<string, any>[]; errors?: Record<string, any> }> {
    const r = await this.postForm<{
      users: Record<string, any>[];
      errors?: Record<string, any>;
    }>("/create_friends", { users });
    this.throwIfErrors(r);
    return r;
  }

  async deleteFriend(id: number): Promise<Record<string, any>> {
    const r = await this.postJson<Record<string, any>>(
      `/delete_friend/${id}`,
      {}
    );
    this.throwIfErrors(r);
    return r;
  }

  // ------------------------------------------------------------------
  // Groups
  // ------------------------------------------------------------------

  async getGroups(): Promise<Record<string, any>[]> {
    const r = await this.request<GroupsResponse>("/get_groups");
    return r.groups || [];
  }

  async getGroup(id: number): Promise<Record<string, any>> {
    const r = await this.request<GroupResponse>(`/get_group/${id}`);
    return r.group;
  }

  async createGroup(
    name: string,
    opts: { group_type?: string; simplify_by_default?: boolean },
    members: { user_id?: number; email?: string; first_name?: string; last_name?: string }[]
  ): Promise<Record<string, any>> {
    const payload: Record<string, any> = { name, users: members };
    if (opts.group_type) payload.group_type = opts.group_type;
    if (opts.simplify_by_default !== undefined) {
      payload.simplify_by_default = opts.simplify_by_default;
    }
    const r = await this.postForm<{ group: Record<string, any> }>(
      "/create_group",
      payload
    );
    this.throwIfErrors(r);
    return r.group;
  }

  async deleteGroup(id: number): Promise<Record<string, any>> {
    const r = await this.postJson<Record<string, any>>(
      `/delete_group/${id}`,
      {}
    );
    this.throwIfErrors(r);
    return r;
  }

  async undeleteGroup(id: number): Promise<Record<string, any>> {
    const r = await this.postJson<Record<string, any>>(
      `/undelete_group/${id}`,
      {}
    );
    this.throwIfErrors(r);
    return r;
  }

  /** Add a user to a group: by user_id, or by email/name (invite). */
  async addUserToGroup(payload: {
    group_id: number;
    user_id?: number;
    email?: string;
    first_name?: string;
    last_name?: string;
  }): Promise<Record<string, any>> {
    const r = await this.postJson<Record<string, any>>(
      "/add_user_to_group",
      payload
    );
    this.throwIfErrors(r);
    return r;
  }

  async removeUserFromGroup(
    group_id: number,
    user_id: number
  ): Promise<Record<string, any>> {
    const r = await this.postJson<Record<string, any>>(
      "/remove_user_from_group",
      { group_id, user_id }
    );
    this.throwIfErrors(r);
    return r;
  }

  // ------------------------------------------------------------------
  // Expenses
  // ------------------------------------------------------------------

  async getExpenses(params: {
    group_id?: number;
    friend_id?: number;
    dated_after?: string;
    dated_before?: string;
    updated_after?: string;
    updated_before?: string;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, any>[]> {
    const r = await this.request<ExpensesResponse>(
      `/get_expenses${this.queryString(params)}`
    );
    return r.expenses || [];
  }

  async getExpense(id: number): Promise<Record<string, any>> {
    const r = await this.request<{ expense: Record<string, any> }>(
      `/get_expense/${id}`
    );
    return r.expense;
  }

  async createExpense(payload: Record<string, any>): Promise<any> {
    const r = await this.postForm<{
      expenses?: any[];
      errors?: Record<string, any>;
    }>("/create_expense", payload);
    this.throwIfErrors(r);
    return (r.expenses && r.expenses[0]) || r;
  }

  async updateExpense(id: number, payload: Record<string, any>): Promise<any> {
    const r = await this.postForm<{
      expenses?: any[];
      errors?: Record<string, any>;
    }>(`/update_expense/${id}`, payload);
    this.throwIfErrors(r);
    return (r.expenses && r.expenses[0]) || r;
  }

  async deleteExpense(id: number): Promise<Record<string, any>> {
    const r = await this.postJson<Record<string, any>>(
      `/delete_expense/${id}`,
      {}
    );
    this.throwIfErrors(r);
    return r;
  }

  async undeleteExpense(id: number): Promise<Record<string, any>> {
    const r = await this.postJson<Record<string, any>>(
      `/undelete_expense/${id}`,
      {}
    );
    this.throwIfErrors(r);
    return r;
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  async getComments(expenseId: number): Promise<Record<string, any>[]> {
    const r = await this.request<{ comments: Record<string, any>[] }>(
      `/get_comments?expense_id=${expenseId}`
    );
    return r.comments || [];
  }

  async createComment(
    expenseId: number,
    content: string
  ): Promise<Record<string, any>> {
    const r = await this.postJson<{ comment: Record<string, any> }>(
      "/create_comment",
      { expense_id: expenseId, content }
    );
    this.throwIfErrors(r);
    return r.comment;
  }

  async deleteComment(id: number): Promise<Record<string, any>> {
    const r = await this.postJson<{ comment: Record<string, any> }>(
      `/delete_comment/${id}`,
      {}
    );
    this.throwIfErrors(r);
    return r.comment;
  }

  // ------------------------------------------------------------------
  // Misc / reference data
  // ------------------------------------------------------------------

  async getCategories(): Promise<Record<string, any>[]> {
    const r = await this.request<{ categories: Record<string, any>[] }>(
      "/get_categories"
    );
    return r.categories || [];
  }

  async getCurrencies(): Promise<Record<string, any>[]> {
    const r = await this.request<{ currencies: Record<string, any>[] }>(
      "/get_currencies"
    );
    return r.currencies || [];
  }

  async getNotifications(params: {
    updated_after?: string;
    limit?: number;
  }): Promise<Record<string, any>[]> {
    const r = await this.request<{ notifications: Record<string, any>[] }>(
      `/get_notifications${this.queryString(params)}`
    );
    return r.notifications || [];
  }
}
