import mongoose from 'mongoose';
import ServiceLocation from '../models/ServiceLocation.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/your_db_name';

// Raw locations from Utah_store_list_79_locations.xls
const RAW_LOCATIONS = [
  { address: '562 E. State Rd', city: 'American Fork', state: 'UT', zipCode: '84003', phone: '801-756-5333' },
  { address: '1516 East Highway 40', city: 'Ballard', state: 'UT', zipCode: '84066', phone: '435-725-5823' },
  { address: '327 W. 500 S.', city: 'Bountiful', state: 'UT', zipCode: '84010', phone: '801-292-5061' },
  { address: '692 S. Main St', city: 'Brigham City', state: 'UT', zipCode: '84302', phone: '435-723-3777' },
  { address: '707 S. Main St', city: 'Cedar City', state: 'UT', zipCode: '84720', phone: '435-865-1111' },
  { address: '1240 S. Sage Drive', city: 'Cedar City', state: 'UT', zipCode: '84720', phone: '435-867-9439' },
  { address: '300 West Parrish Lane', city: 'Centerville', state: 'UT', zipCode: '84014', phone: '801-298-3277' },
  { address: '1953 N. 2000 W.', city: 'Clinton', state: 'UT', zipCode: '84015', phone: '801-784-7952' },
  { address: '1028 E. Draper Pkwy', city: 'Draper', state: 'UT', zipCode: '84020', phone: '801-576-1961' },
  { address: '13955 South Bangerter Pkwy', city: 'Draper', state: 'UT', zipCode: '84020', phone: '801-553-7051' },
  { address: '4019 E. Pony Express Pkwy', city: 'Eagle Mountain', state: 'UT', zipCode: '84005', phone: '801-789-4166' },
  { address: '1783 W. 2700 N.', city: 'Farr West', state: 'UT', zipCode: '84404', phone: '801-737-3103' },
  { address: '609 N. Harrisville Rd', city: 'Harrisville', state: 'UT', zipCode: '84404', phone: '801-394-3000' },
  { address: '510 N. Main Street', city: 'Heber', state: 'UT', zipCode: '84032', phone: '435-654-2780' },
  { address: '13154 S. 5600 W.', city: 'Herriman', state: 'UT', zipCode: '84096', phone: '801-254-8768' },
  { address: '5146 W. Denali Park Dr.', city: 'Herriman', state: 'UT', zipCode: '84096', phone: '(801) 727-0200' },
  { address: '5248 W. 11000 N.', city: 'Highland', state: 'UT', zipCode: '84003', phone: '801-772-0808' },
  { address: '2350 E. 4500 S.', city: 'Holladay', state: 'UT', zipCode: '84117', phone: '801-278-4760' },
  { address: '1804 Murray Holladay Rd', city: 'Holladay', state: 'UT', zipCode: '84117', phone: '801-272-1962' },
  { address: '987 W State St', city: 'Hurricane', state: 'UT', zipCode: '84737', phone: '435-635-5002' },
  { address: '215 W. 200 N.', city: 'Kaysville', state: 'UT', zipCode: '84037', phone: '801-593-0117' },
  { address: '236 N. Fairfield Rd', city: 'Layton', state: 'UT', zipCode: '84041', phone: '801-544-5041' },
  { address: '1370 N. Main St', city: 'Layton', state: 'UT', zipCode: '84041', phone: '801-546-6760' },
  { address: '116 S. 850 E.', city: 'Lehi', state: 'UT', zipCode: '84043', phone: '801-766-1914' },
  { address: '625 N. State St', city: 'Lindon', state: 'UT', zipCode: '84042', phone: '801-785-8097' },
  { address: '1152 S. Main St', city: 'Logan', state: 'UT', zipCode: '84321', phone: '435-753-3999' },
  { address: '30 E. 1400 N.', city: 'Logan', state: 'UT', zipCode: '84341', phone: '435-753-8276' },
  { address: '7200 W. 3444 S.', city: 'Magna', state: 'UT', zipCode: '84044', phone: '801-508-7721' },
  { address: '1331 Fort Union Blvd', city: 'Midvale', state: 'UT', zipCode: '84121', phone: '801-943-4752' },
  { address: '7087 Bingham Junction Blvd.', city: 'Midvale', state: 'UT', zipCode: '84047', phone: '801-260-5057' },
  { address: '4949 S. State St', city: 'Murray', state: 'UT', zipCode: '84107', phone: '801-263-9066' },
  { address: '5601 S. 900 E.', city: 'Murray', state: 'UT', zipCode: '84121', phone: '801-261-4808' },
  { address: '6390 S. Highland Dr', city: 'Murray', state: 'UT', zipCode: '84121', phone: '801-278-7421' },
  { address: '2381 N. 400 E.', city: 'North Ogden', state: 'UT', zipCode: '84414', phone: '801-737-3112' },
  { address: '989 N. Hwy 89', city: 'North Salt Lake', state: 'UT', zipCode: '84054', phone: '801-296-1921' },
  { address: '192 36th St', city: 'Ogden', state: 'UT', zipCode: '84405', phone: '801-392-2665' },
  { address: '442 12th Street', city: 'Ogden', state: 'UT', zipCode: '84404', phone: '801-689-2870' },
  { address: '809 N. State St', city: 'Orem', state: 'UT', zipCode: '84057', phone: '801-764-9500' },
  { address: '91 N. State St', city: 'Orem', state: 'UT', zipCode: '84057', phone: '801-226-1150' },
  { address: '991 S. State', city: 'Orem', state: 'UT', zipCode: '84097', phone: '801-225-0703' },
  { address: '1094 W 800 S', city: 'Payson', state: 'UT', zipCode: '84651', phone: '801-658-5539' },
  { address: '290 W. 1230 N.', city: 'Provo', state: 'UT', zipCode: '84604', phone: '801-377-7636' },
  { address: '1575 N. Freedom Blvd', city: 'Provo', state: 'UT', zipCode: '84604', phone: '801-377-2072' },
  { address: '836 S. University Ave', city: 'Provo', state: 'UT', zipCode: '84601', phone: '801-370-0303' },
  { address: '3711 North 40 East', city: 'Provo', state: 'UT', zipCode: '84604', phone: '801-224-2854' },
  { address: '913 W. Riverdale Rd.', city: 'Riverdale', state: 'UT', zipCode: '84405', phone: '801-690-7682' },
  { address: '1625 W. 12600 S.', city: 'Riverton', state: 'UT', zipCode: '84065', phone: '801-446-1315' },
  { address: '13318 S. Market Center Dr', city: 'Riverton', state: 'UT', zipCode: '84065', phone: '801-676-7528' },
  { address: '4080 Midland Drive', city: 'Roy', state: 'UT', zipCode: '84067', phone: '801-731-8778' },
  { address: '3300 S. Main St.', city: 'Salt Lake City', state: 'UT', zipCode: '84115', phone: '801-487-9561' },
  { address: '804 E. 400 S.', city: 'Salt Lake City', state: 'UT', zipCode: '84102', phone: '801-363-6604' },
  { address: '757 W. North Temple', city: 'Salt Lake City', state: 'UT', zipCode: '84116', phone: '801-355-1385' },
  { address: '2102 S. Main St', city: 'Salt Lake City', state: 'UT', zipCode: '84115', phone: '801-467-1861' },
  { address: '677 E 400 S', city: 'Salt Lake City', state: 'UT', zipCode: '84102', phone: '801-355-7803' },
  { address: '1577 Foothill Dr', city: 'Salt Lake City', state: 'UT', zipCode: '84108', phone: '801-583-0290' },
  { address: '2000 E. 3302 S.', city: 'Salt Lake City', state: 'UT', zipCode: '84109', phone: '801-486-0412' },
  { address: '9045 S. 255 W.', city: 'Sandy', state: 'UT', zipCode: '84070', phone: '801-562-2035' },
  { address: '10620 S. 700 E.', city: 'Sandy', state: 'UT', zipCode: '84070', phone: '801-576-9445' },
  { address: '9400 South 2047 East', city: 'Sandy', state: 'UT', zipCode: '84093', phone: '801-845-4722' },
  { address: '284 E Crossroads Blvd', city: 'Saratoga Springs', state: 'UT', zipCode: '84043', phone: '801-766-3300' },
  { address: '3332 W. South Jordan Pkwy', city: 'South Jordan', state: 'UT', zipCode: '84095', phone: '(801) 662-0679' },
  { address: '11333 S. Redwood Rd.', city: 'South Jordan', state: 'UT', zipCode: '84095', phone: '(801) 727-7370' },
  { address: '5746 Harrison Blvd', city: 'South Ogden', state: 'UT', zipCode: '84403', phone: '801-475-4355' },
  { address: '901 Expressway Lane', city: 'Spanish Fork', state: 'UT', zipCode: '84660', phone: '801-798-3993' },
  { address: '1703 W. 400 S.', city: 'Springville', state: 'UT', zipCode: '84663', phone: '801-491-6868' },
  { address: '1287 W. Sunset Blvd', city: 'St. George', state: 'UT', zipCode: '84770', phone: '435-688-2158' },
  { address: '1393 S River Road', city: 'St. George', state: 'UT', zipCode: '84790', phone: '(435) 703-9576' },
  { address: '2097 S. 1200 E.', city: 'Sugarhouse', state: 'UT', zipCode: '84105', phone: '801-466-9789' },
  { address: '1129 W. 1700 S.', city: 'Syracuse', state: 'UT', zipCode: '84075', phone: '801-825-9300' },
  { address: '2196 W. 5400 S.', city: 'Taylorsville', state: 'UT', zipCode: '84129', phone: '801-964-6800' },
  { address: '21 W. 1280 N.', city: 'Tooele', state: 'UT', zipCode: '84074', phone: '435-882-2218' },
  { address: '199 N Geneva Rd', city: 'Vineyard', state: 'UT', zipCode: '84059', phone: '385-537-0500' },
  { address: '1064 W. Red Cliffs Dr', city: 'Washington', state: 'UT', zipCode: '84780', phone: '435-656-1200' },
  { address: '6131 S. 4800 W.', city: 'West Jordan', state: 'UT', zipCode: '84118', phone: '801-957-1057' },
  { address: '1735 W. 9000 S.', city: 'West Jordan', state: 'UT', zipCode: '84088', phone: '801-566-4075' },
  { address: '7867 S. Airport Rd', city: 'West Jordan', state: 'UT', zipCode: '84088', phone: '801-280-5505' },
  { address: '7805 Redwood Rd', city: 'West Jordan', state: 'UT', zipCode: '84088', phone: '801-562-0442' },
  { address: '3796 W. 3500 S.', city: 'West Valley', state: 'UT', zipCode: '84120', phone: '801-969-6457' },
  { address: '1850 W. 4100 S.', city: 'West Valley', state: 'UT', zipCode: '84119', phone: '801-972-3455' },
];

