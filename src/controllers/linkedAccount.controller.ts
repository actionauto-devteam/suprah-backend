import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { IUser } from "../models/User.model";
import { LinkedProvider } from "../models/LinkedAccount";
import linkedAccountService from "../services/linkedAccount.service";
import logger from "../utils/logger";

// Wise-only. PayPal was removed (no API to read a connected account's balance,
// so it could never mirror money into the wallet). Any other provider value
// now resolves to null → 400 "Unsupported provider".
const SUPPORTED: LinkedProvider[] = ["wise"];

function parseProvider(value: unknown): LinkedProvider | null {
  return SUPPORTED.includes(value as LinkedProvider)
    ? (value as LinkedProvider)
    : null;
}

/**
 * GET /:provider/connect  (authenticated)
 * Returns the provider authorize URL. We sign a state token embedding the
 * userId so the (unauthenticated) callback can identify the user.
 */
const initiateConnect = asyncHandler(async (req: Request, res: Response) => {
  const provider = parseProvider(req.params.provider);
  if (!provider) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Unsupported provider"));
  }
  const userId = (req.user as IUser)._id.toString();
  const state = linkedAccountService.signState(userId, provider);
  const authUrl = linkedAccountService.buildAuthorizeUrl(provider, state);
  res.json(new ApiResponse(200, { authUrl, state }, "Authorize URL created"));
});

/**
 * GET /:provider/callback  (PUBLIC — third-party redirect, no Bearer token)
 * Validates the signed state, exchanges the code, persists the account, then
 * redirects the browser back to the billing page.
 */
const handleCallback = asyncHandler(async (req: Request, res: Response) => {
  const provider = parseProvider(req.params.provider);
  const { code, state } = req.query as { code?: string; state?: string };
  const fe = linkedAccountService.frontendUrl();

  if (!provider) return res.redirect(`${fe}/billing?error=bad_provider`);
  if (!code) return res.redirect(`${fe}/billing?error=no_code`);
  if (!state) return res.redirect(`${fe}/billing?error=no_state`);

  const verified = linkedAccountService.verifyState(state);
  if (!verified || verified.provider !== provider) {
    return res.redirect(`${fe}/billing?error=invalid_state`);
  }

  try {
    await linkedAccountService.connectProvider(provider, code, verified.userId);
    logger.info({ userId: verified.userId, provider }, "Linked account connected");
    return res.redirect(`${fe}/billing?connected=${provider}`);
  } catch (err: any) {
    logger.error({ err: err?.message, provider }, "Linked account callback failed");
    return res.redirect(`${fe}/billing?error=connection_failed`);
  }
});

/** GET /status — all connections for the user. */
const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const status = await linkedAccountService.getStatus(userId);
  res.json(new ApiResponse(200, status, "Status fetched"));
});

/** POST /sync — refresh primary balances, write into wallet. */
const syncBalances = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  try {
    const balances = await linkedAccountService.syncBalances(userId);
    res.json(new ApiResponse(200, { balances }, "Balances synced"));
  } catch (err: any) {
    res.status(400).json(new ApiResponse(400, null, err.message || "Sync failed"));
  }
});

/** GET /transactions?currency=USD */
const getTransactions = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const currency = (req.query.currency as string) || "USD";
  try {
    const transactions = await linkedAccountService.getTransactions(userId, currency);
    res.json(new ApiResponse(200, { transactions }, "Transactions fetched"));
  } catch (err: any) {
    res
      .status(400)
      .json(new ApiResponse(400, null, err.message || "Could not fetch transactions"));
  }
});

/** POST /transfer */
const createTransfer = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const { amount, currency, recipient, recipientEmail, reference, targetCurrency } =
    req.body;

  if (!amount || amount <= 0 || !recipient) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "amount and recipient are required"));
  }

  try {
    const result = await linkedAccountService.createTransfer(userId, {
      amount,
      currency,
      recipient,
      recipientEmail,
      reference,
      targetCurrency,
    });
    res.json(new ApiResponse(200, result, "Transfer created"));
  } catch (err: any) {
    res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          err?.response?.data?.message || err.message || "Transfer failed"
        )
      );
  }
});

/** POST /disconnect  body: { provider? } */
const disconnect = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const provider = parseProvider(req.body?.provider) || undefined;
  await linkedAccountService.disconnect(userId, provider);
  res.json(new ApiResponse(200, { success: true }, "Account disconnected"));
});

export default {
  initiateConnect,
  handleCallback,
  getStatus,
  syncBalances,
  getTransactions,
  createTransfer,
  disconnect,
};