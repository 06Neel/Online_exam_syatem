// One place that decides where this app's private data lives.
//
// DATA_DIR (env or .env) lets any host point the app at a durable folder:
//   DATA_DIR=/var/lib/python-adventure  node server/index.js
// Default: server/data inside the repo.
//
// loadEnv() runs at import time here so DATA_DIR from .env is visible to every
// module that computes a storage path - ES imports are evaluated before
// index.js's own top-level loadEnv() call, so the .env must be read here too
// (loadEnv is idempotent: a later call is a no-op).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = resolve(process.env.DATA_DIR || join(HERE, 'data'));
export const TEACHERS_FILE = join(DATA_DIR, 'teachers.json');
export const TEACHERS_DIR = join(DATA_DIR, 'teachers');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const TRASH_DIR = join(DATA_DIR, 'trash');
