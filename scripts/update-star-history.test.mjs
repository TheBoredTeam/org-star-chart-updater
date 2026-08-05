import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildMonotonePath,
  buildDailySeries,
  escapeXml,
  fetchAllStargazers,
  parseLinkHeader,
  parseRepositoryList,
  renderStarHistorySvg,
  writeRepositoryOutputs,
} from './update-star-history.mjs';

test('parseRepositoryList trims blanks and removes duplicates', () => {
  assert.deepEqual(
    parseRepositoryList(' boring.notch\n\nboring.notch\nsecond-project ', 'TheBoredTeam'),
    [
      { name: 'boring.notch', repository: 'TheBoredTeam/boring.notch' },
      { name: 'second-project', repository: 'TheBoredTeam/second-project' },
    ],
  );
});

test('parseRepositoryList rejects missing and unsafe values', () => {
  assert.throws(() => parseRepositoryList('', 'TheBoredTeam'), /repository list is required/i);
  assert.throws(() => parseRepositoryList('../outside', 'TheBoredTeam'), /invalid repository/i);
  assert.throws(
    () => parseRepositoryList('TheBoredTeam/boring.notch', 'OtherOrg'),
    /invalid repository/i,
  );
});

test('parseLinkHeader extracts pagination relations', () => {
  assert.deepEqual(
    parseLinkHeader(
      '<https://api.github.com/repos/a/b/stargazers?page=2>; rel="next", <https://api.github.com/repos/a/b/stargazers?page=7>; rel="last"',
    ),
    {
      next: 'https://api.github.com/repos/a/b/stargazers?page=2',
      last: 'https://api.github.com/repos/a/b/stargazers?page=7',
    },
  );
});

test('buildDailySeries returns sorted cumulative points and today total', () => {
  assert.deepEqual(
    buildDailySeries(
      [
        '2026-08-02T23:00:00Z',
        '2026-08-01T01:00:00Z',
        '2026-08-02T01:00:00Z',
      ],
      new Date('2026-08-04T12:00:00Z'),
    ),
    [
      { date: '2026-08-01', stars: 1 },
      { date: '2026-08-02', stars: 3 },
      { date: '2026-08-04', stars: 3 },
    ],
  );
});

test('buildDailySeries supports repositories with no stargazers', () => {
  assert.deepEqual(
    buildDailySeries([], new Date('2026-08-04T12:00:00Z')),
    [{ date: '2026-08-04', stars: 0 }],
  );
});

test('escapeXml protects SVG text', () => {
  assert.equal(
    escapeXml('A&B <repo> "quoted"'),
    'A&amp;B &lt;repo&gt; &quot;quoted&quot;',
  );
});

test('buildMonotonePath smooths points without replacing the endpoints', () => {
  const path = buildMonotonePath([
    { x: 0, y: 0 },
    { x: 10, y: 4 },
    { x: 20, y: 9 },
  ]);
  assert.match(path, /^M0\.00,0\.00 C/);
  assert.match(path, /20\.00,9\.00$/);
  assert.doesNotMatch(path, / L/);
});

test('renderStarHistorySvg emits distinct accessible themes', () => {
  const series = [
    { date: '2026-08-01', stars: 3 },
    { date: '2026-08-04', stars: 10_238 },
  ];
  const light = renderStarHistorySvg(series, {
    repository: 'TheBoredTeam/boring.notch',
    theme: 'light',
  });
  const dark = renderStarHistorySvg(series, {
    repository: 'TheBoredTeam/boring.notch',
    theme: 'dark',
  });

  assert.match(light, /<title[^>]*>TheBoredTeam\/boring\.notch Star History<\/title>/);
  assert.match(light, /<desc[^>]*>10,238 current GitHub stargazers as of Aug 4, 2026/);
  assert.match(light, /font-size="14" font-weight="500">10,238 stars<\/text>/);
  assert.match(light, />2K<\/text>/);
  assert.match(light, />4K<\/text>/);
  assert.match(light, />10K<\/text>/);
  assert.doesNotMatch(light, />20,000<\/text>/);
  assert.match(light, /Updated Aug 4, 2026<\/text>/);
  assert.doesNotMatch(light, /T00:00:00|UTC/);
  assert.match(light, /#0969da/);
  assert.match(light, /<path d="M[^>]+ C/);
  assert.match(dark, /#58a6ff/);
  assert.doesNotMatch(light, /height="32" rx="16"/);
  assert.doesNotMatch(dark, /height="32" rx="16"/);
  assert.doesNotMatch(light, /nicoloboschi|external font|powered by/);
});

function fakeResponse({ ok = true, status = 200, body = [], link = '' } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'link' ? link : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('fetchAllStargazers follows last-page links and retries transient responses', async () => {
  const calls = [];
  let firstAttempt = true;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const page = new URL(url).searchParams.get('page');
    if (page === '1' && firstAttempt) {
      firstAttempt = false;
      return fakeResponse({ ok: false, status: 503, body: { message: 'retry' } });
    }
    if (page === '1') {
      return fakeResponse({
        body: [{ starred_at: '2026-08-01T01:00:00Z' }],
        link: '<https://api.github.com/repos/TheBoredTeam/boring.notch/stargazers?page=2>; rel="last"',
      });
    }
    return fakeResponse({ body: [{ starred_at: '2026-08-02T01:00:00Z' }] });
  };

  assert.deepEqual(
    await fetchAllStargazers({
      repository: 'TheBoredTeam/boring.notch',
      token: 'secret',
      fetchImpl,
      sleepImpl: async () => {},
    }),
    ['2026-08-01T01:00:00Z', '2026-08-02T01:00:00Z'],
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
});

test('writeRepositoryOutputs writes schema v2 and both SVG variants', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'star-history-test-'));
  await writeRepositoryOutputs({
    repository: 'TheBoredTeam/boring.notch',
    timestamps: ['2026-08-01T01:00:00Z', '2026-08-04T01:00:00Z'],
    outputRoot,
    asOf: new Date('2026-08-04T12:00:00Z'),
  });

  const outputDirectory = join(outputRoot, 'boring.notch');
  const data = JSON.parse(await readFile(join(outputDirectory, 'data.json'), 'utf8'));
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.repository, 'TheBoredTeam/boring.notch');
  assert.deepEqual(data.points.at(-1), { date: '2026-08-04', stars: 2 });
  assert.match(await readFile(join(outputDirectory, 'chart-light.svg'), 'utf8'), /#0969da/);
  assert.match(await readFile(join(outputDirectory, 'chart-dark.svg'), 'utf8'), /#58a6ff/);
});
