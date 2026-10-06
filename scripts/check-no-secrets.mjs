// Post-build gate. Greps the client bundle, the service worker, and the
// prerendered HTML/RSC output for anything that looks like a Supabase
// credential. Exits 1 on a hit, and exits 1 if it cannot actually verify
// anything (a check that silently skips is worse than no check).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.cwd();

function fail(message) {
  console.error(message);
  process.exit(1);
}

// 1. Refuse to pass vacuously.
//
// 8 characters is not a bar for an HMAC key or a service-role JWT.
// .env.example used to ship the literal "replace-me-32-bytes-base64" for
// both cookie secrets -- 26 characters, well past an 8-char floor, and
// public in this repository. Forging qx_seat with seat:1 gives host control
// of any game (finding S5). SUPABASE_URL is a hostname, not a secret, so it
// keeps a much lower floor; everything that is actually a key needs real
// entropy.
const MIN_LENGTHS = {
  SUPABASE_URL: 8,
  SUPABASE_SERVICE_ROLE_KEY: 32,
  QWIXX_COOKIE_SECRET: 32,
  QWIXX_IP_HASH_SECRET: 32,
};

const PLACEHOLDER_PREFIXES = ['replace-me'];

for (const [name, min] of Object.entries(MIN_LENGTHS)) {
  const value = process.env[name];
  if (!value || value.length < min) {
    fail(`Cannot verify the bundle because ${name} is unset or shorter than ${min} characters.`);
  }
  if (PLACEHOLDER_PREFIXES.some((p) => value.startsWith(p))) {
    fail(`${name} still holds the .env.example placeholder. Generate a real value.`);
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cookieSecret = process.env.QWIXX_COOKIE_SECRET;
const ipHashSecret = process.env.QWIXX_IP_HASH_SECRET;

// 2. Assert no public env leak path exists.
function walk(dir, fn) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(full, fn);
    } else {
      fn(full);
    }
  }
}

let publicEnvLeak = false;

// .env* files
for (const entry of readdirSync(root)) {
  if (entry.startsWith('.env')) {
    const content = readFileSync(join(root, entry), 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('NEXT_PUBLIC_')) {
        console.error(`Found a NEXT_PUBLIC_ variable in ${entry}: ${trimmed}`);
        publicEnvLeak = true;
      }
    }
  }
}

// process.env keys used in source
const sourceDirs = ['app', 'components', 'lib'];
const nextPublicUsagePattern = /process\.env\.NEXT_PUBLIC_[A-Z0-9_]*/g;

for (const dir of sourceDirs) {
  walk(join(root, dir), (file) => {
    const ext = extname(file);
    if (!['.ts', '.tsx', '.js', '.mjs'].includes(ext)) return;
    const content = readFileSync(file, 'utf8');
    const matches = content.match(nextPublicUsagePattern);
    if (matches) {
      console.error(`Found NEXT_PUBLIC_ usage in ${file}: ${matches.join(', ')}`);
      publicEnvLeak = true;
    }
  });
}

if (publicEnvLeak) {
  fail('This project has no legitimate NEXT_PUBLIC_ variable. Remove it before shipping.');
}

// Additional static guard: lib/supabase/server.ts is the only file that may
// import @supabase/supabase-js.
const SUPABASE_IMPORT = '@supabase/supabase-js';
let badImport = false;
for (const dir of ['app', 'components', 'lib', 'public']) {
  walk(join(root, dir), (file) => {
    const ext = extname(file);
    if (!['.ts', '.tsx', '.js', '.mjs'].includes(ext)) return;
    const relative = file.slice(root.length + 1);
    if (relative === join('lib', 'supabase', 'server.ts')) return;
    const content = readFileSync(file, 'utf8');
    if (content.includes(SUPABASE_IMPORT)) {
      console.error(`Found an import of ${SUPABASE_IMPORT} outside lib/supabase/server.ts: ${file}`);
      badImport = true;
    }
  });
}
if (badImport) {
  fail('@supabase/supabase-js must only be imported from lib/supabase/server.ts.');
}

// 3 and 4. Scan the client bundle, the service worker, and the prerendered
// HTML/RSC output.
const needles = [
  { name: 'SUPABASE_SERVICE_ROLE_KEY (full value)', value: serviceRoleKey },
  { name: 'SUPABASE_SERVICE_ROLE_KEY (first 24 chars)', value: serviceRoleKey.slice(0, 24) },
  { name: 'SUPABASE_URL', value: supabaseUrl },
  { name: 'QWIXX_COOKIE_SECRET', value: cookieSecret },
  { name: 'QWIXX_IP_HASH_SECRET', value: ipHashSecret },
  { name: 'literal "service_role"', value: 'service_role' },
  { name: 'literal "SUPABASE_SERVICE_ROLE_KEY"', value: 'SUPABASE_SERVICE_ROLE_KEY' },
  { name: 'literal "supabase-kong"', value: 'supabase-kong' },
  { name: 'literal JWT header prefix', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' },
];

// .next/static is the actual client bundle: every file there ships to the
// browser, so it is scanned unconditionally. .next/server/app is Next's
// server-side render output, most of which is Node.js server code that
// legitimately references these env var names and never reaches the
// browser. Only its *.html and *.rsc files are prerendered payloads that a
// browser can receive, per the spec's own scope for this scan.
const scanTargets = [
  { dir: join(root, '.next', 'static'), label: '.next/static', extensions: null },
  { dir: join(root, '.next', 'server', 'app'), label: '.next/server/app', extensions: ['.html', '.rsc'] },
];

let filesChecked = 0;
let hit = false;

for (const target of scanTargets) {
  walk(target.dir, (file) => {
    if (target.extensions && !target.extensions.includes(extname(file))) return;
    filesChecked++;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      return; // binary file, e.g. an image; skip
    }
    for (const needle of needles) {
      const offset = content.indexOf(needle.value);
      if (offset !== -1) {
        console.error(`Found ${needle.name} in ${file} at byte offset ${offset}.`);
        hit = true;
      }
    }
  });
}

// public/sw.js is a single file, not a directory.
const swPath = join(root, 'public', 'sw.js');
if (existsSync(swPath)) {
  filesChecked++;
  const content = readFileSync(swPath, 'utf8');
  for (const needle of needles) {
    const offset = content.indexOf(needle.value);
    if (offset !== -1) {
      console.error(`Found ${needle.name} in ${swPath} at byte offset ${offset}.`);
      hit = true;
    }
  }
}

if (hit) {
  fail('A Supabase credential was found in the client bundle. Failing the build.');
}

// The script's own header promises it exits 1 if it cannot actually verify
// anything, because a check that silently skips is worse than no check.
// walk() returning silently on a missing directory used to let that promise
// go unhonoured: with no .next/ present at all, this reported success having
// checked exactly one file (public/sw.js) and never looked at a bundle
// (finding S2, bypass A). Assert the bundle was actually there.
const MIN_FILES = 10;

if (!existsSync(join(root, '.next', 'static'))) {
  fail('Cannot verify the bundle because .next/static does not exist. Run next build first.');
}

if (filesChecked < MIN_FILES) {
  fail(
    `Cannot verify the bundle: only ${filesChecked} files were scanned, expected at least ${MIN_FILES}. ` +
      'The build output is missing or this ran from the wrong directory.',
  );
}

console.log(`No Supabase credential found in the client bundle. Checked ${filesChecked} files.`);
process.exit(0);
