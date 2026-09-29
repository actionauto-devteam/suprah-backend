/**
 * The DealersCloud feed never changes a vehicle that is on a load ("In
 * Transit" from pickup to delivery): it keeps its status, and it isn't marked
 * sold when it drops out of the feed. Everything else syncs as before.
 */
import mongoose from 'mongoose';
import Vehicle from '../src/models/Vehicle.model';
import FeedConfig from '../src/models/FeedConfig.model';
import { syncFeed } from '../src/services/dealersCloudFeed.service';

const FEED_ID = 'inventory-feed-protect-test';
const ORG_ID = new mongoose.Types.ObjectId().toString();
const VIN = {
  onLoad: 'FEEDPROTECT000001',
  inRecon: 'FEEDPROTECT000002',
  goneWhileOnLoad: 'FEEDPROTECT000003',
  gone: 'FEEDPROTECT000004',
  fresh: 'FEEDPROTECT000005',
};

async function cleanUp() {
  await Vehicle.deleteMany({ vin: { $in: Object.values(VIN) } });
  await FeedConfig.deleteMany({ feedId: FEED_ID });
}

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await FeedConfig.create({
    feedId: FEED_ID,
    organizationId: ORG_ID,
    missingStrategy: 'mark-sold',
    defaultStatus: 'Ready for Sale',
  });
  const base = { organizationId: ORG_ID, year: 2020, make: 'Ford', modelName: 'F-150', price: 30000, isDeleted: false };
  await Vehicle.create([
    { ...base, vin: VIN.onLoad, status: 'In Transit' },
    { ...base, vin: VIN.inRecon, status: 'In Recon' },
    { ...base, vin: VIN.goneWhileOnLoad, status: 'In Transit' },
    { ...base, vin: VIN.gone, status: 'Ready for Sale' },
  ]);
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/action-auto-test');
  }
  await cleanUp();
  await mongoose.disconnect();
});

describe('Inventory feed and vehicles on a load', () => {
  it('keeps a moving vehicle In Transit while the rest of the feed syncs as usual', async () => {
    const feed = [
      'VIN\tYear\tMake\tModel\tPrice',
      `${VIN.onLoad}\t2020\tFord\tF-150\t31000`,
      `${VIN.inRecon}\t2021\tToyota\tCamry\t22000`,
      `${VIN.fresh}\t2022\tHonda\tCivic\t19000`,
    ].join('\n');

    const result = await syncFeed(FEED_ID, feed);
    expect(result).toMatchObject({ parsed: 3, inserted: 1 });

    const byVin = new Map(
      (await Vehicle.find({ vin: { $in: Object.values(VIN) } }).lean()).map((vehicle: any) => [vehicle.vin, vehicle]),
    );
    // On a load: status kept, other details still updated.
    expect(byVin.get(VIN.onLoad)).toMatchObject({ status: 'In Transit', price: 31000 });
    // Not on a load: the feed's status applies as before.
    expect(byVin.get(VIN.inRecon)).toMatchObject({ status: 'Ready for Sale', price: 22000 });
    expect(byVin.get(VIN.fresh)).toMatchObject({ status: 'Ready for Sale', organizationId: ORG_ID });
    // Missing from the feed: sold as before, unless it's on a load.
    expect(byVin.get(VIN.goneWhileOnLoad)).toMatchObject({ status: 'In Transit' });
    expect(byVin.get(VIN.gone)).toMatchObject({ status: 'Sold' });
  });
});
