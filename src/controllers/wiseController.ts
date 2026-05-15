import { Request, Response } from "express";
import { wiseClient } from "../lib/wise-client";
import WiseAccount from "../models/WiseAccount";
import WiseTransaction from "../models/WiseTransaction";
import crypto from "crypto";

/**
 * Initiate Wise OAuth flow
 */
export const initiateConnect = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id; // Assuming auth middleware sets req.user

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString("hex");

    // Store state in session or cache (implement your session management)
    // req.session.wiseOAuthState = state;

    const authUrl = new URL(`${process.env.WISE_OAUTH_URL}/oauth/authorize`);
    authUrl.searchParams.append("client_id", process.env.WISE_CLIENT_ID!);
    authUrl.searchParams.append("redirect_uri", process.env.WISE_REDIRECT_URI!);
    authUrl.searchParams.append("response_type", "code");
    authUrl.searchParams.append("state", state);

    res.json({ authUrl: authUrl.toString(), state });
  } catch (error: any) {
    console.error("[Wise] Connect initiation error:", error);
    res.status(500).json({ error: "Failed to initiate Wise connection" });
  }
};

/**
 * Handle OAuth callback
 */
export const handleCallback = async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    const userId = req.user?.id;

    if (!userId) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/billing?error=unauthorized`
      );
    }

    if (!code) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/billing?error=no_code`
      );
    }

    // Verify state (implement your session verification)
    // if (state !== req.session.wiseOAuthState) {
    //   return res.redirect(`${process.env.FRONTEND_URL}/billing?error=invalid_state`);
    // }

    // Exchange code for tokens
    const tokenData = await wiseClient.exchangeCode(code as string);
    const { access_token, refresh_token, expires_in } = tokenData;

    // Get user profiles
    const profiles = await wiseClient.getProfiles(access_token);
    const primaryProfile = profiles[0]; // Use first profile

    if (!primaryProfile) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/billing?error=no_profile`
      );
    }

    // Get profile details
    const profileDetails = await wiseClient.getProfile(
      access_token,
      primaryProfile.id
    );

    // Get balances
    const balancesData = await wiseClient.getBalances(
      access_token,
      primaryProfile.id
    );
    const balances = balancesData[0]?.balances || [];

    // Calculate token expiry
    const tokenExpiry = new Date(Date.now() + expires_in * 1000);

    // Save or update Wise account
    await WiseAccount.findOneAndUpdate(
      { userId },
      {
        userId,
        profileId: primaryProfile.id,
        profileType: primaryProfile.type,
        fullName: profileDetails.details?.name || primaryProfile.fullName,
        email: profileDetails.details?.email || primaryProfile.email,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiry,
        balances: balances.map((b: any) => ({
          currency: b.currency,
          amount: b.amount.value,
          reservedAmount: b.reservedAmount?.value || 0,
          lastUpdated: new Date(),
        })),
        isActive: true,
      },
      { upsert: true, new: true }
    );

    // Redirect to frontend success page
    res.redirect(`${process.env.FRONTEND_URL}/billing?wise_connected=true`);
  } catch (error: any) {
    console.error("[Wise] OAuth callback error:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/billing?error=connection_failed`
    );
  }
};

/**
 * Get connected Wise account status
 */
export const getAccountStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const wiseAccount = await WiseAccount.findOne({ userId, isActive: true });

    if (!wiseAccount) {
      return res.json({
        connected: false,
        profile: null,
        balances: [],
      });
    }

    // Check if token needs refresh
    if (new Date() >= wiseAccount.tokenExpiry) {
      await refreshAccessToken(wiseAccount);
    }

    res.json({
      connected: true,
      profile: {
        id: wiseAccount.profileId,
        type: wiseAccount.profileType,
        fullName: wiseAccount.fullName,
        email: wiseAccount.email,
        avatarInitials: wiseAccount.fullName
          .split(" ")
          .map((n) => n[0])
          .join("")
          .toUpperCase()
          .slice(0, 2),
      },
      balances: wiseAccount.balances,
    });
  } catch (error: any) {
    console.error("[Wise] Get account status error:", error);
    res.status(500).json({ error: "Failed to get Wise account status" });
  }
};

/**
 * Get balances (refresh from Wise API)
 */
export const getBalances = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const wiseAccount = await WiseAccount.findOne({
      userId,
      isActive: true,
    }).select("+accessToken");

    if (!wiseAccount) {
      return res.status(404).json({ error: "Wise account not connected" });
    }

    // Ensure token is fresh
    await ensureFreshToken(wiseAccount);

    // Fetch latest balances
    const balancesData = await wiseClient.getBalances(
      wiseAccount.accessToken,
      wiseAccount.profileId
    );
    const balances = balancesData[0]?.balances || [];

    // Update stored balances
    wiseAccount.balances = balances.map((b: any) => ({
      currency: b.currency,
      amount: b.amount.value,
      reservedAmount: b.reservedAmount?.value || 0,
      lastUpdated: new Date(),
    }));
    await wiseAccount.save();

    res.json({ balances: wiseAccount.balances });
  } catch (error: any) {
    console.error("[Wise] Get balances error:", error);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
};

