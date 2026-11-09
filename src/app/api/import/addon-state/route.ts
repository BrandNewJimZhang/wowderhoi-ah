// The between-scan import. The scan route owns the market observation;
// this route owns the private state, the append-only journal facts and the
// game's plan. Each domain is idempotent, so a watcher restart can resend
// the whole document without duplicating anything.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyEstate, applyJournal, applyPlan, refreshHoldings } from "@/lib/state-import";

export async function POST(request: Request) {
  const payload = (await request.json()) as Record<string, unknown>;
  const scan = payload.scan as Record<string, unknown> | undefined;
  const realm = typeof payload.server === "string" ? payload.server : scan?.server;
  const faction = typeof payload.faction === "string" ? payload.faction : scan?.faction;
  if (typeof realm !== "string" || realm === "" || typeof faction !== "string" || faction === "") {
    return NextResponse.json(
      { error: "State payload must name its server and faction" },
      { status: 400 }
    );
  }
  const market = await prisma.market.findUnique({
    where: { realm_faction: { realm, faction } },
    select: { id: true }
  });
  if (!market) {
    return NextResponse.json(
      { error: `No market for ${realm}|${faction}; import a scan first` },
      { status: 400 }
    );
  }
  const source = typeof payload.source === "string" ? payload.source : "api";
  const startedAt = Date.now();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const estate = payload.estate === undefined || payload.estate === null
        ? { changed: false, revision: 0 }
        : await applyEstate(tx, market.id, payload.estate);
      const journalPresent = payload.journal !== undefined && payload.journal !== null;
      const journal = journalPresent
        ? await applyJournal(tx, market.id, payload.journal)
        : { changed: false, events: 0, trades: 0, errors: 0, characters: [] as string[] };
      // An estate-only update still changes the holdings read model.
      if (estate.changed && !journalPresent) {
        await refreshHoldings(tx, market.id);
      }
      const generation = await tx.marketGeneration.findFirst({
        where: { marketId: market.id },
        orderBy: { scannedAt: "desc" },
        select: { id: true, phase: true }
      });
      const plan = payload.plan === undefined || payload.plan === null
        ? { created: false, revision: null as string | null }
        : await applyPlan(
            tx,
            market.id,
            realm,
            faction,
            payload.plan,
            generation?.id ?? null,
            generation?.phase ?? "steady"
          );
      const changed = estate.changed || journal.changed || plan.created;
      if (changed) {
        await tx.market.update({
          where: { id: market.id },
          data: { dataVersion: { increment: 1 } }
        });
      }
      return { estate, journal, plan, changed };
    }, { timeout: 120_000 });

    await prisma.importRun.create({
      data: {
        marketId: market.id,
        scannedAt: new Date(),
        source,
        scanItems: 0,
        seriesPoints: 0,
        quotes: 0,
        journalEvents: result.journal.events,
        journalErrors: result.journal.errors,
        durationMs: Date.now() - startedAt,
        status: result.changed ? "ok" : "duplicate"
      }
    }).catch((error) => console.error("Failed to record state import:", error));

    return NextResponse.json({
      status: "ok",
      changed: result.changed,
      estateRevision: result.estate.revision,
      journalEvents: result.journal.events,
      trades: result.journal.trades,
      journalErrors: result.journal.errors,
      characters: result.journal.characters,
      planRevision: result.plan.revision,
      marketId: market.id
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}
