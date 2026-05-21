import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Vehicle from '../src/models/Vehicle.model';
import Quote from '../src/models/Quote.model';
import Shipment from '../src/models/Shipment.model';
import User from '../src/models/User.model';

dotenv.config();

// --- DATABASE SECURITY GATEKEEPER ----
// Prevent accidental wipes of production/live data
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/vehicle-management';
const isAtlas = MONGODB_URI.includes('mongodb+srv') || MONGODB_URI.includes('mongodb.net');

if (isAtlas && process.env.ALLOW_WIPE !== 'true') {
  console.error('\n\n🚨 FATAL ERROR: DATABASE WIPE PREVENTED');
  console.error('------------------------------------------');
  console.error('The seed script is attempting to wipe a Cloud Atlas cluster.');
  console.error('To protect your data, the operation has been aborted.');
  console.error('If you actually want to re-seed, set ALLOW_WIPE=true in your environment.\n\n');
  process.exit(1);
}
// ------------------------------------

const mockVehicles = [
  {
    vin: "5J8YD4H86NL123456",
    year: 2022,
    make: "Acura",
    modelName: "MDX",
    trim: "SH-AWD W/TECH",
    color: "White",
    stockNumber: "L20294",
    price: 45990,
    marketPrice: 48000,
    mileage: 46870,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Orem, UT",
    image: "https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 12
  },
  {
    vin: "WDDUX8GB8PA123456",
    year: 2024,
    make: "Mercedes-Benz",
    modelName: "S-Class",
    trim: "S 580 4MATIC",
    color: "Black",
    stockNumber: "L21163",
    price: 110000,
    marketPrice: 115000,
    mileage: 12483,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Lehi, UT",
    image: "https://images.unsplash.com/photo-1618843479313-40f8afb4b4d8?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 5
  },
  {
    vin: "5J8TC2H51ML123456",
    year: 2021,
    make: "Acura",
    modelName: "RDX",
    trim: "SH-AWD W/A-SPEC",
    color: "Silver",
    stockNumber: "L20694",
    price: 38500,
    marketPrice: 40000,
    mileage: 96441,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Orem, UT",
    image: "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=800&h=600&fit=crop",
    status: "In Recon",
    currentStep: "Detail",
    daysOnLot: 8
  },
  {
    vin: "WAUC2AF28LN123456",
    year: 2020,
    make: "Audi",
    modelName: "A6",
    trim: "Premium Plus",
    color: "Blue",
    stockNumber: "L21009",
    price: 32900,
    marketPrice: 34500,
    mileage: 41629,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Lehi, UT",
    image: "https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 15
  },
  {
    vin: "5UXCR6C09KL123456",
    year: 2019,
    make: "BMW",
    modelName: "X5",
    trim: "xDrive40i",
    color: "White",
    stockNumber: "L20615",
    price: 42000,
    marketPrice: 44000,
    mileage: 38076,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Orem, UT",
    image: "https://images.unsplash.com/photo-1555215695-3004980ad54e?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 20
  },
  {
    vin: "1GCUKREC0JZ123456",
    year: 2018,
    make: "Chevrolet",
    modelName: "Silverado 1500",
    trim: "LT Crew Cab",
    color: "Red",
    stockNumber: "L21143",
    price: 28900,
    marketPrice: 30000,
    mileage: 116639,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Lehi, UT",
    image: "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=800&h=600&fit=crop",
    status: "In Recon",
    currentStep: "Mechanical",
    daysOnLot: 6
  },
  {
    vin: "7FARW2H89ME123456",
    year: 2021,
    make: "Honda",
    modelName: "CR-V",
    trim: "Hybrid Sport",
    color: "Gray",
    stockNumber: "L20893",
    price: 29500,
    marketPrice: 31000,
    mileage: 55997,
    transmission: "Automatic",
    fuelType: "Hybrid",
    location: "Orem, UT",
    image: "https://images.unsplash.com/photo-1590362891991-f776e747a588?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 18
  },
  {
    vin: "2T3N1RFV4LC123456",
    year: 2020,
    make: "Toyota",
    modelName: "RAV4",
    trim: "XLE Premium",
    color: "Silver",
    stockNumber: "L20846",
    price: 27800,
    marketPrice: 29000,
    mileage: 65399,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Lehi, UT",
    image: "https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 10
  },
  {
    vin: "1FTEW1E89KF123456",
    year: 2019,
    make: "Ford",
    modelName: "F-150",
    trim: "Lariat SuperCrew",
    color: "Black",
    stockNumber: "M21027",
    price: 38900,
    marketPrice: 40500,
    mileage: 163076,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Orem, UT",
    image: "https://www.automotiveaddicts.com/wp-content/uploads/2019/10/2019-ford-f-150-limited.jpg",
    status: "In Recon",
    currentStep: "Body / Paint",
    daysOnLot: 14
  },
  {
    vin: "5YJ3E1EA8NF123456",
    year: 2022,
    make: "Tesla",
    modelName: "Model 3",
    trim: "Long Range AWD",
    color: "Blue",
    stockNumber: "M19928",
    price: 42500,
    marketPrice: 44000,
    mileage: 76762,
    transmission: "Automatic",
    fuelType: "Electric",
    location: "Lehi, UT",
    image: "https://images.unsplash.com/photo-1560958089-b8a1929cea89?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 7
  },
  {
    vin: "2T2BZMCA4LC123456",
    year: 2020,
    make: "Lexus",
    modelName: "RX 350",
    trim: "F Sport",
    color: "White",
    stockNumber: "L21076",
    price: 41200,
    marketPrice: 43000,
    mileage: 63225,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Orem, UT",
    image: "https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?w=800&h=600&fit=crop",
    status: "Ready for Sale",
    currentStep: "Ready",
    daysOnLot: 22
  },
  {
    vin: "1C4RJFBG9MC123456",
    year: 2021,
    make: "Jeep",
    modelName: "Grand Cherokee",
    trim: "Limited 4WD",
    color: "Gray",
    stockNumber: "L20301",
    price: 36900,
    marketPrice: 38500,
    mileage: 69682,
    transmission: "Automatic",
    fuelType: "Gasoline",
    location: "Lehi, UT",
    image: "https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=800&h=600&fit=crop",
    status: "In Recon",
    currentStep: "Inspection",
    daysOnLot: 3
  }
];

