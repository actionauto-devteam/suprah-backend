import mongoose from 'mongoose';
import { withSilentAppLogger } from '../src/utils/readOnlyDbTarget';

const [mode, uri, marker] = process.argv.slice(2);
const mongodbUriFilledBefore = Boolean(process.env.MONGODB_URI);

(async () => {
  const load = () => Promise.all([import('../src/services/aiTrainingIntegrity.service'), import('../src/utils/logger')]);
  const [, logging] = mode === 'silenced' ? await withSilentAppLogger(load) : await load();
  const openAfterImport = mongoose.connections.filter((connection) => connection.readyState !== 0).length;
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  logging.default.warn(marker);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log(JSON.stringify({
    result: 'probe',
    loggerLevel: logging.default.level,
    nodeEnv: process.env.NODE_ENV ?? null,
    mongodbUriFilledBefore,
    mongodbUriFilledAfter: Boolean(process.env.MONGODB_URI),
    openAfterImport,
  }));
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('probe failed', String(err?.message || err).replace(/mongodb(\+srv)?:\/\/\S+/gi, '<connection string>'));
  process.exit(1);
});
