#!/usr/bin/env node
/**
 * Question bank validator CLI.
 * Run: npm run validate
 * Checks schema, ids, answers, explanations, analogies and try-again minis
 * for every question in questions/bank/*.json
 *
 * The rules themselves live in shared/validate.js so the browser upload screen
 * and the server give exactly the same verdict as this command.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuestions } from '../shared/validate.js';
import { UNITS } from '../shared/units.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BANK_DIR = join(HERE, 'bank');

export { UNITS };

export function loadBank() {
  const files = readdirSync(BANK_DIR).filter((f) => f.endsWith('.json')).sort();
  const all = [];
  for (const f of files) {
    const raw = readFileSync(join(BANK_DIR, f), 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${f}: invalid JSON - ${e.message}`);
    }
    if (!Array.isArray(data)) throw new Error(`${f}: top level must be an array`);
    for (const q of data) all.push(q);
  }
  return all;
}

export function validate(questions) {
  const { errors, warnings, perUnit, count } = validateQuestions(questions, { coverage: true });
  return { errors, warnings, perUnit, count };
}

function main() {
  let questions;
  try {
    questions = loadBank();
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
  const { errors, warnings, perUnit, count } = validate(questions);
  console.log(`\nQuestion bank: ${count} questions`);
  for (const u of UNITS) console.log(`  Unit ${u.id} - ${u.name}: ${perUnit[u.id] || 0}`);
  if (warnings.length) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach((w) => console.log('  ! ' + w));
  }
  if (errors.length) {
    console.log(`\nERRORS (${errors.length}):`);
    errors.forEach((e) => console.log('  x ' + e));
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