/**
 * Get transactions
 */
export const getTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { currency = "USD", days = 30 } = req.query;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const wiseAccount = await WiseAccount.findOne({
      userId,
      isActive: true,
    }).select("+accessToken");

    if (!wiseAccount) {
      return res.status(404).json({ error: "Wise account not connected" });
    }

    // Ensure token is fresh
    await ensureFreshToken(wiseAccount);

    // Calculate date range
    const intervalEnd = new Date().toISOString();
    const intervalStart = new Date(
      Date.now() - parseInt(days as string) * 24 * 60 * 60 * 1000
    ).toISOString();

    // Fetch statement from Wise
    const statement = await wiseClient.getStatement(
      wiseAccount.accessToken,
      wiseAccount.profileId,
      currency as string,
      intervalStart,
      intervalEnd
    );

    // Transform and cache transactions
    const transactions = statement.transactions.map((tx: any) => ({
      id: tx.referenceNumber,
      date: tx.date,
      description: tx.details.description || "Transaction",
      amount: Math.abs(tx.amount.value),
      currency: tx.amount.currency,
      type: tx.amount.value > 0 ? "credit" : "debit",
      status: tx.runningBalance ? "completed" : "pending",
      recipient: tx.details.recipient?.name,
      metadata: tx,
    }));

    // Save to database for caching
    for (const tx of transactions) {
      await WiseTransaction.findOneAndUpdate(
        { transactionId: tx.id },
        {
          userId,
          wiseAccountId: wiseAccount.profileId,
          transactionId: tx.id,
          date: tx.date,
          description: tx.description,
          amount: tx.amount,
          currency: tx.currency,
          type: tx.type,
          status: tx.status,
          recipient: tx.recipient,
          metadata: tx.metadata,
        },
        { upsert: true, new: true }
      );
    }

    res.json({ transactions });
  } catch (error: any) {
    console.error("[Wise] Get transactions error:", error);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
};

/**
 * Create transfer
 */
export const createTransfer = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const {
      sourceCurrency,
      targetCurrency,
      amount,
      recipient,
      recipientEmail,
      reference,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Validate input
    if (!sourceCurrency || !targetCurrency || !amount || !recipient) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than zero" });
    }

    const wiseAccount = await WiseAccount.findOne({
      userId,
      isActive: true,
    }).select("+accessToken");

    if (!wiseAccount) {
      return res.status(404).json({ error: "Wise account not connected" });
    }

    // Ensure token is fresh
    await ensureFreshToken(wiseAccount);

    // Step 1: Create quote
    const quote = await wiseClient.createQuote(
      wiseAccount.accessToken,
      wiseAccount.profileId,
      {
        sourceCurrency,
        targetCurrency,
        sourceAmount: amount,
      }
    );

    // Step 2: Create or get recipient (simplified - in production, allow user to select existing recipients)
    // This would need proper recipient details based on currency and country
    // For demo purposes, we'll skip actual recipient creation

    // Step 3: Create transfer
    const customerTransactionId = `SUPRAPAY-${Date.now()}-${crypto
      .randomBytes(4)
      .toString("hex")}`;

    const transfer = await wiseClient.createTransfer(
      wiseAccount.accessToken,
      {
        targetAccount: "DEMO_ACCOUNT", // In production, use actual recipient account ID
        quoteUuid: quote.id,
        customerTransactionId,
        details: {
          reference: reference || `Transfer to ${recipient}`,
        },
      }
    );

    // Step 4: Fund transfer from balance
    await wiseClient.fundTransfer(
      wiseAccount.accessToken,
      wiseAccount.profileId,
      transfer.id
    );

    // Calculate estimated delivery
    const estimatedDelivery = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    res.json({
      success: true,
      transferId: transfer.id,
      status: transfer.status,
      estimatedDelivery,
    });
  } catch (error: any) {
    console.error("[Wise] Create transfer error:", error);
    res.status(500).json({
      error: error.response?.data?.message || "Failed to create transfer",
    });
  }
};

/**
 * Disconnect Wise account
 */
export const disconnect = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await WiseAccount.findOneAndUpdate(
      { userId },
      { isActive: false },
      { new: true }
    );

    res.json({ success: true, message: "Wise account disconnected" });
  } catch (error: any) {
    console.error("[Wise] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect Wise account" });
  }
};

// Helper functions

async function ensureFreshToken(wiseAccount: any) {
  if (new Date() >= wiseAccount.tokenExpiry) {
    await refreshAccessToken(wiseAccount);
  }
}

async function refreshAccessToken(wiseAccount: any) {
  try {
    const tokenData = await wiseClient.refreshToken(wiseAccount.refreshToken);
    const { access_token, refresh_token, expires_in } = tokenData;

    wiseAccount.accessToken = access_token;
    wiseAccount.refreshToken = refresh_token;
    wiseAccount.tokenExpiry = new Date(Date.now() + expires_in * 1000);

    await wiseAccount.save();
  } catch (error) {
    console.error("[Wise] Token refresh error:", error);
    throw new Error("Failed to refresh access token");
  }
}