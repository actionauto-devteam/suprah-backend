import crypto from "crypto";

const API_BASE = "https://api.telnyx.com/v2";

const {
  TELNYX_API_KEY = "",
  TELNYX_PUBLIC_KEY = "",
  TELNYX_PHONE_NUMBER = "",
  TELNYX_MESSAGING_PROFILE_ID = "",
  TELNYX_SIP_CONNECTION_ID = "",
} = process.env;

export const COMPANY_NUMBER = TELNYX_PHONE_NUMBER;

class TelnyxError extends Error {
  status: number;
  detail: any;
  constructor(status: number, detail: any) {
    super(`Telnyx API error ${status}: ${JSON.stringify(detail)?.slice(0, 500)}`);
    this.status = status;
    this.detail = detail;
  }
}

async function tx<T = any>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: any
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new TelnyxError(res.status, json?.errors ?? json);
  return json as T;
}

/* --------------------------------- SMS ---------------------------------- */

export async function sendSms(to: string, text: string) {
  const res = await tx<{ data: { id: string; to: any[] } }>("POST", "/messages", {
    from: TELNYX_PHONE_NUMBER,
    to,
    text,
    messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID || undefined,
  });
  return res.data; // { id, ... }
}

/* ------------------------------ Call Control ---------------------------- */
/** Bridge an unanswered inbound call to an agent's WebRTC endpoint.
 *  Transferring without answering first keeps ringback playing for the
 *  caller until the agent's browser picks up. `client_state` tags the new
 *  leg so the webhook handler can tell agent legs from fresh inbound calls. */
export async function transferToAgent(
  callControlId: string,
  sipUsername: string,
  clientState: Record<string, any>
) {
  return tx("POST", `/calls/${encodeURIComponent(callControlId)}/actions/transfer`, {
    to: `sip:${sipUsername}@sip.telnyx.com`,
    from: TELNYX_PHONE_NUMBER,
    client_state: Buffer.from(JSON.stringify(clientState)).toString("base64"),
    timeout_secs: 45,
  });
}

export async function answerCall(callControlId: string) {
  return tx("POST", `/calls/${encodeURIComponent(callControlId)}/actions/answer`, {});
}

export async function speak(callControlId: string, payload: string) {
  return tx("POST", `/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
    payload,
    voice: "female",
    language: "en-US",
  });
}

export async function hangupCall(callControlId: string) {
  return tx("POST", `/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {});
}

/** Answer + play an "we missed you" message + hang up (missed-call path). */
export async function playMissedAndHangup(callControlId: string, message: string) {
  try {
    await answerCall(callControlId);
    await speak(callControlId, message);
    // speak triggers call.speak.ended → we hang up from the webhook handler;
    // as a belt-and-suspenders fallback, schedule a hangup:
    setTimeout(() => hangupCall(callControlId).catch(() => {}), 15_000);
  } catch {
    await hangupCall(callControlId).catch(() => {});
  }
}

/* --------------------------- WebRTC credentials ------------------------- */

/** Create a per-user on-demand telephony credential on the SIP connection. */
export async function createTelephonyCredential(tagName: string) {
  const res = await tx<{ data: { id: string; sip_username: string } }>(
    "POST",
    "/telephony_credentials",
    {
      connection_id: TELNYX_SIP_CONNECTION_ID,
      name: tagName.slice(0, 100),
    }
  );
  return res.data; // { id, sip_username }
}

/** Short-lived JWT the browser uses to log the TelnyxRTC client in. */
export async function createRtcLoginToken(credentialId: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/telephony_credentials/${encodeURIComponent(credentialId)}/token`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
    }
  );
  const token = await res.text();
  if (!res.ok) throw new TelnyxError(res.status, token);
  return token.trim();
}

/* -------------------------- Webhook verification ------------------------ */
/** Telnyx signs webhooks with Ed25519 over `${timestamp}|${rawBody}`.
 *  TELNYX_PUBLIC_KEY is the base64 raw 32-byte key from the portal; wrap it
 *  in an SPKI DER header so Node's crypto can consume it. */
let cachedPublicKey: crypto.KeyObject | null = null;

function getPublicKey(): crypto.KeyObject {
  if (!cachedPublicKey) {
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"), // SPKI prefix for Ed25519
      Buffer.from(TELNYX_PUBLIC_KEY, "base64"),
    ]);
    cachedPublicKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  }
  return cachedPublicKey;
}

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureBase64: string,
  timestamp: string,
  toleranceSec = 300
): boolean {
  try {
    if (!signatureBase64 || !timestamp) return false;
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;

    const payload = Buffer.concat([
      Buffer.from(timestamp, "utf8"),
      Buffer.from("|", "utf8"),
      Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8"),
    ]);
    return crypto.verify(null, payload, getPublicKey(), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
