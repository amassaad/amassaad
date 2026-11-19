#!/usr/bin/env node
// Draws the profile's contribution skyline: one block per month, one row per
// year, newest year at the back. Static SVG, no animation, patterns or fonts,
// so it paints quickly on a phone or tablet.
//
// What it publishes is deliberately coarse. Counts are bucketed by month,
// block heights snap to HEIGHT_STEPS levels of the busiest month, and the only
// numbers printed are ratios. It asks GitHub for the contribution calendar and
// nothing else, so repository names, organizations and languages never reach
// this script.
//
// Data source, first match wins:
//   CONTRIB_DATA_DIR  directory of saved <year>.json GraphQL responses
//   GITHUB_TOKEN      token for api.github.com (this is what the workflow uses)
//   neither           the local `gh` CLI
//
// Other environment:
//   USERNAME  expected login; the run fails if the token belongs to anyone else
//   YEARS     how many years to show (default 12)
//   OUT_DIR   where to write the SVGs (default assets)
//   TODAY     YYYY-MM-DD override, for reproducible output

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const YEARS = Number(process.env.YEARS ?? 12);
const OUT_DIR = process.env.OUT_DIR ?? "assets";
const HEIGHT_STEPS = 34;

const QUERY_YEARS = `query { viewer { login contributionsCollection { contributionYears } } }`;
const QUERY_CALENDAR = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

// ---------------------------------------------------------------- data

