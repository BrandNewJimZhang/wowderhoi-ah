import Link from "next/link";
import { getNavigationBadges } from "@/lib/market-read";
import { ensureSavedvarsWatcher } from "@/lib/watcher/autostart";
import { AutoRefresh } from "@/components/auto-refresh";

// One navigation surface for every page. Desktop gets a persistent rail;
// mobile gets a horizontal strip. The badge counts come from the latest
// materialised generation, not from a second market evaluation. The
// revision is the one the page itself rendered from, so the auto-refresh
// poll compares against the data on screen rather than a later read.
type AppShellSection = "/" | "/market" | "/portfolio" | "/review" | "/recipes" | "/health";

export async function AppShell({ active, revision, children }: {
  active: AppShellSection;
  revision: string;
  children: React.ReactNode;
}) {
  // The first server render is the app's Node lifecycle point.
  ensureSavedvarsWatcher();
  const badges = await getNavigationBadges();
  const linkClass = (href: string) =>
    href === active
      ? "flex items-center justify-between gap-2 border border-terminal-amber/60 bg-terminal-panel2 px-3 py-2 text-terminal-amber"
      : "flex items-center justify-between gap-2 border border-transparent px-3 py-2 text-terminal-muted hover:border-terminal-border hover:text-slate-200";
  return (
    <div className="min-h-screen bg-terminal-bg text-slate-200 lg:flex">
      <nav className="sticky top-0 z-20 border-b border-terminal-border bg-terminal-panel px-2 py-2 font-mono text-xs lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-44 lg:shrink-0 lg:flex-col lg:border-b-0 lg:border-r lg:px-2 lg:py-3">
        <div className="mb-2 hidden px-3 text-[10px] uppercase tracking-widest text-terminal-muted lg:block">WoWderhoi</div>
        <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          <Link href="/" className={linkClass("/")}>
            <span>驾驶舱</span>
            {badges.actions > 0 && <span className="rounded-sm bg-terminal-amber/20 px-1 text-[10px] text-terminal-amber">{badges.actions}</span>}
          </Link>
          <Link href="/market" className={linkClass("/market")}>
            <span>市场</span>
            {badges.stale > 0 && <span className="rounded-sm bg-terminal-panel2 px-1 text-[10px]">{badges.stale}</span>}
          </Link>
          <Link href="/portfolio" className={linkClass("/portfolio")}>
            <span>持仓</span>
            {badges.positions > 0 && <span className="rounded-sm bg-terminal-panel2 px-1 text-[10px]">{badges.positions}</span>}
          </Link>
          <Link href="/review" className={linkClass("/review")}><span>复盘</span></Link>
          <Link href="/recipes" className={linkClass("/recipes")}><span>制造</span></Link>
          <Link href="/health" className={linkClass("/health")}><span>数据</span></Link>
        </div>
        <AutoRefresh revision={revision} />
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
