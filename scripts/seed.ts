import { prisma } from "@/lib/prisma";

// Seeds only the phase/event calendar. Market data comes exclusively
// from real addon scans via /api/import/addon-scan — no synthetic rows.
async function main() {
  await prisma.event.deleteMany();
  // TBC Anniversary roadmap: phase 2 live 2026-05-14; summer/autumn dates
  // are announced windows, refine when Blizzard fixes exact days.
  await prisma.event.createMany({
    data: [
      { eventType: "phase", eventName: "P2 Overlords of Outland (SSC/TK)", startTime: new Date("2026-05-14T22:00:00.000Z"), endTime: new Date("2026-05-14T23:59:59.000Z") },
      { eventType: "phase", eventName: "P3 Hyjal & Black Temple (est.)", startTime: new Date("2026-08-15T00:00:00.000Z"), endTime: new Date("2026-08-15T23:59:59.000Z") },
      { eventType: "phase", eventName: "P4 Zul'Aman (est.)", startTime: new Date("2026-10-15T00:00:00.000Z"), endTime: new Date("2026-10-15T23:59:59.000Z") },
      { eventType: "reset", eventName: "Weekly raid reset (recurring Thu)", startTime: new Date("2026-07-23T07:00:00.000Z"), endTime: new Date("2026-07-23T08:00:00.000Z") }
    ]
  });
  console.log("Seeded phase calendar. Market data arrives via addon scans.");
}

void main().finally(async () => prisma.$disconnect());
