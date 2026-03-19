#!/usr/bin/env node

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Load .env for local development ─────────────────────────────────────────
// In GitHub Actions, set LETTERBOXD_USERNAME as a repository variable instead.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return;
      const key   = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      // Only set if not already defined in the environment
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    });
}

// ─── Configuration ────────────────────────────────────────────────────────────
const USERNAME    = process.env.LETTERBOXD_USERNAME;
const OUTPUT_FILE = path.join(__dirname, 'letterboxd.json');
const RECENT_COUNT = 4;
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Convert a numeric Letterboxd rating (e.g. 3.5) to star glyphs (★★★½). */
function toStars(rating) {
  if (rating == null || rating === '') return '';
  const n = parseFloat(rating);
  if (Number.isNaN(n)) return '';
  return '★'.repeat(Math.floor(n)) + (n % 1 >= 0.5 ? '½' : '');
}

/**
 * Extract the inner text of a named XML element from a block of XML.
 * Handles namespaced tags such as letterboxd:watchedDate.
 * Strips any nested HTML/XML tags from the result.
 */
function xmlText(block, tag) {
  const escaped = tag.replace(/:/g, '\\:');
  const re = new RegExp(
    `<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`,
    'i'
  );
  const m = block.match(re);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

/**
 * Perform an HTTPS GET, following a single redirect if needed.
 * Resolves with the full response body as a UTF-8 string.
 */
function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) {
      return reject(new Error('Too many redirects'));
    }
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'trmnl-letterboxd/1.0' } },
      res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          res.resume(); // discard body
          return httpGet(location, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
  });
}

// ─── Validate username to prevent SSRF via path traversal ────────────────────
function validateUsername(username) {
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(username)) {
    throw new Error(
      `Invalid LETTERBOXD_USERNAME: "${username}". ` +
      'Only letters, numbers, hyphens, and underscores are allowed.'
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!USERNAME) {
    console.error(
      'Error: LETTERBOXD_USERNAME is not set.\n' +
      'Add it to a .env file or set it as an environment variable.'
    );
    process.exit(1);
  }

  // Validate before embedding the username in a URL
  validateUsername(USERNAME);

  const feedUrl = `https://letterboxd.com/${USERNAME}/rss/`;
  console.log(`Fetching ${feedUrl} …`);

  const xml = await httpGet(feedUrl);

  // ── Parse <item> blocks from the RSS feed ──────────────────────────────────
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const allFilms = [];
  let m;

  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];

    // letterboxd:watchedDate is only present on diary entries
    const watchedDate = xmlText(block, 'letterboxd:watchedDate');
    if (!watchedDate) continue;

    // Prefer the dedicated namespace fields; fall back to parsing <title>
    const title =
      xmlText(block, 'letterboxd:filmTitle') ||
      xmlText(block, 'title')
        .replace(/,\s*\d{4}\s*[-–].*$/, '')
        .trim();

    const ratingRaw = xmlText(block, 'letterboxd:memberRating');
    const rating = toStars(ratingRaw);

    allFilms.push({ title, rating, date: watchedDate });
  }

  // ── Filter to current year and bucket by month ─────────────────────────────
  const currentYear   = new Date().getFullYear();
  const monthlyCounts = Array(12).fill(0);
  const yearFilms     = [];

  for (const film of allFilms) {
    // Append time component so Date parses as UTC, not local midnight
    const d = new Date(`${film.date}T00:00:00Z`);
    if (d.getFullYear() !== currentYear) continue;
    monthlyCounts[d.getUTCMonth()]++;
    yearFilms.push(film);
  }

  // ── Build output ───────────────────────────────────────────────────────────
  yearFilms.sort((a, b) => b.date.localeCompare(a.date));
  const recentFilms = yearFilms
    .slice(0, RECENT_COUNT)
    .map(({ title, rating }) => ({ title, rating }));

  const totalYear  = monthlyCounts.reduce((a, b) => a + b, 0);
  // Guard against an empty year so we never divide by zero
  const maxMonthly = Math.max(...monthlyCounts, 1);

  const months = MONTH_LABELS.map((label, i) => ({
    label,
    count:      monthlyCounts[i],
    height_pct: Math.round((monthlyCounts[i] / maxMonthly) * 100),
  }));

  const output = {
    year:         currentYear,
    total_year:   totalYear,
    max_monthly:  maxMonthly,
    months,
    recent_films: recentFilms,
    updated_at:   new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Written → ${OUTPUT_FILE}`);
  console.log(`${currentYear}: ${totalYear} film(s) logged.`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
