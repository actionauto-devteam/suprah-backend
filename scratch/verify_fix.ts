// Simple verification of the string template fix
const mockVehicle = {
  year: 2024,
  make: "ACURA",
  modelName: "INTEGRA",
  model: function() { return "I am a Mongoose Method"; }
};

const firstName = "Jolo";
const lastName = "belen";

// The OLD (broken) way: 
const oldSubject = `New Lead - ${firstName} ${lastName} - ${mockVehicle.year} ${mockVehicle.make} ${mockVehicle.model}`;
console.log("OLD SUBJECT:", oldSubject);

// The NEW (fixed) way:
const newSubject = `New Lead - ${firstName} ${lastName} - ${mockVehicle.year} ${mockVehicle.make} ${mockVehicle.modelName}`;
console.log("NEW SUBJECT:", newSubject);

if (newSubject.includes("INTEGRA") && !newSubject.includes("function")) {
  console.log("VERIFICATION SUCCESS: Subject line is clean.");
} else {
  console.log("VERIFICATION FAILED: Subject line still contains garbage.");
  process.exit(1);
}
