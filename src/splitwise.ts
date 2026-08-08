/**
 * Minimal Splitwise v3.0 REST client.
 * Workers can't run the Python `splitwise` library, so we talk to the
 * Splitwise HTTP API directly. Auth is a per-user OAuth access token in
 * Bearer mode — each user's token gives access to their own account only.
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

  async getCurrentUser(): Promise<SplitwiseUser> {
    const r = await this.request<UserResponse>("/get_current_user");
    return r.user;
  }

  async getGroups(): Promise<Record<string, any>[]> {
    const r = await this.request<GroupsResponse>("/get_groups");
    return r.groups || [];
  }

  async getFriends(): Promise<Record<string, any>[]> {
    const r = await this.request<FriendsResponse>("/get_friends");
    return r.friends || [];
  }

  async getExpenses(params: {
    group_id?: number;
    friend_id?: number;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, any>[]> {
    const q = new URLSearchParams();
    if (params.group_id) q.set("group_id", String(params.group_id));
    if (params.friend_id) q.set("friend_id", String(params.friend_id));
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    const r = await this.request<ExpensesResponse>(
      `/get_expenses${q.toString() ? `?${q}` : ""}`
    );
    return r.expenses || [];
  }

  async getGroup(groupId: number): Promise<Record<string, any>> {
    const r = await this.request<GroupResponse>(`/get_group/${groupId}`);
    return r.group;
  }

  async createExpense(payload: Record<string, any>): Promise<any> {
    // Splitwise's create_expense endpoint expects FORM-ENCODED fields, with
    // participant shares in the legacy `users__N__<field>` key format (the
    // same format the official `splitwise` Python library uses). JSON bodies
    // are silently accepted but the participants are dropped, which would
    // produce a misleading success. So we serialize explicitly, and treat
    // `errors` in the response body as a failure (Splitwise returns HTTP
    // 200 with an `errors` object on validation errors).
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (key === "users") continue; // handled below
      form.set(key, String(value));
    }
    for (let i = 0; i < (payload.users?.length ?? 0); i++) {
      const u = payload.users[i];
      for (const [k, v] of Object.entries(u)) {
        form.set(`users__${i}__${k}`, String(v));
      }
    }

    const r = await this.request<{ expenses?: any[]; errors?: Record<string, any> }>(
      "/create_expense",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }
    );
    if (r.errors && Object.keys(r.errors).length > 0) {
      const msgs = Object.entries(r.errors).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((m) => `${k}: ${m}`)
      );
      throw new Error(`Splitwise a refusé la dépense : ${msgs.join("; ")}`);
    }
    return (r.expenses && r.expenses[0]) || r;
  }
}
