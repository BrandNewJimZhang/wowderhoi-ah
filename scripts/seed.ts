import { prisma } from "@/lib/prisma";

// Seeds only the phase/event calendar. Market data comes exclusively
// from real addon scans via /api/import/addon-scan — no synthetic rows.
//
// Forever has no machine-readable phase calendar yet, and carrying the TBC
// Anniversary dates onto this branch would put wrong events on the homepage.
// The seed therefore only clears stale rows; add Forever phases as the
// server announces them (prisma.event.createMany), or leave the homepage's
// explicit empty state in place.
async function main() {
  await prisma.event.deleteMany();
  console.log("Cleared the event calendar. Forever phases are added when announced.");
}

void main().finally(async () => prisma.$disconnect());
