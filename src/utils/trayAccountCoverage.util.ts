export interface HeartbeatRow {
  userId: string;
  lastSeenAt: Date | string;
  appVersion?: string | null;
  platform?: string | null;
}

export interface CrmRow {
  id: string;
  isActive?: boolean;
  isOffboarded?: boolean;
  organizationId?: unknown;
}

export interface MainRow {
  id: string;
  email?: string | null;
}

export interface CoverageInputs {
  heartbeats: HeartbeatRow[];
  crmRows: CrmRow[];
  mainRows: MainRow[];
  crmEmails: Set<string>;
  now: Date;
  windowDays: number[];
}

export interface CoverageSummary {
  trayIdentities: number;
  crmAccounts: {
    total: number;
    eligible: number;
    blocked: { inactive: number; offboarded: number; noOrganization: number };
  };
  withoutCrmUser: { total: number; mainAccountsOnly: number; unresolved: number; mainWithCrmByEmail: number };
  sampleIdsWithoutCrmUser: string[];
  appVersions: { deviceAuthCapable: number; older: number; unknown: number };
  platforms: Record<string, number>;
}

export type CoverageReport = Record<string, CoverageSummary>;

export const DEVICE_AUTH_MIN_VERSION = [1, 5, 5] as const;
const SAMPLE_LIMIT = 25;

export const isDeviceAuthCapableVersion = (version: string | null | undefined): boolean | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (core[i] !== DEVICE_AUTH_MIN_VERSION[i]) return core[i] > DEVICE_AUTH_MIN_VERSION[i];
  }
  return true;
};

const emptySummary = (): CoverageSummary => ({
  trayIdentities: 0,
  crmAccounts: { total: 0, eligible: 0, blocked: { inactive: 0, offboarded: 0, noOrganization: 0 } },
  withoutCrmUser: { total: 0, mainAccountsOnly: 0, unresolved: 0, mainWithCrmByEmail: 0 },
  sampleIdsWithoutCrmUser: [],
  appVersions: { deviceAuthCapable: 0, older: 0, unknown: 0 },
  platforms: {},
});

export const buildCoverageReport = (input: CoverageInputs): CoverageReport => {
  const crmById = new Map(input.crmRows.map((row) => [row.id, row]));
  const mainById = new Map(input.mainRows.map((row) => [row.id, row]));
  const report: CoverageReport = {};

  for (const days of input.windowDays) {
    const since = input.now.getTime() - days * 24 * 60 * 60 * 1000;
    const summary = emptySummary();
    const seen = new Set<string>();

    for (const beat of input.heartbeats) {
      if (new Date(beat.lastSeenAt).getTime() < since || seen.has(beat.userId)) continue;
      seen.add(beat.userId);
      summary.trayIdentities += 1;

      const platform = String(beat.platform ?? 'unknown').toLowerCase();
      summary.platforms[platform] = (summary.platforms[platform] ?? 0) + 1;
      const capable = isDeviceAuthCapableVersion(beat.appVersion);
      if (capable === null) summary.appVersions.unknown += 1;
      else if (capable) summary.appVersions.deviceAuthCapable += 1;
      else summary.appVersions.older += 1;

      const crm = crmById.get(beat.userId);
      if (crm) {
        summary.crmAccounts.total += 1;
        const inactive = crm.isActive === false;
        const offboarded = crm.isOffboarded === true;
        const noOrganization = !crm.organizationId;
        if (inactive) summary.crmAccounts.blocked.inactive += 1;
        if (offboarded) summary.crmAccounts.blocked.offboarded += 1;
        if (noOrganization) summary.crmAccounts.blocked.noOrganization += 1;
        if (!inactive && !offboarded && !noOrganization) summary.crmAccounts.eligible += 1;
        continue;
      }

      summary.withoutCrmUser.total += 1;
      const main = mainById.get(beat.userId);
      if (main) {
        summary.withoutCrmUser.mainAccountsOnly += 1;
        if (main.email && input.crmEmails.has(main.email.trim().toLowerCase())) summary.withoutCrmUser.mainWithCrmByEmail += 1;
      } else {
        summary.withoutCrmUser.unresolved += 1;
      }
      if (summary.sampleIdsWithoutCrmUser.length < SAMPLE_LIMIT) summary.sampleIdsWithoutCrmUser.push(beat.userId);
    }
    report[String(days)] = summary;
  }
  return report;
};
