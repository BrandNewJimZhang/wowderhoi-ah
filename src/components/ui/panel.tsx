import { cn } from "@/lib/utils";

export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn("border border-terminal-border bg-terminal-panel/92", className)}>{children}</section>;
}

export function PanelHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between border-b border-terminal-border px-3 font-mono text-[11px] uppercase tracking-wide text-terminal-muted">
      <span>{title}</span>
      {action}
    </div>
  );
}