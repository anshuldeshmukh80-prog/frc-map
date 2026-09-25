// Syncs events.json with FIRST's public 2027 event list.
// Run by GitHub Actions (see .github/workflows/sync.yml) or by hand: node scripts/update.mjs
//
// 1. Reads the event list page and keeps the Regional events.
// 2. Opens each event page to read the venue name and address.
// 3. Geocodes the venue (OpenStreetMap Nominatim, cached in coords.json) so the dot lands on the venue.
//    If the venue is TBD or cannot be found near the city, the dot stays on the city centre.
// If FIRST's site cannot be read or the page layout changes, the script fails and the old events.json stays.

import fs from "node:fs";

const YEAR = 2027;
const BASE = "https://frc-events.firstinspires.org";
const UA = "frc-regionals-map/1.0 (+https://github.com/anshuldeshmukh80-prog/frc-map)";
const MAX_VENUE_DRIFT_KM = 60; // a venue farther than this from its city centre is treated as a bad geocode
const REVIEW_KM = 15;          // venues this far out are listed in the log so a person can eyeball them

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const prev = read("events.json", { events: [] });
const prevByCode = new Map(prev.events.map(e => [e.code, e]));
const cache = read("coords.json", { centers: {}, geo: {} });
const overrides = read("overrides.json", {}); // hand-checked positions: { "CODE": { "venue": "...", "lat": 0, "lng": 0 } }

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
const clean = s => decode(String(s ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

async function get(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" } });
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return await r.text();
    } catch (e) { err = e; await sleep(1500 * (i + 1)); }
  }
  throw err;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDates(raw) {
  const m = raw.match(/(\d+)\/(\d+)\s+to\s+(\d+)\/(\d+)/);
  if (!m) return raw;
  const [, m1, d1, m2, d2] = m;
  return m1 === m2 ? `${MONTHS[m1 - 1]} ${d1}–${d2}` : `${MONTHS[m1 - 1]} ${d1}–${MONTHS[m2 - 1]} ${d2}`;
}

// ---- 1. event list ---------------------------------------------------------
const listHtml = await get(`${BASE}/${YEAR}/Events/EventList`);
const found = [];
for (const row of listHtml.split("<tr>").slice(1)) {
  const code = (row.match(/<td[^>]*>\s*([A-Z0-9]{3,8})\s*<\/td>/) || [])[1];
  const name = clean((row.match(/<a href="\/\d+\/[^"]+" title="Event Information">(.*?)<\/a>/s) || [])[1]);
  if (!code || !name || !/Regional/.test(name) || /District/.test(name)) continue;
  const week = +((row.match(/<td title="[^"]*">\s*(\d+)\s*<span id="detail1">/) || [])[1] ?? NaN);
  const dates = fmtDates(clean((row.match(/<span id="detail1">(.*?)<\/span>/s) || [])[1]));
  const loc = clean((row.match(/<span id="detail2">(.*?)<\/span>/s) || [])[1]);
  const cap = +((row.match(/<td class="d-none d-md-table-cell">(\d+)<\/td>/) || [])[1] ?? 0);
  const cut = loc.lastIndexOf(", ");
  const city = cut < 0 ? loc : loc.slice(0, cut);
  const rest = cut < 0 ? "" : loc.slice(cut + 2);
  const sp = rest.indexOf(" ");
  const st = sp < 0 ? "" : rest.slice(0, sp);
  const country = sp < 0 ? rest : rest.slice(sp + 1);
  found.push({ code, name, city, st, country, week, dates, cap });
}
if (found.length < 30) throw new Error(`Only found ${found.length} regionals. FIRST's page layout may have changed.`);
if (found.some(e => !e.city || !e.country || !Number.isFinite(e.week))) {
  throw new Error("A regional is missing its city, country or week. FIRST's page layout may have changed.");
}

// ---- 2. venues from each event page ---------------------------------------
async function venueOf(code) {
  const html = await get(`${BASE}/${YEAR}/${code}`);
  const m = html.match(/Venue<\/strong>\s*<p[^>]*>\s*<a [^>]*>(.*?)<\/a>/s);
  if (!m) return { venue: "", street: "", cityLine: "" };
  const [venue = "", street = "", cityLine = ""] = m[1].split(/<br\s*\/?>/i).map(clean);
  return /^TBD$/i.test(venue) || /^TBD$/i.test(street) ? { venue: "", street: "", cityLine } : { venue, street, cityLine };
}
const queue = [...found];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const e = queue.shift();
    try { Object.assign(e, await venueOf(e.code)); }
    catch (err) {
      console.warn(`venue page failed for ${e.code}: ${err.message}; keeping the last known venue`);
      const p = prevByCode.get(e.code);
      Object.assign(e, { venue: p?.venue ?? "", street: p?.addr?.split(", ")[0] ?? "", cityLine: "" });
    }
  }
}));

// ---- 3. coordinates ---------------------------------------------------------
let lastCall = 0;
async function nominatim(q) {
  if (q in cache.geo) return cache.geo[q];
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=" + encodeURIComponent(q),
      { headers: { "user-agent": UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    return (cache.geo[q] = j[0] ? { lat: +(+j[0].lat).toFixed(5), lng: +(+j[0].lon).toFixed(5) } : null);
  } catch (err) {
    console.warn("geocode failed for", q, err.message); // not cached, so it is retried next run
    return undefined;
  }
}
const km = (a, b) => {
  const R = 6371, t = x => x * Math.PI / 180, dLat = t(b.lat - a.lat), dLng = t(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const lastPart = s => s.split("/").pop().trim();          // "Bakırköy / İstanbul" -> "İstanbul"
const nCountry = c => (c === "USA" ? "United States" : c);

for (const e of found) {
  const ckey = `${e.city}|${e.country}`;
  let center = cache.centers[ckey];
  if (!center) center = await nominatim([lastPart(e.city), e.st, nCountry(e.country)].filter(Boolean).join(", ")) ?? undefined;
  if (center) cache.centers[ckey] = center;

  let pos = null;
  const ov = overrides[e.code];
  if (ov && ov.venue === e.venue) pos = { lat: ov.lat, lng: ov.lng };
  else if (e.venue) {
    if (ov) console.log(`STALE     override for ${e.code} ignored: FIRST now lists "${e.venue}"`);
    // Venue names are matched first: bare street addresses are the likeliest to land in the wrong town.
    const country = nCountry(e.country), city = lastPart(e.city), district = e.city.includes("/") ? e.city.split("/")[0].trim() : "";
    const shortName = e.venue.split("/")[0].trim();
    const street = e.street.replace(/No[:.]?s*d+[A-Za-z/-]*/gi, "").replace(/s+/g, " ").replace(/[ ,]+$/, "").trim();
    const tries = [
      [shortName, city, country],
      [e.venue, e.street, city, country],
      [shortName, district, city, country],
      [street, district, city, country],
      [e.street, city, country],
    ];
    const seen = new Set();
    for (const t of tries) {
      const q = t.filter(Boolean).join(", ");
      if (seen.has(q)) continue;
      seen.add(q);
      const hit = await nominatim(q);
      if (hit && (!center || km(hit, center) <= MAX_VENUE_DRIFT_KM)) {
        pos = hit;
        if (center && km(hit, center) > REVIEW_KM) console.log(`REVIEW    ${e.code} ${km(hit, center).toFixed(0)} km from ${e.city} centre: ${q}`);
        break;
      }
    }
  }
  const p = pos || center || prevByCode.get(e.code);
  if (!p) throw new Error(`No coordinates for ${e.code} (${e.city}, ${e.country})`);
  e.lat = p.lat; e.lng = p.lng; e.precise = !!pos;
  e.addr = [e.street, e.cityLine].filter(Boolean).join(", ");
  delete e.street; delete e.cityLine;
}

// ---- write -------------------------------------------------------------------
found.sort((a, b) => a.week - b.week || a.code.localeCompare(b.code));
const out = { checked: new Date().toISOString().slice(0, 10), source: `${BASE}/${YEAR}/Events/EventList`, events: found };

// human-readable summary for the Actions log
const now = new Map(found.map(e => [e.code, e]));
for (const [c, e] of now) {
  const p = prevByCode.get(c);
  if (!p) { console.log("NEW      ", c, e.name); continue; }
  for (const k of ["name", "week", "dates", "cap", "venue", "city"]) if (p[k] !== e[k]) console.log("CHANGED  ", c, k + ":", p[k], "->", e[k]);
}
for (const [c, p] of prevByCode) if (!now.has(c)) console.log("REMOVED  ", c, p.name);
console.log(`${found.length} regionals, ${found.filter(e => e.precise).length} placed at the venue.`);

fs.writeFileSync("events.json", JSON.stringify(out, null, 1) + "\n");
fs.writeFileSync("coords.json", JSON.stringify(cache, null, 1) + "\n");
