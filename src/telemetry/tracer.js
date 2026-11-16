// Tracing: every mission, task, model call and tool call is a span persisted to SQLite and
// streamed live on the bus, so the dashboard can render the execution tree as it happens.
import { newId } from '../core/util.js';

export class Tracer {
  constructor(store, bus) {
    this.store = store;
    this.bus = bus;
  }

  start(name, { kind = 'internal', traceId = null, parentId = null, agentId = null, attrs = {} } = {}) {
    const span = {
      id: newId('sp'), traceId: traceId || newId('tr'), parentId, name, kind, agentId,
      status: 'running', startMs: Date.now(), endMs: null, attrs: { ...attrs },
    };
    this.store.run('INSERT INTO spans (id, trace_id, parent_id, name, kind, agent_id, status, start_ms, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      span.id, span.traceId, parentId, name, kind, agentId, 'running', span.startMs, span.attrs);
    this.bus?.publish('span.start', { span });
    const tracer = this;
    return {
      ...span,
      child(childName, opts = {}) {
        return tracer.start(childName, { ...opts, traceId: span.traceId, parentId: span.id, agentId: opts.agentId ?? agentId });
      },
      set(key, value) { span.attrs[key] = value; },
      end(status = 'ok', extra = {}) {
        Object.assign(span.attrs, extra);
        span.status = status;
        span.endMs = Date.now();
        tracer.store.run('UPDATE spans SET status = ?, end_ms = ?, attrs = ? WHERE id = ?', status, span.endMs, span.attrs, span.id);
        tracer.bus?.publish('span.end', { span: { ...span } });
        return span;
      },
      get id() { return span.id; },
      get traceId() { return span.traceId; },
    };
  }

  trace(traceId) {
    return this.store.all('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ms ASC LIMIT 5000', traceId)
      .map((r) => ({ ...r, attrs: JSON.parse(r.attrs) }));
  }

  /** Aggregate model/tool latency and failure stats for the telemetry panel. */
  stats(sinceMs = Date.now() - 24 * 3600 * 1000) {
    return this.store.all(`
      SELECT kind, name, COUNT(*) AS n,
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
             AVG(end_ms - start_ms) AS avg_ms, MAX(end_ms - start_ms) AS max_ms
      FROM spans WHERE start_ms >= ? AND end_ms IS NOT NULL
      GROUP BY kind, name ORDER BY n DESC LIMIT 200`, sinceMs);
  }
}
