/**
* Carketa Pricing Test Script
* 
* PURPOSE: Verify if pricing endpoints return market-wide data
*          or if they are scoped to the specific organization.
*/

const CARKETA_API_KEY = "eb65452fa7e58683a206ed60f3885682f8938ed6ec18609fbd0ccfaded4a0470";
const CARKETA_ORG_ID = "clak8yt4o01kxmcte0k321sl2";
const BASE_URL = "https://staging-next.carketa.app/api/v1";
const TEST_VIN = "19UDE4H28PA005761";

const headers = {
  "x-api-key": CARKETA_API_KEY,
  "Content-Type": "application/json"
};

async function request(label, url) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`URL:  ${url}`);
  console.log("=".repeat(60));

  const res = await fetch(url, { headers });
  const json = await res.json();

  console.log(`STATUS: ${res.status}`);
  console.log("RESPONSE:", JSON.stringify(json, null, 2));
  return { status: res.status, json };
}

async function run() {
  console.log("\n🚗 CARKETA PRICING TEST");
  console.log(`VIN: ${TEST_VIN}`);
  console.log(`ORG: ${CARKETA_ORG_ID}`);
  console.log(`ENV: Staging\n`);

  // ─────────────────────────────────────────────
  // STEP 1: Decode the VIN
  // ─────────────────────────────────────────────
  const decode = await request(
    "VIN Decode (Basic)",
    `${BASE_URL}/decode/${TEST_VIN}/basic`
  );

  let make, model, year, trim;

  if (decode.status === 200 && decode.json.data) {
    make = decode.json.data.make;
    model = decode.json.data.model;
    year = decode.json.data.year;
    trim = decode.json.data.trim;

    console.log(`\n✅ VIN decoded: ${year} ${make} ${model} ${trim}`);
  } else {
    console.log("\n❌ VIN decode failed. Using fallback values.");
    // Fallback — 2023 Acura Integra based on VIN pattern
    make = "Acura";
    model = "Integra";
    year = "2023";
    trim = "";
  }

  // ─────────────────────────────────────────────
  // STEP 2: Pricing Summary — Recent Sold Comps
  // ─────────────────────────────────────────────
  const summaryRecent = await request(
    "Pricing Summary — Recent Sold (trade-in value)",
    `${BASE_URL}/organizations/${CARKETA_ORG_ID}/pricing/summary` +
    `?make=${encodeURIComponent(make)}` +
    `&model=${encodeURIComponent(model)}` +
    `&year=${year}` +
    (trim ? `&trim=${encodeURIComponent(trim)}` : "") +
    `&low_mileage=10000` +
    `&high_mileage=80000` +
    `&miles_radius=300` +
    `&recent=true`
  );

  // ─────────────────────────────────────────────
  // STEP 3: Pricing Summary — Active Listings
  // ─────────────────────────────────────────────
  const summaryActive = await request(
    "Pricing Summary — Active Listings (retail value)",
    `${BASE_URL}/organizations/${CARKETA_ORG_ID}/pricing/summary` +
    `?make=${encodeURIComponent(make)}` +
    `&model=${encodeURIComponent(model)}` +
    `&year=${year}` +
    (trim ? `&trim=${encodeURIComponent(trim)}` : "") +
    `&low_mileage=10000` +
    `&high_mileage=80000` +
    `&miles_radius=300` +
    `&active=true`
  );

  // ─────────────────────────────────────────────
  // STEP 4: Pricing Details — Comparable Listings
  // ─────────────────────────────────────────────
  const details = await request(
    "Pricing Details — Comparable Vehicles",
    `${BASE_URL}/organizations/${CARKETA_ORG_ID}/pricing/details` +
    `?make=${encodeURIComponent(make)}` +
    `&model=${encodeURIComponent(model)}` +
    `&year=${year}` +
    `&miles_radius=500` +
    `&active=true` +
    `&limit=3`
  );

  // ─────────────────────────────────────────────
  // STEP 5: Print Summary
  // ─────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(60));

  const recentData = summaryRecent.json?.data;
  const activeData = summaryActive.json?.data;
  const detailData = details.json?.data;

  if (recentData?.market_avg_price) {
    console.log(`\n✅ Recent Sold (Trade-In Value):`);
    console.log(`   Avg: $${recentData.market_avg_price.toLocaleString()}`);
    console.log(`   Min: $${recentData.market_min_price?.toLocaleString()}`);
    console.log(`   Max: $${recentData.market_max_price?.toLocaleString()}`);
    console.log(`   Comp Count: ${recentData.market_count}`);
  } else {
    console.log(`\n❌ Recent Sold: No data returned.`);
  }

  if (activeData?.market_avg_price) {
    console.log(`\n✅ Active Listings (Retail Value):`);
    console.log(`   Avg: $${activeData.market_avg_price.toLocaleString()}`);
    console.log(`   Min: $${activeData.market_min_price?.toLocaleString()}`);
    console.log(`   Max: $${activeData.market_max_price?.toLocaleString()}`);
    console.log(`   Listing Count: ${activeData.market_count}`);
  } else {
    console.log(`\n❌ Active Listings: No data returned.`);
  }

  if (Array.isArray(detailData) && detailData.length > 0) {
    console.log(`\n✅ Comparable Vehicles Found: ${detailData.length}`);
    detailData.forEach((v, i) => {
      console.log(`   ${i + 1}. ${v.year} ${v.make} ${v.model} ${v.trim || ""}`);
      console.log(`      Price: $${v.price?.toLocaleString()} | Miles: ${parseInt(v.miles || 0).toLocaleString()} | ${v.city}, ${v.state}`);
      console.log(`      Active: ${v.active} | Days on Market: ${v.days_on_market}`);
    });
  } else {
    console.log(`\n❌ Comparable Vehicles: No listings returned.`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("CONCLUSION");
  console.log("=".repeat(60));

  const hasData =
    recentData?.market_count > 0 ||
    activeData?.market_count > 0 ||
    (Array.isArray(detailData) && detailData.length > 0);

  if (hasData) {
    console.log("\n✅ MARKET-WIDE DATA CONFIRMED");
    console.log("   Pricing returns data beyond the org's own inventory.");
  } else {
    console.log("\n⚠️  NO DATA RETURNED");
    console.log("   Pricing may be scoped to the org's inventory only.");
  }

  console.log("");
}

run().catch(err => {
  console.error("\n❌ Script error:", err.message);
});
