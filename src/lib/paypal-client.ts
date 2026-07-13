import axios from "axios";

interface PayPalConfig {
  apiUrl: string;
  webUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface PayPalTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export class PayPalClient {
  private config: PayPalConfig;

  constructor(config: PayPalConfig) {
    this.config = config;
  }

  static SCOPES = [
    "openid",
    "email",
    "profile",
    "https://uri.paypal.com/services/reporting/search/read",
  ];

  private basicAuthHeader() {
    const raw = `${this.config.clientId}:${this.config.clientSecret}`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
  }

  /** Build the authorize URL the browser is redirected to. */
  buildAuthorizeUrl(state: string): string {
    const url = new URL(`${this.config.webUrl}/connect`);
    url.searchParams.set("flowEntry", "static");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("scope", PayPalClient.SCOPES.join(" "));
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** Exchange the authorization code for tokens. */
  async exchangeCode(code: string): Promise<PayPalTokenResponse> {
    const params = new URLSearchParams();
    params.set("grant_type", "authorization_code");
    params.set("code", code);
    const res = await axios.post(
      `${this.config.apiUrl}/v1/oauth2/token`,
      params.toString(),
      {
        headers: {
          Authorization: this.basicAuthHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return res.data;
  }

  /** Refresh an expired access token. */
  async refreshToken(refreshToken: string): Promise<PayPalTokenResponse> {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);
    const res = await axios.post(
      `${this.config.apiUrl}/v1/oauth2/token`,
      params.toString(),
      {
        headers: {
          Authorization: this.basicAuthHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return res.data;
  }

  /** App-level client_credentials token (used for Reporting API). */
  async getAppToken(): Promise<string> {
    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    const res = await axios.post(
      `${this.config.apiUrl}/v1/oauth2/token`,
      params.toString(),
      {
        headers: {
          Authorization: this.basicAuthHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return res.data.access_token;
  }

  /** Identity / userinfo for the connected user. */
  async getUserInfo(accessToken: string) {
    const res = await axios.get(
      `${this.config.apiUrl}/v1/identity/oauth2/userinfo?schema=paypalv1.1`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return res.data as {
      user_id: string;
      name?: string;
      email?: string;
      account_type?: string; // PERSONAL | BUSINESS
    };
  }

  /**
   * Transaction Search (Reporting API). Scope-gated:
   * `https:
   * Date window max 31 days per PayPal limits.
   */
  async getTransactions(
    accessToken: string,
    startDateIso: string,
    endDateIso: string
  ) {
    const res = await axios.get(
      `${this.config.apiUrl}/v1/reporting/transactions`,
      {
        params: {
          start_date: startDateIso,
          end_date: endDateIso,
          fields: "all",
          page_size: 100,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return res.data; // { transaction_details: [...] }
  }

  /**
   * APPROXIMATION ONLY. Sums net reporting activity in the window and returns
   * it as a pseudo-balance per currency. Replace with a real GetBalance call
   * in production. Returns [] if the account lacks reporting access.
   */
  async getDerivedBalance(
    accessToken: string,
    startDateIso: string,
    endDateIso: string
  ): Promise<{ currency: string; amount: number }[]> {
    try {
      const data = await this.getTransactions(
        accessToken,
        startDateIso,
        endDateIso
      );
      const byCurrency = new Map<string, number>();
      for (const d of data?.transaction_details ?? []) {
        const info = d?.transaction_info;
        const amt = info?.transaction_amount;
        if (!amt?.currency_code) continue;
        const value = parseFloat(amt.value || "0");
        byCurrency.set(
          amt.currency_code,
          (byCurrency.get(amt.currency_code) ?? 0) + value
        );
      }
      return Array.from(byCurrency.entries()).map(([currency, amount]) => ({
        currency,
        amount: Math.max(0, Number(amount.toFixed(2))),
      }));
    } catch {
      return [];
    }
  }

  /** Normalize reporting transactions into the app shape. */
  normalizeTransactions(raw: any): Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    currency: string;
    type: "credit" | "debit";
    status: "completed" | "pending" | "cancelled";
    recipient?: string;
  }> {
    const out: any[] = [];
    for (const d of raw?.transaction_details ?? []) {
      const info = d?.transaction_info ?? {};
      const amt = info?.transaction_amount ?? {};
      const value = parseFloat(amt.value || "0");
      const statusCode = info?.transaction_status; // S=success, P=pending, V=reversed...
      out.push({
        id: info.transaction_id || `${info.transaction_initiation_date}`,
        date: info.transaction_initiation_date || new Date().toISOString(),
        description:
          info.transaction_subject ||
          info.transaction_note ||
          d?.payer_info?.payer_name?.alternate_full_name ||
          "PayPal transaction",
        amount: Math.abs(value),
        currency: amt.currency_code || "USD",
        type: value >= 0 ? "credit" : "debit",
        status:
          statusCode === "S"
            ? "completed"
            : statusCode === "P"
              ? "pending"
              : "cancelled",
        recipient: d?.payer_info?.email_address,
      });
    }
    return out;
  }

  /**
   * Create a payout (Send money). Uses the Payouts API with a client_credentials
   * token. Requires the Payouts product enabled on the app.
   */
  async createPayout(payload: {
    receiverEmail: string;
    amount: number;
    currency: string;
    note?: string;
    senderItemId: string;
  }) {
    const appToken = await this.getAppToken();
    const res = await axios.post(
      `${this.config.apiUrl}/v1/payments/payouts`,
      {
        sender_batch_header: {
          sender_batch_id: payload.senderItemId,
          email_subject: "You have a payment from SuprahPay",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: {
              value: payload.amount.toFixed(2),
              currency: payload.currency,
            },
            receiver: payload.receiverEmail,
            note: payload.note || "SuprahPay transfer",
            sender_item_id: payload.senderItemId,
          },
        ],
      },
      { headers: { Authorization: `Bearer ${appToken}` } }
    );
    return res.data;
  }
}

export const paypalClient = new PayPalClient({
  apiUrl: process.env.PAYPAL_API_URL || "https://api-m.sandbox.paypal.com",
  webUrl: process.env.PAYPAL_WEB_URL || "https://www.sandbox.paypal.com",
  clientId: process.env.PAYPAL_CLIENT_ID || "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  redirectUri: process.env.PAYPAL_REDIRECT_URI || "",
});