#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2026-03-10';
const DEFAULT_OWNER = 'TheBoredTeam';
const DEFAULT_OUTPUT_ROOT = 'projects';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function parseRepositoryList(value, owner = DEFAULT_OWNER) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9-]+$/.test(owner)) {
    throw new Error(`Invalid GitHub owner: ${owner}`);
  }

  const entries = String(value || '')
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) throw new Error('STAR_HISTORY_REPOSITORIES repository list is required');

  const seen = new Set();
  return entries.filter((name) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`Invalid repository name: ${name}`);
    }
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  }).map((name) => ({ name, repository: `${owner}/${name}` }));
}

export function parseLinkHeader(value) {
  const links = {};
  for (const part of (value || '').split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestPage(url, token, fetchImpl, sleepImpl = defaultSleep) {
  let lastError;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github.star+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'TheBoredTeam-star-history-updater',
          'X-GitHub-Api-Version': API_VERSION,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleepImpl(2 ** attempt * 1_000);
        continue;
      }
      break;
    }

    if (response.ok) return response;

    const detail = (await response.text()).trim().slice(0, 300);
    lastError = new Error(`GitHub API returned ${response.status}: ${detail}`);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 3) break;
    await sleepImpl(2 ** attempt * 1_000);
  }

  throw lastError || new Error('GitHub API request failed');
}

async function readStargazerPage(response, page) {
  const entries = await response.json();
  if (!Array.isArray(entries)) {
    throw new Error(`GitHub stargazers page ${page} was not an array`);
  }

  return entries.map((entry, index) => {
    if (typeof entry?.starred_at !== 'string') {
      throw new Error(
        `GitHub stargazers page ${page} item ${index + 1} did not include starred_at`,
      );
    }
    return entry.starred_at;
  });
}

export async function fetchAllStargazers({
  repository,
  token,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
}) {
  if (!token) throw new Error('STAR_HISTORY_GITHUB_TOKEN is required');

  const endpoint = new URL(`https://api.github.com/repos/${repository}/stargazers`);
  endpoint.searchParams.set('per_page', '100');
  endpoint.searchParams.set('page', '1');

  const firstResponse = await requestPage(endpoint, token, fetchImpl, sleepImpl);
  const links = parseLinkHeader(firstResponse.headers.get('link'));
  const lastPage = links.last
    ? Number.parseInt(new URL(links.last).searchParams.get('page') || '1', 10)
    : 1;

  if (!Number.isInteger(lastPage) || lastPage < 1) {
    throw new Error(`GitHub returned an invalid last page: ${lastPage}`);
  }

  const timestamps = await readStargazerPage(firstResponse, 1);
  for (let page = 2; page <= lastPage; page += 1) {
    endpoint.searchParams.set('page', String(page));
    const response = await requestPage(endpoint, token, fetchImpl, sleepImpl);
    timestamps.push(...(await readStargazerPage(response, page)));

    if (page % 50 === 0 || page === lastPage) {
      console.log(`Fetched stargazer page ${page}/${lastPage} for ${repository}`);
    }
  }

  return timestamps;
}

function assertValidDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}

export function buildDailySeries(timestamps, asOf = new Date()) {
  if (!Array.isArray(timestamps)) throw new Error('timestamps must be an array');
  assertValidDate(asOf, 'asOf');

  const today = asOf.toISOString().slice(0, 10);
  if (timestamps.length === 0) return [{ date: today, stars: 0 }];

  const byDay = new Map();
  for (const timestamp of timestamps) {
    const instant = new Date(timestamp);
    if (Number.isNaN(instant.getTime())) {
      throw new Error(`Invalid starred_at timestamp: ${timestamp}`);
    }
    const day = instant.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  let total = 0;
  const series = [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, count]) => {
      total += count;
      return { date, stars: total };
    });

  if (today > series.at(-1).date) series.push({ date: today, stars: total });
  return series;
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function niceMaximum(value) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function formatDateTick(timestamp, spanDays) {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    ...(spanDays > 365 ? { year: 'numeric' } : { day: 'numeric' }),
    timeZone: 'UTC',
  }).format(date);
}

function formatNumber(value) {
  return value.toLocaleString('en-US');
}

function formatUpdatedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid generatedAt date: ${value}`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function renderStarHistorySvg(
  series,
  { repository, theme = 'light', generatedAt = series.at(-1)?.date } = {},
) {
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error('Cannot render an empty star history series');
  }
  if (theme !== 'light' && theme !== 'dark') throw new Error(`Unknown chart theme: ${theme}`);

  const palette = theme === 'dark'
    ? {
        background: '#0d1117',
        border: '#30363d',
        grid: '#21262d',
        line: '#58a6ff',
        muted: '#8b949e',
        text: '#f0f6fc',
      }
    : {
        background: '#ffffff',
        border: '#d0d7de',
        grid: '#d8dee4',
        line: '#0969da',
        muted: '#656d76',
        text: '#1f2328',
      };

  const width = 960;
  const height = 480;
  const margin = { top: 86, right: 42, bottom: 62, left: 84 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const firstTime = Date.parse(`${series[0].date}T00:00:00Z`);
  const lastTime = Date.parse(`${series.at(-1).date}T00:00:00Z`);
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) {
    throw new Error('Star history series contains an invalid date');
  }

  const timeSpan = Math.max(86_400_000, lastTime - firstTime);
  const spanDays = timeSpan / 86_400_000;
  const total = series.at(-1).stars;
  const yMaximum = niceMaximum(total);
  const xFor = (timestamp) => margin.left + ((timestamp - firstTime) / timeSpan) * plotWidth;
  const yFor = (stars) => margin.top + plotHeight - (stars / yMaximum) * plotHeight;

  const points = series.map(({ date, stars }) => {
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || !Number.isFinite(stars) || stars < 0) {
      throw new Error(`Invalid star history point: ${date}/${stars}`);
    }
    return { x: xFor(timestamp), y: yFor(stars) };
  });
  const linePath = points
    .map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  const baseline = margin.top + plotHeight;
  const areaPath = `${linePath} L${points.at(-1).x.toFixed(2)},${baseline.toFixed(2)} L${points[0].x.toFixed(2)},${baseline.toFixed(2)} Z`;

  const yTicks = Array.from({ length: 6 }, (_, index) => {
    const value = (yMaximum / 5) * index;
    const y = yFor(value);
    return `
      <line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${width - margin.right}" y2="${y.toFixed(2)}" stroke="${palette.grid}" stroke-width="1" />
      <text x="${margin.left - 14}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="${palette.muted}" font-size="12">${formatNumber(Math.round(value))}</text>`;
  }).join('').trim();

  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const timestamp = firstTime + (timeSpan * index) / 4;
    const x = xFor(timestamp);
    return `
      <line x1="${x.toFixed(2)}" y1="${margin.top}" x2="${x.toFixed(2)}" y2="${baseline}" stroke="${palette.grid}" stroke-width="1" />
      <text x="${x.toFixed(2)}" y="${height - 28}" text-anchor="middle" fill="${palette.muted}" font-size="12">${escapeXml(formatDateTick(timestamp, spanDays))}</text>`;
  }).join('').trim();

  const lastPoint = points.at(-1);
  const title = `${repository} Star History`;
  const updatedDate = formatUpdatedDate(generatedAt);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(title)}</title>
  <desc id="description">${formatNumber(total)} current GitHub stargazers as of ${escapeXml(updatedDate)}.</desc>
  <rect width="${width}" height="${height}" rx="12" fill="${palette.background}" stroke="${palette.border}" />
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
    <text x="${margin.left}" y="40" fill="${palette.text}" font-size="24" font-weight="600">Star History</text>
    <text x="${width - margin.right}" y="42" text-anchor="end" fill="${palette.text}" font-size="18" font-weight="600">${formatNumber(total)} stars</text>
    <text x="${margin.left}" y="64" fill="${palette.muted}" font-size="13">${escapeXml(repository)}</text>
    ${yTicks}
    ${xTicks}
    <path d="${areaPath}" fill="${palette.line}" opacity="0.12" />
    <path d="${linePath}" fill="none" stroke="${palette.line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="5" fill="${palette.line}" stroke="${palette.background}" stroke-width="2" />
    <text x="${width - margin.right}" y="${height - 14}" text-anchor="end" fill="${palette.muted}" font-size="11">Updated ${escapeXml(updatedDate)}</text>
  </g>
</svg>
`;
}

function repositoryName(repository) {
  const name = repository.split('/').at(-1);
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Invalid repository path: ${repository}`);
  }
  return name;
}

export async function writeRepositoryOutputs({
  repository,
  timestamps,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  asOf = new Date(),
}) {
  assertValidDate(asOf, 'asOf');
  const series = buildDailySeries(timestamps, asOf);
  const outputDirectory = join(outputRoot, repositoryName(repository));
  const data = {
    schemaVersion: 2,
    repository,
    generatedAt: asOf.toISOString(),
    points: series,
  };

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(`${outputDirectory}/data.json`, `${JSON.stringify(data, null, 2)}\n`, 'utf8'),
    writeFile(
      `${outputDirectory}/chart-light.svg`,
      renderStarHistorySvg(series, { repository, theme: 'light', generatedAt: asOf.toISOString() }),
      'utf8',
    ),
    writeFile(
      `${outputDirectory}/chart-dark.svg`,
      renderStarHistorySvg(series, { repository, theme: 'dark', generatedAt: asOf.toISOString() }),
      'utf8',
    ),
  ]);
}

export async function main({
  env = process.env,
  fetchImpl = fetch,
  asOf = new Date(),
  sleepImpl = defaultSleep,
} = {}) {
  const owner = env.STAR_HISTORY_OWNER;
  if (!owner) throw new Error('STAR_HISTORY_OWNER is required');
  const token = env.STAR_HISTORY_GITHUB_TOKEN;
  if (!token) throw new Error('STAR_HISTORY_GITHUB_TOKEN is required');

  const repositories = parseRepositoryList(env.STAR_HISTORY_REPOSITORIES, owner);
  const outputRoot = env.STAR_HISTORY_OUTPUT_ROOT || DEFAULT_OUTPUT_ROOT;
  for (const { repository } of repositories) {
    console.log(`Fetching GitHub stargazer history for ${repository}`);
    const timestamps = await fetchAllStargazers({ repository, token, fetchImpl, sleepImpl });
    await writeRepositoryOutputs({ repository, timestamps, outputRoot, asOf });
    console.log(`Wrote ${timestamps.length.toLocaleString('en-US')} stargazers for ${repository}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
