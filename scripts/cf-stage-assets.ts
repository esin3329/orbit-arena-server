import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, '.wrangler-assets');

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });

const sharedOut = join(OUT, 'shared');
mkdirSync(sharedOut, { recursive: true });
copyFileSync(join(ROOT, 'shared', 'sim.js'), join(sharedOut, 'sim.js'));
copyFileSync(join(ROOT, 'shared', 'codec.js'), join(sharedOut, 'codec.js'));

const headersPath = join(OUT, '_headers');
mkdirSync(dirname(headersPath), { recursive: true });
writeFileSync(headersPath, HEADERS, 'utf8');
console.log(`Staged Cloudflare static assets in ${OUT}`);
