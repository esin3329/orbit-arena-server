/**
 * 정적 이미지 에셋을 HTML/SVG 원본에서 PNG 로 렌더링한다 (헤드리스 Chromium 계열 브라우저 사용).
 *
 *   node scripts/assets/render.ts
 *
 * - public/og-image.png       ← scripts/assets/og-image.html (1200×630, 링크 공유 미리보기)
 * - public/apple-touch-icon.png ← public/favicon.svg (180×180, iOS 홈 화면 아이콘)
 *
 * 브라우저 경로는 CHROME_PATH 로 지정할 수 있다. 없으면 흔한 설치 경로에서 Chrome/Edge/Chromium 을 찾는다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) throw new Error(`Chrome/Edge 를 찾지 못했습니다. CHROME_PATH 로 지정하세요.\n시도한 경로: ${CANDIDATES.join(', ')}`);

const work = mkdtempSync(join(tmpdir(), 'oa-assets-'));

function shot(htmlFile: string, out: string, width: number, height: number) {
  execFileSync(browser!, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${join(work, 'profile')}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=4000', // 웹폰트 로딩 대기
    `--screenshot=${out}`,
    pathToFileURL(htmlFile).href,
  ]);
  console.log(`✔ ${out}`);
}

try {
  shot(join(ROOT, 'scripts/assets/og-image.html'), join(ROOT, 'public/og-image.png'), 1200, 630);

  const svg = readFileSync(join(ROOT, 'public/favicon.svg'), 'utf8');
  const iconHtml = join(work, 'icon.html');
  writeFileSync(
    iconHtml,
    `<!doctype html><html><body style="margin:0;background:#0b1020">${svg.replace('<svg ', '<svg width="180" height="180" ')}</body></html>`,
  );
  shot(iconHtml, join(ROOT, 'public/apple-touch-icon.png'), 180, 180);
} finally {
  rmSync(work, { recursive: true, force: true });
}
