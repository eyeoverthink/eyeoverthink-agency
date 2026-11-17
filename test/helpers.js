// Test helpers: an isolated agency per test with a scripted model provider (deterministic, no GPU needed).
process.removeAllListeners('warning');
process.on('warning', (w) => { if (!(w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message))) console.warn(w); });

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function makeAgency(script, extra = {}) {
  const { Agency } = await import('../src/agency.js');
  const home = fs.mkdtempSync(path.join(process.env.AGENCY_TEST_DIR || os.tmpdir(), 'agency-test-'));
  const roles = ['reason', 'plan', 'code', 'fast', 'critic', 'continuity', 'dna', 'vision', 'big'];
  const agency = new Agency({
    home, apiToken: 'test-token',
    ollama: { url: 'http://127.0.0.1:9', modelsDir: '' },
    models: { ...Object.fromEntries(roles.map((r) => [r, ['scripted']])), embed: [] },
    dream: { enabled: false }, crystallize: { auto: false }, ...extra,
  });
  const calls = [];
  agency.router.addProvider({
    name: 'scripted',
    has: (m) => m === 'scripted',
    available: async () => true,
    listModels: async () => ['scripted'],
    chat: async (req) => {
      calls.push(req);
      const text = await script(req, calls.length);
      return { text: typeof text === 'string' ? text : JSON.stringify(text), model: 'scripted', provider: 'scripted', latencyMs: 1, usage: { prompt: 10, completion: 10 } };
    },
  });
  await agency.boot({ schedulers: false, resume: extra.resume ?? false });
  return { agency, calls, home, cleanup: async () => { await agency.shutdown(); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ } } };
}

/** Pull the last user message text out of a request. */
export const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === 'user')?.content || '';
export const systemOf = (req) => req.messages.find((m) => m.role === 'system')?.content || '';