// Geocode using US Census Geocoder (free, no key required)
async function geocodeAddress(address: string, city: string, state: string, zip: string): Promise<[number, number] | null> {
  const query = encodeURIComponent(`${address}, ${city}, ${state} ${zip}`);
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${query}&benchmark=Public_AR_Current&format=json`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    const matches = json?.result?.addressMatches;
    if (matches && matches.length > 0) {
      const { x: lng, y: lat } = matches[0].coordinates;
      return [parseFloat(lng), parseFloat(lat)];
    }
  } catch (err) {
    console.warn(`  Geocode failed for ${address}, ${city}: ${err}`);
  }
  return null;
}

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of RAW_LOCATIONS) {
    const name = `Jiffy Lube - ${raw.city}`;
    console.log(`📍 Processing: ${name} (${raw.address})`);

    const coords = await geocodeAddress(raw.address, raw.city, raw.state, raw.zipCode);

    const doc: any = {
      name,
      address: raw.address,
      city: raw.city,
      state: raw.state,
      zipCode: raw.zipCode,
      phone: raw.phone,
      partnerName: 'Jiffy Lube',
      isActive: true,
    };

    if (coords) {
      doc.location = { type: 'Point', coordinates: coords };
      console.log(`  ✓ Geocoded: [${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}]`);
    } else {
      console.warn(`  ⚠ Could not geocode — location stored without coordinates`);
      skipped++;
    }

    // Upsert by address + city to allow safe re-runs
    const result = await ServiceLocation.findOneAndUpdate(
      { address: raw.address, city: raw.city },
      { $set: doc },
      { upsert: true, new: true }
    );

    if (result.isNew !== false) inserted++;
    else updated++;

    // Throttle to be polite to the geocoder
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n🎉 Seeding complete!');
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  No coords: ${skipped}`);

  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});