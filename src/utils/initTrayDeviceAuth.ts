import TrayDevice from '../models/TrayDevice.model';
import TrayBootstrapCode from '../models/TrayBootstrapCode.model';
import logger from './logger';
import { getTrayDeviceAuthMode } from './trayDevice.util';
import {
  REQUIRED_TRAY_BOOTSTRAP_INDEXES,
  REQUIRED_TRAY_DEVICE_INDEXES,
  findIndexProblems,
} from './trayDeviceIndexes.util';
import type { ActualIndex, RequiredIndex } from './trayDeviceIndexes.util';

interface IndexedModel {
  collection: { name: string };
  createIndexes(): Promise<unknown>;
  listIndexes(): Promise<ActualIndex[]>;
}

const targets = (): Array<{ model: IndexedModel; required: RequiredIndex[] }> => [
  { model: TrayDevice as unknown as IndexedModel, required: REQUIRED_TRAY_DEVICE_INDEXES },
  { model: TrayBootstrapCode as unknown as IndexedModel, required: REQUIRED_TRAY_BOOTSTRAP_INDEXES },
];

const listExisting = async (model: IndexedModel): Promise<ActualIndex[]> => {
  try {
    return await model.listIndexes();
  } catch (err: any) {
    if (err?.code === 26 || err?.codeName === 'NamespaceNotFound') return [];
    throw err;
  }
};

export const ensureTrayDeviceIndexes = async (options: { create?: boolean } = {}): Promise<string[]> => {
  const create = options.create === true;
  const problems: string[] = [];
  for (const { model, required } of targets()) {
    if (create) await model.createIndexes();
    const actual = await listExisting(model);
    problems.push(...findIndexProblems(required, actual).map((problem) => `${model.collection.name}: ${problem}`));
  }
  return problems;
};

export const initTrayDeviceAuth = async (): Promise<void> => {
  const { mode, allowlistSize } = getTrayDeviceAuthMode();
  const description = mode === 'allowlist' ? `allowlist of ${allowlistSize} user(s)` : mode;
  logger.info(`[TrayDevice] device authentication mode: ${description}`);
  if (mode === 'off' || mode === 'killed') return;
  try {
    const problems = await ensureTrayDeviceIndexes();
    if (problems.length > 0) {
      logger.error({ problems }, '[TrayDevice] required MongoDB indexes are missing; run verify-tray-device-indexes --create');
    } else {
      logger.info('[TrayDevice] MongoDB indexes verified');
    }
  } catch (err) {
    logger.error({ err }, '[TrayDevice] could not verify MongoDB indexes');
  }
};
