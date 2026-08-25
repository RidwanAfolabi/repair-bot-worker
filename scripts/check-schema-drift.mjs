#!/usr/bin/env node
/**
 * check-schema-drift.mjs — compare LIVE D1 against what initDb() would create.
 *
 * WHY THIS EXISTS: the test suite cannot catch this class of bug, ever.
 * Locally, D1 is created fresh by initDb() on every run, so it always has the
 * newest schema and every test passes. Production D1 is accumulated, and
 * `CREATE TABLE IF NOT EXISTS` never alters a table that already exists.
 *
 * That is exactly how `intakes.branch` shipped: green locally, and in
 * production every booking failed with
 *   D1_ERROR: table intakes has no column named branch
 * while the customer was told their booking was confirmed.
 *
 * Read-only. Runs one query against remote D1 and changes nothing.
 *
 *   node scripts/check-schema-drift.mjs
 *
 * Exit code 0 = live schema has every column the code expects.
 * Exit code 1 = drift found; the fix is printed as a ready-to-run ALTER.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DB = 'repair-bot-db';

// ── What the code expects ────────────────────────────────────────────────────
// Parsed straight out of db.js's CREATE TABLE statements rather than
// duplicated here, so this check cannot drift from the source of truth.
function expectedSchema() {
  const src = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  const tables = {};

  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\)/g)) {
    const [, table, body] = m;
    const columns = body
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('--'))
      .map(l => l.match(/^(\w+)\s/)?.[1])
      .filter(Boolean)
      // table-level constraints, not columns
      .filter(c => !['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT'].includes(c.toUpperCase()));
    if (columns.length) tables[table] = columns;
  }
  return tables;
}

// ── What production actually has ─────────────────────────────────────────────
function liveSchema() {
  // Single quoted command string rather than an argv array: on Windows the
  // shell splits an unquoted SQL argument on every space.
  const sql = "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command "${sql}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const rows = parsed[0]?.results ?? [];

  const tables = {};
  for (const { name, sql } of rows) {
    const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
    tables[name] = body
      .split(',')
      .map(l => l.trim().split(/\s+/)[0])
      .filter(c => c && !['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT'].includes(c.toUpperCase()));
  }
  return tables;
}

// ── Compare ──────────────────────────────────────────────────────────────────
const expected = expectedSchema();
const live     = liveSchema();
const problems = [];

for (const [table, columns] of Object.entries(expected)) {
  if (!live[table]) {
    problems.push({ table, missing: columns, tableMissing: true });
    continue;
  }
  const missing = columns.filter(c => !live[table].includes(c));
  if (missing.length) problems.push({ table, missing });
}

if (problems.length === 0) {
  const n = Object.keys(expected).length;
  console.log(`✅ No schema drift — live D1 has every column the code expects (${n} tables checked).`);
  process.exit(0);
}

console.error('❌ SCHEMA DRIFT — the deployed code expects columns production does not have.\n');
for (const p of problems) {
  if (p.tableMissing) {
    console.error(`   ${p.table}: table does not exist in production at all`);
    console.error(`     → it will be created by initDb() on the next request\n`);
    continue;
  }
  console.error(`   ${p.table}: missing ${p.missing.join(', ')}`);
  for (const col of p.missing) {
    console.error(`     → npx wrangler d1 execute ${DB} --remote --command "ALTER TABLE ${p.table} ADD COLUMN ${col} TEXT"`);
  }
  console.error('');
}
console.error('Run the ALTER(s) above BEFORE deploying, or every write to those tables will fail.');
process.exit(1);