const mockQuotes = [
  {
    firstName: "John",
    lastName: "Doe",
    email: "john.doe@example.com",
    phone: "5551234567",
    fromZip: "84057",
    toZip: "90210",
    fromAddress: "123 Main St, Orem, UT 84057",
    toAddress: "456 Oak Ave, Beverly Hills, CA 90210",
    units: 1,
    enclosedTrailer: false,
    vehicleInoperable: false,
    miles: 685,
    rate: 850,
    eta: { min: 3, max: 5 },
    status: "pending"
  },
  {
    firstName: "Jane",
    lastName: "Smith",
    email: "jane.smith@example.com",
    phone: "5559876543",
    fromZip: "84043",
    toZip: "33139",
    fromAddress: "789 Pine Rd, Lehi, UT 84043",
    toAddress: "321 Beach Blvd, Miami Beach, FL 33139",
    units: 1,
    enclosedTrailer: true,
    vehicleInoperable: false,
    miles: 2235,
    rate: 1680,
    eta: { min: 6, max: 8 },
    status: "accepted"
  },
  {
    firstName: "Robert",
    lastName: "Johnson",
    email: "robert.j@example.com",
    phone: "5555551234",
    fromZip: "84057",
    toZip: "10001",
    fromAddress: "555 Valley Dr, Orem, UT 84057",
    toAddress: "100 Broadway, New York, NY 10001",
    units: 2,
    enclosedTrailer: false,
    vehicleInoperable: false,
    miles: 1989,
    rate: 1750,
    eta: { min: 5, max: 7 },
    status: "pending"
  }
];

async function seedDatabase() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/vehicle-management';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Clear existing data
    console.log('🗑️  Clearing existing data...');
    await Vehicle.deleteMany({});
    await Quote.deleteMany({});
    await Shipment.deleteMany({});
    console.log('✅ Existing data cleared');

    // Seed Vehicles
    console.log('🚗 Seeding vehicles...');
    const vehicles = await Vehicle.insertMany(mockVehicles);
    console.log(`✅ Created ${vehicles.length} vehicles`);

    // Seed Quotes (link some to vehicles)
    console.log('📋 Seeding quotes...');
    const quotesWithVehicles = mockQuotes.map((quote, index) => {
      if (index < vehicles.length) {
        const vehicle = vehicles[index];
        return {
          ...quote,
          vehicleId: vehicle._id,
          vehicleName: `${vehicle.year} ${vehicle.make} ${vehicle.modelName}`,
          vehicleImage: vehicle.image,
          vin: vehicle.vin,
          stockNumber: vehicle.stockNumber,
          vehiclePrice: vehicle.price,
          vehicleMarketPrice: vehicle.marketPrice,
          vehicleLocation: vehicle.location,
          vehicleStatus: vehicle.status,
          daysOnLot: vehicle.daysOnLot
        };
      }
      return quote;
    });
    const quotes = await Quote.insertMany(quotesWithVehicles);
    console.log(`✅ Created ${quotes.length} quotes`);

    // Seed Shipments (create from some quotes)
    console.log('📦 Seeding shipments...');
    const shipmentsData = [
      {
        quoteId: quotes[1]._id,
        status: 'In-Route',
        origin: quotes[1].fromAddress,
        destination: quotes[1].toAddress,
        requestedPickupDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        scheduledPickup: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        pickedUp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        scheduledDelivery: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        trackingNumber: 'TRK-001-2024'
      },
      {
        quoteId: quotes[0]._id,
        status: 'Available for Pickup',
        origin: quotes[0].fromAddress,
        destination: quotes[0].toAddress,
        requestedPickupDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        scheduledPickup: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
        trackingNumber: 'TRK-002-2024'
      }
    ];
    const shipments = await Shipment.insertMany(shipmentsData);
    console.log(`✅ Created ${shipments.length} shipments`);

    // Update quotes to 'booked' for shipments
    await Quote.updateMany(
      { _id: { $in: shipmentsData.map(s => s.quoteId) } },
      { status: 'booked' }
    );

    console.log('\n🎉 Database seeded successfully!');
    console.log('\n📊 Summary:');
    console.log(`   - Vehicles: ${vehicles.length}`);
    console.log(`   - Quotes: ${quotes.length}`);
    console.log(`   - Shipments: ${shipments.length}`);

    // Close connection
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
}

// Run the seeder
seedDatabase();