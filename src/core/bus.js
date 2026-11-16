// Hermes bus: in-process pub/sub that every subsystem publishes to.
// The HTTP server fans these events out to dashboards over Server-Sent Events.
import { EventEmitter } from 'node:events';

export class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.recent = []; // ring buffer so a freshly connected dashboard sees context
    this.max = 500;
  }

  /** Publish a typed event. Every event also goes to the '*' channel. */
  publish(type, payload = {}) {
    const event = { type, ts: Date.now(), ...payload };
    this.recent.push(event);
    if (this.recent.length > this.max) this.recent.splice(0, this.recent.length - this.max);
    this.emit(type, event);
    this.emit('*', event);
    return event;
  }

  tail(n = 100, filter = null) {
    const list = filter ? this.recent.filter(filter) : this.recent;
    return list.slice(-n);
  }
}
