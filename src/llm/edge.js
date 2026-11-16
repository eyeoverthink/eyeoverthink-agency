// Edge tier: browsers running the dashboard register as inference workers. Each worker executes
// jobs with Firebase AI Logic hybrid inference (Gemini Nano on-device when available, cloud Gemini
// otherwise) and reports which path actually ran (inferenceSource: ON_DEVICE | IN_CLOUD).
// Privacy-tagged tasks can be pinned to ONLY_ON_DEVICE so their content never leaves the user's machine.
import { newId, estimateTokens } from '../core/util.js';

export class EdgeHub {
  constructor(cfg, bus) {
    this.cfg = cfg;
    this.bus = bus;
    this.workers = new Map(); // id -> { id, label, modes, lastSeen, onDevice, busy }
    this.queue = []; // pending jobs
    this.jobs = new Map(); // id -> job
    this.waiters = []; // long-poll claimers: { workerId, resolve, timer }
    this.stats = { ON_DEVICE: 0, IN_CLOUD: 0, failed: 0 };
  }

  register({ label = 'browser', onDevice = 'unknown', modes = [] } = {}) {
    const id = newId('edge');
    this.workers.set(id, { id, label: String(label).slice(0, 60), onDevice, modes, lastSeen: Date.now(), busy: false, done: 0 });
    this.bus?.publish('edge.worker', { action: 'register', id, label, onDevice });
    return { id };
  }

  heartbeat(id, info = {}) {
    const w = this.workers.get(id);
    if (!w) return false;
    w.lastSeen = Date.now();
    if (info.onDevice) w.onDevice = info.onDevice;
    return true;
  }

  liveWorkers() {
    const cutoff = Date.now() - 45000;
    for (const [id, w] of this.workers) if (w.lastSeen < cutoff) this.workers.delete(id);
    return [...this.workers.values()];
  }

  get available() { return this.cfg.enabled && this.liveWorkers().length > 0; }

  /** Long-poll: a worker waits up to waitMs for a job. */
  claim(workerId, waitMs = 25000) {
    const w = this.workers.get(workerId);
    if (!w) return Promise.resolve({ error: 'unknown worker; re-register' });
    w.lastSeen = Date.now();
    const job = this.queue.shift();
    if (job) return Promise.resolve(this.#assign(job, w));
    return new Promise((resolve) => {
      const waiter = { workerId, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        resolve({ job: null });
      }, Math.min(waitMs, 30000));
      this.waiters.push(waiter);
    });
  }

  #assign(job, worker) {
    job.status = 'running';
    job.workerId = worker.id;
    job.claimedAt = Date.now();
    worker.busy = true;
    clearTimeout(job.claimTimer);
    job.resultTimer = setTimeout(() => this.#fail(job, 'edge worker did not return a result in time'), this.cfg.resultTimeoutMs);
    return { job: { id: job.id, mode: job.mode, messages: job.messages, json: job.json, temperature: job.temperature, maxTokens: job.maxTokens } };
  }

  submit({ messages, mode = 'prefer_on_device', json = false, temperature = 0.4, maxTokens = 1024 }) {
    const job = { id: newId('ej'), messages, mode, json, temperature, maxTokens, status: 'queued', created: Date.now() };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.set(job.id, job);
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      const w = this.workers.get(waiter.workerId);
      if (w) waiter.resolve(this.#assign(job, w)); else { this.queue.push(job); }
    } else {
      this.queue.push(job);
    }
    if (job.status === 'queued') {
      job.claimTimer = setTimeout(() => {
        if (job.status === 'queued') {
          this.queue = this.queue.filter((j) => j !== job);
          this.#fail(job, 'no edge worker claimed the job');
        }
      }, this.cfg.claimTimeoutMs);
    }
    this.bus?.publish('edge.job', { id: job.id, status: job.status, mode });
    return job;
  }

  complete(workerId, jobId, { text, inferenceSource, error }) {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || job.status !== 'running') return false;
    clearTimeout(job.resultTimer);
    const w = this.workers.get(workerId);
    if (w) { w.busy = false; w.done++; w.lastSeen = Date.now(); if (inferenceSource === 'ON_DEVICE') w.onDevice = 'available'; }
    if (error) { this.#fail(job, error); return true; }
    job.status = 'done';
    const source = inferenceSource === 'ON_DEVICE' || inferenceSource === 'IN_CLOUD' ? inferenceSource : 'UNKNOWN';
    if (this.stats[source] !== undefined) this.stats[source]++;
    job.resolve({ text: String(text ?? ''), inferenceSource: source, latencyMs: Date.now() - job.created });
    this.jobs.delete(jobId);
    this.bus?.publish('edge.job', { id: jobId, status: 'done', inferenceSource: source });
    return true;
  }

  #fail(job, reason) {
    if (job.status === 'done' || job.status === 'failed') return;
    job.status = 'failed';
    clearTimeout(job.resultTimer);
    clearTimeout(job.claimTimer);
    const w = job.workerId && this.workers.get(job.workerId);
    if (w) w.busy = false;
    this.stats.failed++;
    this.jobs.delete(job.id);
    job.reject(new Error(reason));
    this.bus?.publish('edge.job', { id: job.id, status: 'failed', reason });
  }

  snapshot() {
    return { enabled: this.cfg.enabled, workers: this.liveWorkers(), queued: this.queue.length, stats: { ...this.stats } };
  }
}

/** Router-facing provider wrapper for the edge hub. Model names: edge:prefer_on_device, edge:only_on_device, ... */
export class EdgeProvider {
  constructor(hub) { this.name = 'edge'; this.hub = hub; }
  async available() { return this.hub.available; }
  async listModels() { return this.hub.available ? ['edge:prefer_on_device', 'edge:only_on_device', 'edge:prefer_in_cloud'] : []; }
  has(model) { return this.hub.available && String(model).startsWith('edge:'); }

  async chat({ model, messages, json, temperature, maxTokens }) {
    const mode = String(model).split(':')[1] || 'prefer_on_device';
    const job = this.hub.submit({ messages, mode, json, temperature, maxTokens });
    const r = await job.promise;
    return {
      text: r.text, model, provider: `edge/${r.inferenceSource}`, latencyMs: r.latencyMs, inferenceSource: r.inferenceSource,
      usage: { prompt: estimateTokens(JSON.stringify(messages)), completion: estimateTokens(r.text) },
    };
  }

  async embed() { throw new Error('edge provider does not embed'); }
}
