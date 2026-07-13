import crypto from "crypto";
import { Types } from "mongoose";
import LinkedAccount, {
  ILinkedAccount,
  LinkedProvider,
} from "../models/LinkedAccount";
import User from "../models/User.model";
import { wiseClient } from "../lib/wise-client";


const STATE_SECRET =
  process.env.LINKED_ACCOUNT_STATE_SECRET || "dev-insecure-state-secret-change-me";
const STATE_TTL_MS = 10 * 60 * 1000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

export function signState(userId: string, provider: LinkedProvider): string {
  const payload = JSON.stringify({
    u: userId,
    p: provider,
    n: crypto.randomBytes(8).toString("hex"),
    e: Date.now() + STATE_TTL_MS,
  });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = crypto
    .createHmac("sha256", STATE_SECRET)
    .update(b64)
    .digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyState(
  state: string
): { userId: string; provider: LinkedProvider } | null {
  try {
    const [b64, sig] = state.split(".");
    if (!b64 || !sig) return null;
    const expected = crypto
      .createHmac("sha256", STATE_SECRET)
      .update(b64)
      .digest("base64url");
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (Date.now() > payload.e) return null;
    return { userId: payload.u, provider: payload.p };
  } catch {
    return null;
  }
}

export const frontendUrl = () => FRONTEND_URL;

/* ─────────────────────────── Authorize URL ──────────────────────────────── */
export function buildAuthorizeUrl(
  provider: LinkedProvider,
  state: string
): string {
  if (provider !== "wise") {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  const base = process.env.WISE_OAUTH_URL || "https://sandbox.transferwise.tech";
  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("client_id", process.env.WISE_CLIENT_ID || "");
  url.searchParams.set("redirect_uri", process.env.WISE_REDIRECT_URI || "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/* ─────────────────────────── Token freshness ────────────────────────────── */
async function ensureFreshToken(account: ILinkedAccount): Promise<void> {
  if (new Date() < account.tokenExpiry) return;
  if (!account.refreshToken) return; // nothing we can do; caller handles failure

  const t = await wiseClient.refreshToken(account.refreshToken);
  account.accessToken = t.access_token;
  account.refreshToken = t.refresh_token ?? account.refreshToken;
  account.tokenExpiry = new Date(Date.now() + t.expires_in * 1000);
  await account.save();
}

/* ─────────────────────────── Provider fetchers ──────────────────────────── */
function reportingWindow() {
  const end = new Date();
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function fetchProfileAndBalances(accessToken: string): Promise<{
  profileId: string;
  profileType: "personal" | "business";
  fullName: string;
  email: string;
  balances: { currency: string; amount: number; reservedAmount: number }[];
}> {
  const profiles = await wiseClient.getProfiles(accessToken);
  const primary = profiles[0];
  if (!primary) throw new Error("No Wise profile found");

  const details = await wiseClient.getProfile(accessToken, primary.id);
  const balancesData = await wiseClient.getBalances(accessToken, primary.id);
  const balances = (balancesData[0]?.balances || []).map((b: any) => ({
    currency: b.currency,
    amount: b.amount?.value ?? 0,
    reservedAmount: b.reservedAmount?.value ?? 0,
  }));

  return {
    profileId: String(primary.id),
    profileType: primary.type === "business" ? "business" : "personal",
    fullName: details.details?.name || primary.fullName || "Wise user",
    email: details.details?.email || primary.email || "",
    balances,
  };
}

async function fetchTransactions(account: ILinkedAccount, currency = "USD") {
  const { start, end } = reportingWindow();
  const stmt = await wiseClient.getStatement(
    account.accessToken,
    account.profileId,
    currency,
    start,
    end
  );
  return (stmt.transactions || []).map((tx: any) => ({
    id: tx.referenceNumber,
    date: tx.date,
    description: tx.details?.description || "Transaction",
    amount: Math.abs(tx.amount?.value ?? 0),
    currency: tx.amount?.currency ?? currency,
    type: (tx.amount?.value ?? 0) > 0 ? "credit" : "debit",
    status: tx.runningBalance ? "completed" : "pending",
    recipient: tx.details?.recipient?.name,
  }));
}

/* ─────────────────────────── Wallet sync ────────────────────────────────── */
/** Pick the USD balance, else the first balance, as the wallet number. */
function walletAmountFromBalances(balances: { currency: string; amount: number }[]) {
  if (!balances.length) return 0;
  const usd = balances.find((b) => b.currency === "USD");
  return Number((usd ?? balances[0]).amount ?? 0);
}

async function writeWalletBalance(userId: Types.ObjectId | string, amount: number) {
  await User.findByIdAndUpdate(userId, {
    walletBalance: Math.max(0, Number(amount.toFixed(2))),
  });
}

/* ─────────────────────────── Public API ─────────────────────────────────── */

/** Exchange code → tokens, persist account, make it primary, sync wallet. */
export async function connectProvider(
  provider: LinkedProvider,
  code: string,
  userId: string
): Promise<ILinkedAccount> {
  if (provider !== "wise") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  // 1. Exchange code
  const tokens = await wiseClient.exchangeCode(code);

  // 2. Profile + balances
  const info = await fetchProfileAndBalances(tokens.access_token);

  // 3. Demote any existing primary; this newly connected account becomes primary
  await LinkedAccount.updateMany({ userId }, { isPrimary: false });

  const account = await LinkedAccount.findOneAndUpdate(
    { userId, provider },
    {
      userId,
      provider,
      profileId: info.profileId,
      profileType: info.profileType,
      fullName: info.fullName,
      email: info.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
      balances: info.balances.map((b) => ({ ...b, lastUpdated: new Date() })),
      isActive: true,
      isPrimary: true,
      lastSyncedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // 4. Sync wallet
  await writeWalletBalance(userId, walletAmountFromBalances(info.balances));

  return account!;
}

/** Read the status of the user's connections (primary first). */
export async function getStatus(userId: string) {
  const accounts = await LinkedAccount.find({ userId, isActive: true }).sort({
    isPrimary: -1,
    updatedAt: -1,
  });

  if (!accounts.length) {
    return { connected: false, primary: null, accounts: [] as any[] };
  }

  const shape = (a: ILinkedAccount) => ({
    provider: a.provider,
    profile: {
      id: a.profileId,
      type: a.profileType,
      fullName: a.fullName,
      email: a.email,
      avatarInitials: a.fullName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2),
    },
    balances: a.balances,
    isPrimary: a.isPrimary,
    lastSyncedAt: a.lastSyncedAt,
  });

  const primary = accounts.find((a) => a.isPrimary) ?? accounts[0];
  return {
    connected: true,
    primary: shape(primary),
    accounts: accounts.map(shape),
  };
}

/** Refresh balances for the primary account and re-sync the wallet. */
export async function syncBalances(userId: string) {
  const account = await LinkedAccount.findOne({
    userId,
    isActive: true,
    isPrimary: true,
  }).select("+accessToken +refreshToken");

  if (!account) throw new Error("No connected account to sync");

  await ensureFreshToken(account);
  const info = await fetchProfileAndBalances(account.accessToken);
  account.balances = info.balances.map((b) => ({ ...b, lastUpdated: new Date() }));
  account.lastSyncedAt = new Date();
  await account.save();

  await writeWalletBalance(userId, walletAmountFromBalances(info.balances));
  return account.balances;
}

/** Fetch + return transactions for the primary account. */
export async function getTransactions(userId: string, currency = "USD") {
  const account = await LinkedAccount.findOne({
    userId,
    isActive: true,
    isPrimary: true,
  }).select("+accessToken +refreshToken");

  if (!account) throw new Error("No connected account");

  await ensureFreshToken(account);
  return fetchTransactions(account, currency);
}

/** Disconnect a specific provider (or the primary if none specified). */
export async function disconnect(userId: string, provider?: LinkedProvider) {
  const query: any = { userId };
  if (provider) query.provider = provider;
  else query.isPrimary = true;

  const account = await LinkedAccount.findOneAndUpdate(
    query,
    { isActive: false, isPrimary: false },
    { new: true }
  );

  // Promote another active account to primary if one remains
  const next = await LinkedAccount.findOne({ userId, isActive: true }).sort({
    updatedAt: -1,
  });
  if (next) {
    next.isPrimary = true;
    await next.save();
    await writeWalletBalance(userId, walletAmountFromBalances(next.balances));
  } else {
    await writeWalletBalance(userId, 0);
  }

  return account;
}

/** Create a transfer/payout from the connected Wise account. */
export async function createTransfer(
  userId: string,
  payload: {
    amount: number;
    currency?: string;
    recipient: string;
    recipientEmail?: string;
    reference?: string;
    targetCurrency?: string;
  }
) {
  const account = await LinkedAccount.findOne({
    userId,
    isActive: true,
    isPrimary: true,
  }).select("+accessToken +refreshToken");

  if (!account) throw new Error("No connected account");
  await ensureFreshToken(account);

  const currency = payload.currency || "USD";
  const txId = `SUPRAPAY-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  // Wise: quote → transfer → fund
  const quote = await wiseClient.createQuote(account.accessToken, account.profileId, {
    sourceCurrency: currency,
    targetCurrency: payload.targetCurrency || currency,
    sourceAmount: payload.amount,
  });
  const transfer = await wiseClient.createTransfer(account.accessToken, {
    targetAccount: "DEMO_ACCOUNT", // replace with a real recipient account id
    quoteUuid: quote.id,
    customerTransactionId: txId,
    details: { reference: payload.reference || `Transfer to ${payload.recipient}` },
  });
  await wiseClient.fundTransfer(account.accessToken, account.profileId, transfer.id);
  return { transferId: transfer.id, status: transfer.status };
}

export default {
  signState,
  verifyState,
  frontendUrl,
  buildAuthorizeUrl,
  connectProvider,
  getStatus,
  syncBalances,
  getTransactions,
  disconnect,
  createTransfer,
};