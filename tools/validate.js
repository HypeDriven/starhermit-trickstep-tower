'use strict';

// Offline content validator: proves legality, reachable goals, bounded shape,
// and absence of soft locks for every shipped level. Also verifies the
// StarHermit packaging contract (starhermit.txt, launch file, server script).

import fs from 'node:fs';
import { validateAll, CONTENT_VERSION, TUTORIALS, JOURNEY_COUNT, CHALLENGES, THEMES } from '../src/content.js';

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL:', msg); };
const ok = (msg) => console.log('ok:', msg);

// 1. Packaging contract
const sh = fs.existsSync('starhermit.txt') ? fs.readFileSync('starhermit.txt', 'utf8') : '';
if (!sh) fail('starhermit.txt missing');
const fields = Object.fromEntries(sh.trim().split('\n').map(l => l.split('=').map(s => s.trim())));
if (fields.name !== 'Trickstep Tower') fail('starhermit name mismatch');
if (!fields.launch || !fs.existsSync(fields.launch)) fail('launch file missing: ' + fields.launch);
else ok('launch file exists: ' + fields.launch);
if (!fields.server || !fs.existsSync(fields.server)) fail('server script missing: ' + fields.server);
else ok('server script exists: ' + fields.server);

// 2. index.html references only local resources
const html = fs.readFileSync('index.html', 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
for (const r of refs) {
  if (/^https?:/.test(r)) fail('external resource in index.html: ' + r);
  else if (!fs.existsSync(r.replace(/^\.\//, ''))) fail('missing local resource: ' + r);
}
ok('index.html resources all local (' + refs.length + ' refs)');

// 3. Content validation
const report = validateAll();
for (const r of report) {
  if (!r.ok) fail(r.id + ': ' + r.errors.join(', '));
}
ok('validated ' + report.length + ' levels (' + TUTORIALS.length + ' tutorials, ' + JOURNEY_COUNT + ' journey, ' + CHALLENGES.length + ' challenges, 1 daily sample)');

// 4. Content inventory requirements
if (JOURNEY_COUNT < 40) fail('fewer than 40 journey stages');
if (THEMES.length < 5) fail('fewer than 5 themes');
if (TUTORIALS.length < 1) fail('no tutorial sequence');
ok('inventory: 40 stages, 5 themes, tutorials, daily, challenges');

if (failures) { console.error('\n' + failures + ' validation failure(s)'); process.exit(1); }
console.log('\nAll validators passed.');
