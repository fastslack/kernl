/**
 * Tells the operator that agents left drafts waiting for approval, through
 * the kernel's notification channels — so drafts don't stall unseen until
 * someone opens /outbox. One notice per project per window; an item is
 * announced once (its later edits don't re-announce it).
 */
export class DraftNotifier {
  private lastByProject = new Map<string, number>();
  private announced = new Set<string>();

  constructor(
    private send: (msg: { title: string; body?: string; priority?: "low" | "normal" | "high"; source?: string }) => Promise<boolean>,
    private projectName: (projectId: string) => string,
    private now: () => number = Date.now,
    private windowMs: number = 10 * 60_000,
  ) {}

  onChanged(e: { id: string; project_id: string | null; status: string }): void {
    if (e.status !== "draft" || this.announced.has(e.id)) return;
    this.announced.add(e.id);
    const key = e.project_id ?? "__unscoped__";
    const last = this.lastByProject.get(key);
    const t = this.now();
    if (last !== undefined && t - last < this.windowMs) return;
    this.lastByProject.set(key, t);
    const name = e.project_id ? this.projectName(e.project_id) : null;
    void this.send({
      title: name ? `${name}: borrador para aprobar` : "Borrador para aprobar",
      body: `Un agente dejó un borrador${name ? ` de ${name}` : ""} esperando tu aprobación en Aprobaciones (/outbox). Nada sale sin tu ok.`,
      priority: "normal",
      source: "projects",
    }).catch(() => { /* notification channels are best-effort */ });
  }
}
