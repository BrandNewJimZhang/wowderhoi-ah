// Every panel carries the same chrome; the dashboard, item, portfolio and
// review pages all render it bare, so there is no className escape hatch to
// keep in sync.
export function Panel({ children }: { children: React.ReactNode }) {
  return <section className="border border-terminal-border bg-terminal-panel/92">{children}</section>;
}

export function PanelHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between border-b border-terminal-border px-3 font-mono text-[11px] uppercase tracking-wide text-terminal-muted">
      <span>{title}</span>
      {action}
    </div>
  );
}