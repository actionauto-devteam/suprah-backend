/**
 * Where Suprah talks to Wise, and whether Wise is set up well enough to link.
 *
 * Wise shut down its old test site (sandbox.transferwise.tech) after
 * June 30, 2026; its new test site is wise-sandbox.com. Outside production the
 * new test site is the fallback. Production has no fallback: the live site only
 * talks to the Wise addresses its settings name, so it never moves money
 * through an address nobody chose.
 */
export interface WiseSettings {
  oauthUrl: string;
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Signs the Wise link check; there is no built-in fallback (2026-11-20). */
  stateSecret: string;
}

export const WISE_TEST_SITE = {
  oauthUrl: 'https://wise-sandbox.com',
  apiUrl: 'https://api.wise-sandbox.com',
} as const;

/** Hosts of Wise's old test site, which no longer answers. */
export const RETIRED_WISE_HOSTS = [
  'sandbox.transferwise.tech',
  'api.sandbox.transferwise.tech',
  'sandbox.wise.tech',
  'api.sandbox.wise.tech',
];

/** What staff see when Wise can't be linked on this site. */
export const WISE_NOT_SET_UP_MESSAGE =
  "Wise isn't connected for this site yet, so it can't be linked. Ask your Suprah administrator to finish the Wise setup.";

/** The server setting behind each value, for the server log (names only, never values). */
const SETTING_NAMES: Record<keyof WiseSettings, string> = {
  oauthUrl: 'WISE_OAUTH_URL',
  apiUrl: 'WISE_API_URL',
  clientId: 'WISE_CLIENT_ID',
  clientSecret: 'WISE_CLIENT_SECRET',
  redirectUri: 'WISE_REDIRECT_URI',
  stateSecret: 'LINKED_ACCOUNT_STATE_SECRET',
};

type Env = Record<string, string | undefined>;

const text = (value?: string) => (value ?? '').trim();
const address = (value?: string) => text(value).replace(/\/+$/, '');

export function wiseSettingsFrom(env: Env): WiseSettings {
  const production = env.NODE_ENV === 'production';
  return {
    oauthUrl: address(env.WISE_OAUTH_URL) || (production ? '' : WISE_TEST_SITE.oauthUrl),
    apiUrl: address(env.WISE_API_URL) || (production ? '' : WISE_TEST_SITE.apiUrl),
    clientId: text(env.WISE_CLIENT_ID),
    clientSecret: text(env.WISE_CLIENT_SECRET),
    redirectUri: text(env.WISE_REDIRECT_URI),
    stateSecret: text(env.LINKED_ACCOUNT_STATE_SECRET),
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why Wise can't be linked with these settings, for the server log, or null
 * when it can. Names settings, never their values.
 */
export function wiseSetupProblem(settings: WiseSettings): string | null {
  const missing = (Object.keys(SETTING_NAMES) as Array<keyof WiseSettings>)
    .filter((key) => !settings[key])
    .map((key) => SETTING_NAMES[key]);
  if (missing.length) return `missing Wise settings: ${missing.join(', ')}`;

  for (const key of ['oauthUrl', 'apiUrl'] as const) {
    const host = hostOf(settings[key]);
    if (!host) return `${SETTING_NAMES[key]} is not a valid web address`;
    if (RETIRED_WISE_HOSTS.includes(host)) {
      return `${SETTING_NAMES[key]} points to Wise's retired test site (${host})`;
    }
  }
  return null;
}
