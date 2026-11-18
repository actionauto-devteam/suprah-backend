/**
 * Service Network: correct the partner locations' map pins (2026-11-18).
 *
 * The April import placed the pins with a free OpenStreetMap search, which
 * for about a third of the Utah stores found nothing (0,0, off the coast of
 * Africa) or only the street or city, up to a few miles from the shop. This
 * looks every store's address up again (services/storeLocationPin.service.ts:
 * US Census, then Amazon where it's switched on) and moves a pin only to a
 * match to the house itself, in the store's own state and ZIP code.
 *
 * Only the pin (location.coordinates) changes. Nothing is deleted or
 * re-imported, and a pin that changed after the lookup is left alone. Stores
 * without a house match keep their pin and are listed to check on a map (the
 * website doesn't show a 0,0 pin). A failed lookup is listed too: run again.
 *
 * Dry run (default):  npx ts-node --transpile-only src/scripts/fix-service-location-pins.ts
 * Apply:              npx ts-node --transpile-only src/scripts/fix-service-location-pins.ts --apply
 */
import '../config/productionDbGuard';
import dns from 'node:dns';
import mongoose from 'mongoose';
import config from '../config';
import ServiceLocation from '../models/ServiceLocation.model';
import { amazonPlacesSettings } from '../services/amazonPlaces.service';
import { findStorePin, planStorePin, type LngLat } from '../services/storeLocationPin.service';

// Same DNS setup as server.ts: some networks refuse the database address
// lookup (querySrv ECONNREFUSED) unless public DNS servers are used.
dns.setServers(['8.8.8.8', '1.1.1.1']);
dns.setDefaultResultOrder('ipv4first');

const APPLY = process.argv.includes('--apply');
// Gentle on the free Census address lookup.
const PAUSE_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const miles = (meters: number) => `${(meters / 1609.344).toFixed(2)} mi`;

type StoreRow = {
  _id: mongoose.Types.ObjectId;
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  location?: { coordinates?: unknown };
};

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  const amazon = amazonPlacesSettings();
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to save the new pins)'}. Amazon lookups: ${amazon.enabled ? 'on' : 'off (Census only)'}.`);

  const stores = await ServiceLocation.find({}, { name: 1, address: 1, city: 1, state: 1, zipCode: 1, location: 1 })
    .sort({ city: 1, address: 1 })
    .lean<StoreRow[]>();

  const moves: Array<{ _id: mongoose.Types.ObjectId; from: unknown; to: LngLat }> = [];
  const counts = { keep: 0, move: 0, check: 0 };

  for (const store of stores) {
    const label = `${store.name || store.city || 'Store'} (${store._id})`;
    const address = {
      address: String(store.address ?? '').trim(),
      city: String(store.city ?? '').trim(),
      state: String(store.state ?? '').trim(),
      zipCode: String(store.zipCode ?? '').trim(),
    };
    const current = store.location?.coordinates;
    if (!address.address || !address.city || !address.state) {
      counts.check += 1;
      console.log(`CHECK ${label}: the address is incomplete, so it can't be looked up.`);
      continue;
    }

    const plan = planStorePin(current, await findStorePin(address, { amazon }));
    counts[plan.action] += 1;
    if (plan.action === 'move') {
      moves.push({ _id: store._id, from: current, to: plan.to });
      const distance = plan.movedMeters === null ? 'it had no usable pin' : `moves ${miles(plan.movedMeters)}`;
      console.log(`MOVE  ${label}: ${distance}; ${plan.source} matched "${plan.matched}" at ${plan.to[1]}, ${plan.to[0]}`);
    } else if (plan.action === 'check') {
      const why = plan.reason === 'lookup-failed' ? 'the lookup failed, run again' : 'no match to the house';
      console.log(`CHECK ${label}: ${why}; ${plan.hasPin ? 'its current pin stays' : 'it has no usable pin, so the website hides it'}.`);
    }
    await sleep(PAUSE_MS);
  }

  console.log(`\n${stores.length} stores: ${counts.keep} already right, ${counts.move} to move, ${counts.check} to check on a map.`);

  if (APPLY && moves.length) {
    const result = await ServiceLocation.bulkWrite(
      moves.map((move) => ({
        updateOne: {
          // Only if the pin is still the one that was looked at.
          filter: Array.isArray(move.from)
            ? { _id: move._id, 'location.coordinates': move.from }
            : { _id: move._id, 'location.coordinates': { $exists: false } },
          update: { $set: { 'location.type': 'Point', 'location.coordinates': move.to } },
        },
      })),
      { ordered: false },
    );
    const skipped = moves.length - result.modifiedCount;
    console.log(`Saved ${result.modifiedCount} pins.${skipped ? ` ${skipped} changed after the lookup and were left alone; run again to recheck them.` : ''}`);
  } else if (!APPLY && moves.length) {
    console.log('Nothing was saved. Run again with --apply to save the moves.');
  }
};

run()
  .catch((error) => {
    console.error('Fixing the service location pins failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
