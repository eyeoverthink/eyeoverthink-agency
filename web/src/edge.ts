// Edge worker: this browser tab registers with the agency and executes inference jobs through
// Firebase AI Logic hybrid inference. Private jobs arrive as only_on_device, so their text never leaves the machine.
import { api } from "./api";
import { generate, isConfigured, nanoAvailability, edgeIdentity, explainFirebaseError, type ModeName, type Source } from "./hybrid";

export type EdgeState = { running: boolean; workerId: string | null; done: number; failed: number; last: Source | null; lastError: string; onDevice: number; inCloud: number };

export class EdgeWorker {
  state: EdgeState = { running: false, workerId: null, done: 0, failed: 0, last: null, lastError: "", onDevice: 0, inCloud: 0 };
  private stopFlag = false;
  private heartbeat: number | undefined;
  constructor(private onChange: () => void) {}

  async start(): Promise<void> {
    if (this.state.running) return;
    if (!isConfigured()) throw new Error("Firebase AI Logic is not configured; see web/.env.example.");
    const reg = await api<{ id: string }>("/api/edge/register", { body: { label: navigator.userAgent.match(/Chrome\/\d+/)?.[0] || "browser", onDevice: await nanoAvailability(), ...edgeIdentity() } });
    this.state.workerId = reg.id;
    this.state.running = true;
    this.stopFlag = false;
    this.heartbeat = window.setInterval(() => { void api("/api/edge/heartbeat", { body: { id: this.state.workerId } }).catch(() => {}); }, 20000);
    this.onChange();
    void this.loop();
  }

  stop(): void {
    this.stopFlag = true;
    this.state.running = false;
    window.clearInterval(this.heartbeat);
    this.onChange();
  }

  private async loop(): Promise<void> {
    while (!this.stopFlag) {
      try {
        const r = await api<{ job: null | { id: string; mode: ModeName; messages: { role: string; content: string }[]; json: boolean }; error?: string }>(`/api/edge/claim?worker=${this.state.workerId}`);
        if (r.error) {
          // Server restarted and forgot this worker: re-register with a fresh id.
          this.state.running = false;
          window.clearInterval(this.heartbeat);
          await this.start();
          return;
        }
        if (!r.job) continue;
        const job = r.job;
        try {
          const out = await generate(job.messages, job.mode, job.json);
          this.state.done++;
          this.state.last = out.source;
          if (out.source === "ON_DEVICE") this.state.onDevice++;
          if (out.source === "IN_CLOUD") this.state.inCloud++;
          await api("/api/edge/result", { body: { worker: this.state.workerId, job: job.id, text: out.text, inferenceSource: out.source } });
        } catch (e) {
          this.state.failed++;
          this.state.lastError = explainFirebaseError(e);
          await api("/api/edge/result", { body: { worker: this.state.workerId, job: job.id, error: this.state.lastError } }).catch(() => {});
        }
        this.onChange();
      } catch (e) {
        this.state.lastError = e instanceof Error ? e.message : String(e);
        this.onChange();
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
  }
}
