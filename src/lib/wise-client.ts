import axios, { AxiosInstance } from "axios";

interface WiseConfig {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class WiseClient {
  private api: AxiosInstance;
  private config: WiseConfig;

  constructor(config: WiseConfig) {
    this.config = config;
    this.api = axios.create({
      baseURL: config.apiUrl,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCode(code: string) {
    const response = await axios.post(
      `${this.config.apiUrl}/oauth/token`,
      {
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
      }
    );
    return response.data;
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string) {
    const response = await axios.post(
      `${this.config.apiUrl}/oauth/token`,
      {
        grant_type: "refresh_token",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
      }
    );
    return response.data;
  }

  /**
   * Get user profiles
   */
  async getProfiles(accessToken: string) {
    const response = await this.api.get("/v1/profiles", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.data;
  }

  /**
   * Get profile details
   */
  async getProfile(accessToken: string, profileId: string) {
    const response = await this.api.get(`/v1/profiles/${profileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.data;
  }

  /**
   * Get all balances for a profile
   */
  async getBalances(accessToken: string, profileId: string) {
    const response = await this.api.get(
      `/v1/borderless-accounts?profileId=${profileId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return response.data;
  }

  /**
   * Get account statement (transactions)
   */
  async getStatement(
    accessToken: string,
    profileId: string,
    currency: string,
    intervalStart: string,
    intervalEnd: string
  ) {
    const response = await this.api.get(
      `/v3/profiles/${profileId}/borderless-accounts/statement.json`,
      {
        params: {
          currency,
          intervalStart,
          intervalEnd,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return response.data;
  }

  /**
   * Create a quote for transfer
   */
  async createQuote(
    accessToken: string,
    profileId: string,
    payload: {
      sourceCurrency: string;
      targetCurrency: string;
      sourceAmount?: number;
      targetAmount?: number;
    }
  ) {
    const response = await this.api.post(
      `/v2/quotes`,
      {
        profile: profileId,
        ...payload,
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return response.data;
  }

  /**
   * Create recipient account
   */
  async createRecipient(
    accessToken: string,
    payload: {
      currency: string;
      type: string;
      profile: string;
      accountHolderName: string;
      details: Record<string, any>;
    }
  ) {
    const response = await this.api.post(`/v1/accounts`, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.data;
  }

  /**
   * Create transfer
   */
  async createTransfer(
    accessToken: string,
    payload: {
      targetAccount: string;
      quoteUuid: string;
      customerTransactionId: string;
      details?: {
        reference?: string;
        transferPurpose?: string;
      };
    }
  ) {
    const response = await this.api.post(`/v1/transfers`, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.data;
  }

  /**
   * Fund transfer
   */
  async fundTransfer(
    accessToken: string,
    profileId: string,
    transferId: string
  ) {
    const response = await this.api.post(
      `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
      {
        type: "BALANCE",
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    return response.data;
  }

  /**
   * Get transfer status
   */
  async getTransfer(accessToken: string, transferId: string) {
    const response = await this.api.get(`/v1/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.data;
  }
}

// Export singleton instance
export const wiseClient = new WiseClient({
  apiUrl: process.env.WISE_API_URL || "https://api.sandbox.transferwise.tech",
  clientId: process.env.WISE_CLIENT_ID || "",
  clientSecret: process.env.WISE_CLIENT_SECRET || "",
  redirectUri: process.env.WISE_REDIRECT_URI || "",
});