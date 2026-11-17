#!/usr/bin/env node
// Verify an EyeOverThink Agency mission receipt offline. No agency, no database, no network, no dependencies.
//   node bin/verify-receipt.js receipt.json [deliverable.txt]
// Exit code 0 = every check passed, 1 = a check failed, 2 = usage error.
import fs from 'node:fs';
import { verifyReceipt } from '../src/core/receipt-verify.js';

const [file, deliverableFile] = process.argv.slice(2);
if (!file) { console.error('usage: node bin/verify-receipt.js <receipt.json> [deliverable.txt]'); process.exit(2); }
const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
const deliverable = deliverableFile ? fs.readFileSync(deliverableFile, 'utf8') : null;
const r = await verifyReceipt(receipt, { deliverable });
console.log(`Receipt for mission ${receipt.statement?.missionId} from agency key ${String(receipt.agency?.publicKey).slice(0, 16)}…`);
for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
if (r.summary) {
  const s = r.summary;
  console.log(`\nVerified contents: ${s.toolCalls} tool call(s); ${s.firebaseCalls} Firebase AI Logic call(s) (${s.firebaseInCloud} IN_CLOUD, ${s.firebaseOnDevice} ON_DEVICE); ${s.sealedCrossings} sealed crossing(s) withholding ${s.valuesWithheld} value(s); ${s.egressBlocked} egress attempt(s) blocked.`);
}
if (!deliverableFile) console.log('Tip: pass the deliverable text as a second argument to prove it was not changed.');
console.log(r.ok ? '\nVERIFIED' : '\nNOT VERIFIED');
process.exit(r.ok ? 0 : 1);