async function graphql(query, variables = {}) {
  const token = process.env.GITHUB_TOKEN;
  let body;
  if (token) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "contrib-skyline",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub API answered ${res.status} ${res.statusText}`);
    body = await res.json();
  } else {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(variables)) args.push("-F", `${k}=${v}`);
    body = JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
  }
  if (body.errors?.length) throw new Error(`GitHub API error: ${body.errors[0].message}`);
  return body.data;
}

/** Returns { login, years: [{ year, days: Map<"MM-DD", count> }] }, oldest first. */
async function loadYears(today) {
  const dir = process.env.CONTRIB_DATA_DIR;
  const thisYear = Number(today.slice(0, 4));
  let wanted;
  if (dir) {
    wanted = Array.from({ length: YEARS }, (_, i) => thisYear - YEARS + 1 + i);
  } else {
    const data = await graphql(QUERY_YEARS);
    const known = data.viewer.contributionsCollection.contributionYears;
    wanted = known.filter((y) => y <= thisYear).sort((a, b) => a - b).slice(-YEARS);
  }

  let login;
  const years = [];
  for (const year of wanted) {
    const data = dir
      ? JSON.parse(readFileSync(join(dir, `${year}.json`), "utf8")).data
      : await graphql(QUERY_CALENDAR, {
          from: `${year}-01-01T00:00:00Z`,
          to: `${year}-12-31T23:59:59Z`,
        });
    login = data.viewer.login;
    const days = new Map();
    // Keyed by date, never by position: years start mid-week and some have 53 weeks.
    for (const week of data.viewer.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        if (day.date.startsWith(`${year}-`)) days.set(day.date.slice(5), day.contributionCount);
      }
    }
    years.push({ year, days });
  }
  return { login, years };
}

/**
 * A token for the wrong account, or one that cannot see private work, answers
 * with a perfectly valid calendar of zeros. Refuse to publish that.
 */
function assertPlausible({ login, years }) {
  const expected = process.env.USERNAME;
  if (expected && login.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`token belongs to "${login}", expected "${expected}"; not writing anything`);
  }
  const total = years.reduce((sum, y) => sum + [...y.days.values()].reduce((a, b) => a + b, 0), 0);
  if (total === 0) throw new Error(`no contributions at all for "${login}"; not writing anything`);
}

// ---------------------------------------------------------------- model

function summarize(years, today) {
  const cutoff = today.slice(5); // "MM-DD"
  const thisMonth = Number(cutoff.slice(0, 2));
  const rows = years.map(({ year, days }) => {
    const months = Array(12).fill(0);
    let toDate = 0;
    for (const [md, count] of days) {
      months[Number(md.slice(0, 2)) - 1] += count;
      if (md <= cutoff) toDate += count;
    }
    return { year, months, toDate };
  });

  const current = rows.at(-1);
  const prior = rows.slice(0, -1);
  const peak = Math.max(1, ...rows.flatMap((r) => r.months));

  // Compare like with like: this year so far against the same dates of other years.
  const last = prior.at(-1);
  const recent = prior.slice(-5).map((r) => r.toDate).sort((a, b) => a - b);
  const norm = recent.length >= 3 ? recent[Math.floor(recent.length / 2)] : 0;
  // A few days of January against a few days of another January is noise.
  const settled = cutoff >= "02-01";

  return {
    rows,
    peak,
    thisMonth,
    current,
    vsLastYear: settled && last && last.toDate > 0 ? current.toDate / last.toDate : null,
    lastYear: last?.year,
    vsNorm: settled && norm > 0 ? current.toDate / norm : null,
    normYears: recent.length,
  };
}

/** Height in steps: linear in the count, so a block twice as tall is twice the work. */
const heightStep = (count, peak) =>
  count === 0 ? 0 : Math.max(1, Math.round((count / peak) * HEIGHT_STEPS));

/** Colour band 1-4, stepping up at each 3x, so quiet years still show their seasons. */
function band(count, peak) {
  const share = count / peak;
  return share > 1 / 3 ? 4 : share > 1 / 9 ? 3 : share > 1 / 27 ? 2 : 1;
}

const times = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;

// ---------------------------------------------------------------- drawing

const THEMES = {
  light: {
    ink: "#1f2328",
    more: "darker",
    muted: "#656d76",
    empty: "#ebedf0",
    greens: ["#9be9a8", "#40c463", "#30a14e", "#216e39"],
  },
  dark: {
    ink: "#e6edf3",
    more: "brighter",
    muted: "#8b949e",
    empty: "#1b222b",
    greens: ["#0e4429", "#006d32", "#26a641", "#39d353"],
  },
};

const shade = (hex, k) =>
  "#" +
  [1, 3, 5]
    .map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0"))
    .join("");

const n1 = (x) => String(Math.round(x * 10) / 10);

function render(model, theme) {
  const { rows, peak, thisMonth, current } = model;
  const t = THEMES[theme];
  const count = rows.length;

  // Dimetric grid: months run down-right, years run back and to the right.
  const HW = 26, HH = 13, UNIT = 4, INSET = 0.86;
  const a = HW * INSET, b = HH * INSET;
  const W = 720;
  const OX = W - 42 - 12 * HW; // x of the back corner
  const OY = 34;
  const H = OY + (count + 12) * HH + 42;
  const centre = (m, r) => [OX + (m - r) * HW, OY + (m + r + 1) * HH];

  const flat = `l${n1(a)},${n1(b)} ${n1(-a)},${n1(b)} ${n1(-a)},${n1(-b)}z`;
  let empties = "", upcoming = "";
  const layers = new Map(); // depth -> Map(class -> path data)
  const add = (depth, cls, d) => {
    if (!layers.has(depth)) layers.set(depth, new Map());
    const layer = layers.get(depth);
    layer.set(cls, (layer.get(cls) ?? "") + d);
  };

  rows.forEach((row, i) => {
    const r = count - 1 - i; // newest year is row 0, at the back
    row.months.forEach((value, m) => {
      const [cx, cy] = centre(m, r);
      const tile = `M${n1(cx)},${n1(cy - b)}${flat}`;
      if (row === current && m + 1 > thisMonth) return void (upcoming += tile);
      if (value === 0) return void (empties += tile);
      const h = heightStep(value, peak) * UNIT;
      const k = band(value, peak);
      add(m + r, `t${k}`, `M${n1(cx)},${n1(cy - b - h)}${flat}`);
      add(m + r, `l${k}`, `M${n1(cx - a)},${n1(cy - h)}l${n1(a)},${n1(b)}v${h}l${n1(-a)},${n1(-b)}z`);
      add(m + r, `r${k}`, `M${n1(cx)},${n1(cy + b - h)}l${n1(a)},${n1(-b)}v${h}l${n1(-a)},${n1(b)}z`);
    });
  });

  // Blocks in one depth layer never overlap, so each layer merges into a few paths.
  const blocks = [...layers.keys()]
    .sort((x, y) => x - y)
    .map((depth) =>
      [...layers.get(depth)].map(([cls, d]) => `<path class="${cls}" d="${d}"/>`).join(""),
    )
    .join("");

  const yearLabels = rows
    .map((row, i) => {
      const [cx, cy] = centre(11, count - 1 - i);
      return `<text x="${n1(cx + HW * 0.55)}" y="${n1(cy + HH + 9)}">${row.year}</text>`;
    })
    .join("");
  const monthLabels = [..."JFMAMJJASOND"]
    .map((letter, m) => {
      const [cx, cy] = centre(m, count - 1);
      return `<text x="${n1(cx - HW * 0.62)}" y="${n1(cy + HH + 9)}">${letter}</text>`;
    })
    .join("");

  const first = rows[0].year, year = current.year;
  const headline =
    model.vsLastYear === null
      ? ""
      : `<text class="ink lead" x="20" y="54">${year} so far vs. the same dates in ${model.lastYear}</text>` +
        `<text class="ink big" x="18" y="114">${times(model.vsLastYear)}</text>`;
  const norm =
    model.vsNorm === null
      ? ""
      : `<text class="ink mid" x="${W - 20}" y="${H - 44}" text-anchor="end">${times(model.vsNorm)}</text>` +
        `<text x="${W - 20}" y="${H - 24}" text-anchor="end">my usual pace over the</text>` +
        `<text x="${W - 20}" y="${H - 8}" text-anchor="end">previous ${model.normYears} years</text>`;

  const label =
    `Isometric chart of monthly GitHub contributions, ${first} to ${year}, one row of blocks per year.` +
    (model.vsLastYear === null
      ? ""
      : ` ${year} so far is ${times(model.vsLastYear)} the same dates in ${model.lastYear}.`);

  const faces = t.greens
    .map((g, i) => `.t${i + 1}{fill:${g}}.l${i + 1}{fill:${shade(g, 0.8)}}.r${i + 1}{fill:${shade(g, 0.62)}}`)
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">` +
    `<title>${label}</title>` +
    `<style>text{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${t.muted}}` +
    `.ink{fill:${t.ink}}.lead{font-size:15px}.big{font-size:58px;font-weight:700;letter-spacing:-1.5px}` +
    `.mid{font-size:34px;font-weight:700;letter-spacing:-1px}.axis text{font-size:12px}.e{fill:${t.empty}}.u{fill:${t.empty};opacity:.45}${faces}</style>` +
    `<text x="20" y="28">GitHub contributions, ${first}–${year}</text>` +
    headline +
    `<path class="e" d="${empties}"/>` +
    (upcoming ? `<path class="u" d="${upcoming}"/>` : "") +
    blocks +
    `<g class="axis" text-anchor="middle">${yearLabels}${monthLabels}</g>` +
    `<text x="20" y="${H - 8}">One block per month. Taller and ${t.more} means more.</text>` +
    norm +
    `</svg>\n`
  );
}

// ---------------------------------------------------------------- main

const today = process.env.TODAY ?? new Date().toISOString().slice(0, 10);
const loaded = await loadYears(today);
assertPlausible(loaded);
const model = summarize(loaded.years, today);

mkdirSync(OUT_DIR, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const file = join(OUT_DIR, `contrib-skyline-${theme}.svg`);
  const svg = render(model, theme);
  writeFileSync(file, svg);
  console.log(`${file}: ${(svg.length / 1024).toFixed(1)} KB, ${svg.split("<path").length - 1} paths`);
}
