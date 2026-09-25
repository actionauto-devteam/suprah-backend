import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { evaluateProductionDbGuard } from '../utils/productionDbGuard.util';

const OVERRIDE_KEY = 'ALLOW_PRODUCTION_DB';
const INSTALLED = Symbol.for('suprah.productionDbGuard.installed');

const envFiles = ['.env.local', '.env'].map((name) => path.join(__dirname, '../../', name));

const overrideDefinedInEnvFile = (): boolean =>
  envFiles.some((file) => {
    try {
      return OVERRIDE_KEY in dotenv.parse(fs.readFileSync(file));
    } catch {
      return false;
    }
  });

let overrideAnnounced = false;

export const guardMongoUri = (uri: unknown, env: NodeJS.ProcessEnv = process.env): void => {
  const decision = evaluateProductionDbGuard({
    uri,
    nodeEnv: env.NODE_ENV,
    override: env[OVERRIDE_KEY],
    overrideDefinedInEnvFile: env[OVERRIDE_KEY] ? overrideDefinedInEnvFile() : false,
    extraTargets: env.PRODUCTION_DB_TARGETS,
  });
  if (!decision.allowed) throw new Error((decision as { message: string }).message);
  if (decision.reason === 'explicit_override' && !overrideAnnounced) {
    overrideAnnounced = true;
    console.warn(
      `[ProductionDbGuard] ${OVERRIDE_KEY} accepted for ${decision.target} (NODE_ENV=${env.NODE_ENV ?? 'unset'}, script=${path.basename(process.argv[1] ?? 'unknown')}).`,
    );
  }
};

type OpenUriHost = { openUri: (...args: any[]) => unknown };

const resolveConnectionPrototype = (): OpenUriHost | null => {
  try {
    const prototype = (mongoose as any)?.Connection?.prototype;
    return prototype && typeof prototype.openUri === 'function' ? prototype : null;
  } catch {
    return null;
  }
};

export const installProductionDbGuard = (connectionPrototype: OpenUriHost | null = resolveConnectionPrototype()): void => {
  if (!connectionPrototype) return;
  const marked = connectionPrototype as unknown as Record<symbol, unknown>;
  if (marked[INSTALLED]) return;
  const original = connectionPrototype.openUri;
  connectionPrototype.openUri = function guardedOpenUri(this: unknown, uri: unknown, options?: unknown) {
    guardMongoUri(uri);
    return original.call(this, uri, options);
  };
  marked[INSTALLED] = true;
};

installProductionDbGuard();
