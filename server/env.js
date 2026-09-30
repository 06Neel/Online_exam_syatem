// Tiny .env loader - no dependencies. Reads <root>/.env into process.env.
// Real environment variables always win over values found in the file.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return {};
  const found = {};
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`[env] could not read ${file}: ${e.message}`);
    return found;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    found[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return found;
}
