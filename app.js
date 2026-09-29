/* Game Library - client-side app.
   Loads one JSON payload, filters and searches entirely in the browser.
   No backend, no build step. See MASTER_HANDOFF.md sections 13-16. */

'use strict';

/* Set by the publish step as `app.js?v=<hash>`; empty when served locally. */
const ASSET_V = (document.currentScript && (document.currentScript.src.split('?v=')[1] || '')) || '';

let DATA = null, META = null, GAMES = [];
let RESULTS = [], RENDERED = 0;
const PAGE = 60;

const $ = s => document.querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const esc = s => String(s == null ? '' : s);

/* ---- Priority-backlog starring (2026-09-16) -----------------------------
   Site-only feature - NOT a workbook column. `Backlog Priority` (axis 12)
   has sat empty in the workbook for the whole project; this replaces it
   with a tiny Cloudflare Worker + KV store so a star follows Justin across
   devices. Reads are public (so the star already shown to a browsing friend
   is real data, not a placeholder); writes need an admin token so only
   Justin can ever change one. Proposed to chat in RETURN_TO_CHAT.md for
   retiring the workbook axis - not yet decided, so export_json.py simply
   stops emitting it rather than assuming the answer.

   Fails soft everywhere it touches the rest of the app: if the Worker is
   unreachable, STARS just stays empty and every other feature is unaffected. */
const STARS_API = 'https://game-library-stars.jgraz.workers.dev/stars';
const STAR_TOKEN_KEY = 'gl.admin.token';

/* The "slicker" login: a one-time `?admin=<token>` link saves the token to
   this browser's localStorage and scrubs it from the address bar so it
   never sits in history in plain text. Every later visit, from any tab,
   just reads localStorage - there is no login screen and nothing to expire. */
function readAdminToken() {
  try {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('admin');
    if (fromUrl) {
      localStorage.setItem(STAR_TOKEN_KEY, fromUrl);
      params.delete('admin');
      const rest = params.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    }
    return localStorage.getItem(STAR_TOKEN_KEY) || '';
  } catch (e) { return ''; }
}
const ADMIN_TOKEN = readAdminToken();
const IS_ADMIN = !!ADMIN_TOKEN;

let STARS = new Set();
let starsReady = null;
/* Fetched once at boot, alongside library.json - see the bottom of this
   file. A failed fetch leaves STARS empty rather than blocking the app;
   browsing works with or without the Worker up. */
function loadStars() {
  if (!starsReady) {
    starsReady = fetch(STARS_API)
      .then(r => r.ok ? r.json() : { ids: [] })
      .then(d => { STARS = new Set(d.ids || []); })
      .catch(() => { STARS = new Set(); });
  }
  return starsReady;
}

/* Optimistic toggle: flips the local set and every visible star button for
   this id immediately, then confirms with the Worker. A failed write rolls
   both back rather than leaving the button lying about what's actually
   saved - the KV store, not the DOM, is the source of truth. */
function setStar(id, starred) {
  if (!IS_ADMIN) return;
  if (STARS.has(id) === starred) return;
  if (starred) STARS.add(id); else STARS.delete(id);
  paintStarButtons(id, starred);
  fetch(STARS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ADMIN_TOKEN },
    body: JSON.stringify({ id, starred })
  }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); })
    .catch(() => {
      if (starred) STARS.delete(id); else STARS.add(id);
      paintStarButtons(id, !starred);
    });
}

function paintStarButtons(id, on) {
  document.querySelectorAll('[data-star-id="' + CSS.escape(id) + '"]').forEach(btn => paintStar(btn, on));
}
function paintStar(btn, on) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = IS_ADMIN
    ? (on ? 'Remove from priority backlog' : 'Add to priority backlog')
    : (on ? 'In priority backlog' : 'Priority backlog (read-only)');
}
/* Rendered for every viewer, admin or not, so a friend browsing sees the
   real star state - only the disabled attribute (and the missing click
   handler) differs, which is what makes it read as read-only rather than
   as a control that silently does nothing when clicked. */
function starButton(id) {
  const b = el('button', 'starbtn' + (IS_ADMIN ? '' : ' ro'));
  b.type = 'button';
  b.dataset.starId = id;
  b.disabled = !IS_ADMIN;
  b.setAttribute('aria-label', 'Priority backlog');
  b.textContent = '★';
  paintStar(b, STARS.has(id));
  if (IS_ADMIN) {
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); setStar(id, !STARS.has(id)); };
  }
  return b;
}

/* Owning tokens - handoff 3.2. Never test for the bare "Owned" token. */

/* Handoff 3.3b: `Status` has FIVE values, not four. `Sampled` arrived at v73,
   `In Progress` at v70.

   Nothing here enumerates the statuses. The payload ships `META.statuses`,
   tallied from the workbook, and the filter is built from that; this map only
   supplies PRESENTATION - a colour class, the pill wording, what the
   `Completed` column is called for that status, and what its notes are called.

   A status with no entry still renders, still filters, still counts, and still
   gets its own row in the dropdown. It just gets the neutral treatment. Rows
   never disappear for want of a map entry, which is the entire point: the
   workbook's own `Summary` sheet counted statuses with one COUNTIF per literal
   value, was never given a row for `In Progress`, and undercounted silently for
   three versions (handoff 7).

   `Sampled` is a company anthology he genuinely dipped into and that was never
   a completion unit. It carries real play history, it belongs in the completion
   view, and it is NOT a lesser `Beaten` - it must never be styled as a failure
   or a did-not-finish state. Handoff 9.13. */
const STATUS_META = {
  'Beaten': {
    cls: 'b', pill: g => 'Beaten' + (g.completed ? ' ' + g.completed : ''),
    dateLabel: 'Completed', notesLabel: 'Completion notes'
  },
  'Sampled': {
    /* `Completed` on a Sampled row records WHEN HE PLAYED IT - the same
       re-reading `Abandoned` already needed. Never render it as a completion
       date. Handoff 9.13. */
    cls: 's', pill: g => 'Sampled' + (g.completed ? ' ' + g.completed : ''),
    dateLabel: 'Played', notesLabel: 'What I played'
  },
  'In Progress': {
    /* `Completed` stays empty on an In Progress row by rule - handoff 4. */
    cls: 'p', pill: () => 'In progress',
    dateLabel: 'Completed', notesLabel: 'Progress so far'
  },
  'Retired': {
    /* v80. A game with NO END STATE that he stopped playing - Rocket League,
       Fortnite, Knockout City. The distinction from Abandoned is the whole
       reason both exist, and it is about the GAME, not about him:

           Abandoned   the game HAS an ending, he stopped before reaching it
           Retired     the game has NO ending, there was never anything to reach

       So this is not a failure state and must never be styled like one. It gets
       the calm slate below, not the coral that means Abandoned. Length is not
       the test either - four of the nine run under five hours. Handoff 9.22. */
    cls: 'r', pill: g => 'Retired' + (g.completed ? ' ' + g.completed : ''),
    dateLabel: 'Put down', notesLabel: 'How far it went'
  },
  'Abandoned': {
    /* On an Abandoned row, `Completed` records when he STOPPED, not when he
       finished - true on all 11, each with a note explaining. Never render it
       as a completion. See archive/RETURN_TO_CHAT_session2_APPLIED.md item 6. */
    cls: 'a', pill: g => 'Abandoned' + (g.completed ? ' ' + g.completed : ''),
    dateLabel: 'Stopped', notesLabel: 'Why it was put down'
  }
};

/* `Completed` now carries FOUR meanings - finished (Beaten), stopped
   (Abandoned), played (Sampled), put down (Retired) - so the label always comes
   from here and is never assumed. A validator asserting "Completed implies
   finished" would falsely flag 22 rows. Handoff 9.22. */
function statusMeta(g) {
  if (!g.status || g.status === 'Unplayed') return null;
  return STATUS_META[g.status] || {
    cls: 'x', pill: () => g.status, dateLabel: 'Completed', notesLabel: 'Notes'
  };
}

/* Every tag axis the payload carries a facet for, in the order they are shown
   on a game page and in the filter panel.

   ONE list drives all five of: the links on a game page, the filter controls,
   passes(), the URL, and Clear filters. A tenth axis is an entry here and no
   other code - which is the same reason meta.statuses is tallied off the
   workbook rather than listed (handoff 3.3b). The keys are both the game-object
   key AND the facet key AND the URL parameter name; keeping them identical is
   what lets everything below be a loop.

   `shelf` is deliberately NOT here. Switch folders are never a search facet -
   handoff 5 and 15. They stay link-only, reachable from a game page. */
const TAG_AXES = [
  ['genre', 'Genre'], ['structure', 'Structure'], ['perspective', 'Perspective'],
  ['players', 'Players'], ['length', 'Length'], ['demand', 'Demand'],
  ['mood', 'Mood'], ['artSound', 'Art & Sound'], ['setting', 'Setting']
];

/* Genre earns its place in the always-visible row; the other eight live behind
   "More filters" so the page opens uncluttered. Justin's call. */
const PRIMARY_AXES = ['genre'];
const EXTRA_AXES = TAG_AXES.filter(([k]) => !PRIMARY_AXES.includes(k));

/* Filters that are real, but are reached only by clicking a link on a game page
   - never a dropdown. `shelf` because Switch folders must never be a search
   facet (handoff 5, 15); `series` because 657 values is not a dropdown, and it
   is a relationship rather than a description of a game. */
const LINK_FILTERS = [['shelf', 'shelf'], ['series', 'series']];

/* Every category "Hide Shovelware" hides out of the box, before anyone has
   touched the dropdown - all of META.shovelwareRules, derived rather than
   listed by id, so a rule added in export_json.py (`unplayed-free-switch`
   joined at v167+1) ships already checked instead of needing a second edit
   here to match. Empty until the payload has loaded; nothing reads it before
   then. */
const defaultHideIds = () => (META && META.shovelwareRules || []).map(r => r.id);

const state = {
  q: '', platform: '', store: '', category: '', status: '',
  flag: '', shelf: '', series: '',
  /* Ids from META.shovelwareRules currently checked to hide. A list, not a
     single boolean: each rule is its own real category, and more than one can
     be hidden at once. Whether this list actually APPLIES is a separate
     question - see `hideOn` below - so switching the pill off and back on
     never loses what was checked. Starts empty and is set for real in
     route()'s first pass, once defaultHideIds() has something to return. */
  hide: [],
  /* The pill toggle. On by default - Justin's ask, 2026-09-10 - so a fresh
     visit already hides the junk categories rather than requiring a first
     click to get there. */
  hideOn: true,
  view: 'library', sort: 'title', dir: 'asc',
  /* 'list' or 'detail'. The infinite-scroll observer must only ever append
     rows while a list is on screen. */
  mode: 'list',
  /* 'list' or 'grid' - how a list-mode screen renders. Independent of `mode`
     above: `mode` is list-vs-detail (a route), `layout` is list-vs-grid (a
     presentation choice within the list route). Set for real from
     layoutPref() once the payload has loaded. */
  layout: 'list'
};
/* One state key per axis, so `state.genre`, `state.mood` and the rest all exist
   before anything reads them. Declared rather than sprung into being by the
   router, which is how `flag` and `shelf` used to work. */
TAG_AXES.forEach(([k]) => { state[k] = ''; });

/* Whether the extra-filter panel is open. Remembered per browser as a pure
   convenience - never as state the page depends on, and every access is
   guarded because a private window or blocked site data makes it throw. */
const PANEL_KEY = 'gl.filters.open';
function panelPref(v) {
  try {
    if (v === undefined) return localStorage.getItem(PANEL_KEY) === '1';
    localStorage.setItem(PANEL_KEY, v ? '1' : '0');
  } catch (e) { /* no storage: the panel just opens closed each visit */ }
  return v;
}
let panelOpen = panelPref();

/* List vs grid. A browser preference like panelOpen above, not URL state -
   it changes how results are PRESENTED, never which results they are, so a
   shared link should not carry it. */
const LAYOUT_KEY = 'gl.layout';
function layoutPref(v) {
  try {
    if (v === undefined) return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'list';
    localStorage.setItem(LAYOUT_KEY, v);
  } catch (e) { /* no storage: resets to List each visit */ }
  return v;
}

/* Whether a given dropdown (keyed by filter id - "platform", "genre", ...)
   lists its choices most-common-first (the site's own long-standing default)
   or A-Z. Per FIELD rather than one site-wide switch: Platform and Genre are
   found differently (a dozen values you'd recognise by rank, versus ninety
   you'd rather find by name), so each field remembers its own choice. A
   browser preference, not URL state: it changes how a choice is FOUND, never
   which choice is active, so a shared link should not carry it. */
const OPTSORT_KEY = 'gl.filters.optsort';
function loadOptSort() {
  try { return JSON.parse(localStorage.getItem(OPTSORT_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveOptSort(map) {
  try { localStorage.setItem(OPTSORT_KEY, JSON.stringify(map)); }
  catch (e) { /* no storage: the toggle just resets on reload */ }
}
const optSort = loadOptSort();

/* Which set the Stats page's ranked lists describe: 'played' or 'logged'.
   Played is the default - it is the more interesting question, and the one the
   whole-library figures at the top of the page do not answer. */
let statsScope = 'played';
/* The year opened on the Stats page's year chart, or ''. Lives in the URL
   (#/stats?year=2019) so Back from a game in that year's list reopens it. */
let statsYear = '';
/* The Stats page has its own address as of 2026-09-29 - Justin: "any time I
   click back I want to return to what I was just looking at, not home". It
   used to open over the library without touching the hash, so there was no
   history entry for Back to land on. */
let lastStatsUrl = '#/stats';
let statsScroll = null;
let statsFresh = false;

/* Replace, never push: the tab and the open year are state ON the page, not
   a new page. Back from a game still lands on them because they are in the
   entry being replaced. */
function writeStatsUrl() {
  const p = new URLSearchParams();
  if (statsScope !== 'played') p.set('scope', statsScope);
  if (statsYear) p.set('year', statsYear);
  const next = '#/stats' + (p.toString() ? '?' + p : '');
  lastStatsUrl = next;
  if (next !== location.hash) history.replaceState(null, '', next);
}

const SORTS = {
  title:     { label: 'A\u2013Z',    rev: 'Z\u2013A',   name: 'Alphabetical' },
  /* label = ascending, rev = descending. */
  release:   { label: 'Oldest',   rev: 'Newest', name: 'Release date' },
  completed: { label: 'Earliest', rev: 'Latest', name: 'Completion date' }
};

/* ---------------------------------------------------------------- helpers */

/* Display-only simplification, never applied to the data itself: "PC
   (Windows)" -> "PC" (it's the only PC value there is), and every Xbox
   hardware generation -> plain "Xbox" - if it's in the library, it plays on
   the current one, and nobody browsing needs to know which box it shipped on
   in whichever year. Justin's call, 2026-09-08. Matches the leading token
   only, so "Xbox One via Game Pass (Q2 2021)" simplifies to "Xbox via Game
   Pass (Q2 2021)" rather than losing the service or the date. The Platform
   FILTER already groups all of this under one "Xbox" / "PC" bucket
   (PLATFORM_GROUPS in export_json.py) - this is only the raw per-game text. */
function simplifyPlatform(s) {
  return String(s)
    .replace(/^PC \(Windows\)/, 'PC')
    .replace(/^Xbox (?:360|One|Series)\b/, 'Xbox');
}

/* Applied to a whole list rather than one value at a time, because collapsing
   generations can turn what were distinct entries into duplicates - `Inertial
   Drift` is available on "Xbox, Xbox One, Xbox Series", which is one console
   family, not three. */
function simplifyPlatforms(arr) {
  const seen = new Set(), out = [];
  (arr || []).forEach(s => {
    const t = simplifyPlatform(s);
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  });
  return out;
}

function year(g) {
  const m = /(\d{4})/.exec(g.releaseDate || '');
  return m ? m[1] : '';
}

function statusLine(g) {
  const m = statusMeta(g);
  return m ? { cls: m.cls, text: m.pill(g) } : null;
}

/* Grid card chip: the status word alone, no completion date - there is no
   room for `statusLine`'s full pill text on a card this size. */
function shortStatus(g) {
  return g.status === 'In Progress' ? 'In progress' : g.status;
}

/* Owned beats subscription. If he owns it, that is the hero fact and the
   GWG/Game Pass copy is an afterthought - he would never buy it again.
   Only when NOT owned does the subscription become the whole story. */
/* Name the actual service rather than assuming Game Pass. 'Game Boy via NSO'
   is NSO, not Game Pass - Alleyway was mislabelled before this. */
function serviceName(g) {
  for (const p of g.playedOn || []) {
    const m = /\svia\s+([^(]+?)\s*(?:\(|$)/.exec(p);
    if (m) return m[1].trim();
  }
  for (const p of g.platforms || []) {
    if (/Stadia/.test(p)) return 'Stadia';
    if (/Luna/.test(p)) return 'Luna';
  }
  return null;
}

function accessNote(g) {
  const own = g.ownership || [];
  const svc = serviceName(g);
  if (g.owned) {
    if (own.includes('GWG')) return { kind: 'whisper', text: 'also on GWG' };
    if (own.includes('Subscription')) return { kind: 'whisper', text: 'also on ' + (svc || 'a subscription') };
    return null;
  }
  if (own.includes('GWG')) return { kind: 'flag', text: 'not owned — GWG' };
  if (own.some(t => t.startsWith('Subscription'))) {
    return { kind: 'flag', text: svc ? 'not owned — ' + svc : 'not owned — subscription' };
  }
  if (own.some(t => t.startsWith('Defunct'))) return { kind: 'flag', text: (svc || 'service') + ' shut down' };
  if (own.some(t => t.startsWith('Emulated'))) return { kind: 'flag', text: 'emulated, not owned' };
  return { kind: 'flag', text: 'not owned' };
}

/* ---------------------------------------------------------------- search */

const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/* Punctuation flattened to spaces, so "Super Mario Bros. Wonder" and a typed
   "mario bros wonder" can meet in the middle. Deliberately kept SEPARATE from
   norm() rather than replacing it: norm() still backs the exact-title tier,
   which is what keeps 'PICROSS S+' and 'Picross S' apart at the top of the
   results even though flattening collapses them. Handoff 16. */
const flat = s => norm(s).replace(/[^a-z0-9]+/g, ' ').trim();
const words = s => flat(s).split(' ').filter(Boolean);
const hasAll = (hay, toks) => toks.every(t => hay.includes(t));

function buildIndex() {
  GAMES.forEach(g => {
    g._t = norm(g.title);
    g._alt = (g.altTitles || []).map(norm);
    g._people = [...(g.developers || []), ...(g.publishers || [])].map(norm);
    g._misc = [...(g.genre || []), ...(g.series || [])].filter(Boolean).map(norm);
    /* `contains` became [{name, ownedOn}] at v144, when the column gained an
       ownership suffix. Search indexes the NAME only - a component's store is
       not something anyone types into a search box. */
    g._containsNames = (g.contains || []).map(c => c.name);
    g._contains = g._containsNames.map(norm);
    /* Flattened twins, built once. Word-order-independent matching runs against
       these; the exact tiers still run against the originals. */
    g._tf = flat(g.title);
    g._altf = g._alt.map(flat);
    g._containsf = g._contains.map(flat);
    g._peoplef = g._people.map(flat).join(' ');
    g._miscf = g._misc.map(flat).join(' ');
    g._allf = [g._tf, g._altf.join(' '), g._peoplef, g._miscf].join(' ');
  });
}

/* Ranked search over Title, Alt Titles, Developers, Publishers, Genre, Series
   and Contains - handoff 3.4.

   WORD ORDER DOES NOT MATTER. Typing "mario wonder" has to find
   "Super Mario Bros. Wonder: Nintendo Switch 2 Edition + Meetup in Bellabel
   Park", and before this it found nothing at all - the search was one
   contiguous substring test, so any word between your two words killed the
   match. Real searches that returned zero: "zelda breath", "kart mario",
   "witcher wild", "hyrule zelda". With 4,361 games, a search that only works
   when you already know the exact title is a search you cannot trust.

   Contiguous phrase matches still outrank scattered words, so typing a title
   properly still puts it first. Every token must be present - it is AND, not
   OR - or one common word would drag in half the library.

   A Contains hit is reported differently, because "Golden Axe" is not a row in
   the library; it lives inside two SEGA collections and the result has to say
   so. */
function search(query) {
  const raw = query.trim();
  const q = norm(raw);         /* phrase, punctuation intact */
  const qf = flat(raw);        /* phrase, punctuation flattened */
  const toks = words(raw);     /* the individual words */
  if (!qf) return GAMES.map(g => ({ g, score: 0, inside: null }));
  const out = [];
  for (const g of GAMES) {
    let score = 0, inside = null;

    /* Title. Exact, then exact-ignoring-punctuation, then prefix, then
       contiguous, then words-in-any-order.

       The top two tiers are deliberately SEPARATE. Flattening collapses
       'PICROSS S+' and 'Picross S' onto the same string, and those are two
       different games four years apart, one of them Beaten - handoff 16 calls
       the '+' load-bearing. Folding both into one 1000 tier made them tie, so
       typing the exact title of either put them in an arbitrary order. Now the
       true exact match wins outright and the other is still findable one tier
       down, which is what you want from a search: ranked, not hidden. */
    if (g._t === q) score = 1000;
    else if (g._tf === qf) score = 950;
    else if (g._tf.startsWith(qf)) score = 900;
    else if (g._tf.includes(qf)) score = 800;
    else if (hasAll(g._tf, toks)) score = 700;

    /* Alt titles, same shape one tier down. */
    if (!score) {
      for (let i = 0; i < g._altf.length; i++) {
        const a = g._altf[i];
        if (a === qf) { score = 600; break; }
        if (a.includes(qf)) { score = 500; break; }
        if (hasAll(a, toks)) { score = 450; break; }
      }
    }

    if (!score && g._peoplef.includes(qf)) score = 300;
    else if (!score && hasAll(g._peoplef, toks)) score = 250;
    if (!score && g._miscf.includes(qf)) score = 200;
    else if (!score && hasAll(g._miscf, toks)) score = 150;

    /* Last resort: the words are all here, but spread across fields - "mario
       nintendo" is the title plus the publisher. Ranked below everything so it
       never displaces a real title match. */
    if (!score && hasAll(g._allf, toks)) score = 120;

    /* Computed even when the row already matched on something else. Searching
       "Samurai Shodown" matches SAMURAI SHODOWN NEOGEO COLLECTION by title AND
       finds seven components inside it; the attribution is the useful half and
       used to be thrown away because the title matched first.

       The three components that are ALSO separately-owned standalone rows
       (Samurai Shodown II, IV: Amakusa\'s Revenge, V Special) are two real
       purchases each and both results are correct. The standalone row and the
       "found inside" result both appear. Do NOT deduplicate them - handoff
       9.10. */
    const hits = (g._containsNames || []).filter((_, i) =>
      g._containsf[i].includes(qf) || hasAll(g._containsf[i], toks));
    if (hits.length) { inside = hits; if (!score) score = 100; }

    if (score) out.push({ g, score, inside });
  }
  /* Within a tier, the shorter title is the likelier target: "Mario Kart World"
     should sit above "Mario Kart 8 Deluxe - Booster Course Pass". */
  out.sort((a, b) =>
    b.score - a.score ||
    a.g.title.length - b.g.title.length ||
    a.g.title.localeCompare(b.g.title));
  return out;
}

/* ---------------------------------------------------------------- sorting */

/* 'Q3 2020' -> a sortable number. */
function quarterKey(v) {
  const m = /Q([1-4])\s*(\d{4})/.exec(v || '');
  if (m) return +m[2] * 4 + +m[1];
  const y = /(\d{4})/.exec(v || '');
  return y ? +y[1] * 4 : null;
}
function releaseKey(g) {
  const d = g.releaseDate || '';
  const md = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
  if (md) return +md[3] * 10000 + +md[1] * 100 + +md[2];
  const y = /(\d{4})/.exec(d);
  return y ? +y[1] * 10000 : null;
}

/* Games with no value for the chosen sort always sink to the bottom, in BOTH
   directions. Justin asked for this on completion date specifically: flipping
   between most- and least-recent should never float 3,846 unplayed games to
   the top. The same rule reads correctly for release date too. */
function sortResults(list) {
  const dir = state.dir === 'asc' ? 1 : -1;
  const key = state.sort === 'release' ? releaseKey
            : state.sort === 'completed' ? (g => (g.status === 'Unplayed' ? null : quarterKey(g.completed)))
            : null;
  list.sort((a, b) => {
    if (key) {
      const ka = key(a.g), kb = key(b.g);
      if (ka == null && kb == null) return a.g.title.localeCompare(b.g.title, 'en', { numeric: true });
      if (ka == null) return 1;
      if (kb == null) return -1;
      if (ka !== kb) return (ka - kb) * dir;
      return a.g.title.localeCompare(b.g.title, 'en', { numeric: true });
    }
    return a.g.title.localeCompare(b.g.title, 'en', { numeric: true }) * dir;
  });
}

/* ---------------------------------------------------------------- filters */


/* One sentence per status that is in the completion view but is not `Beaten`,
   because a reader seeing 513 completions against a header of 499 deserves to
   know what the other 14 are. Both glosses lead with what the GAME was, not
   with what I failed to do - neither is a shortfall. */
const STATUS_GLOSS = {
  /* `Abandoned` earns a gloss now that the view is called Played rather than
     Completions: it belongs in the list, and the sentence has to say why it is
     not a completion without calling it a failure. */
  'Abandoned': 'means a game that did have an ending, and I stopped before reaching it.',
  'Sampled': 'means a collection I dipped into that was never something to finish.',
  'Retired': 'means a game with no ending to reach — I stopped, but there was never a finish line.',
  'In Progress': 'means a game or collection I am partway through.'
};

function passes(g) {
  if (state.platform && !(g.platformGroups || []).includes(state.platform)) return false;
  /* "Xbox" is widened to also match a game found ONLY through
     categories.xbox (export_json.py) - most never-owned Game Pass rows never
     carry "Xbox" in `stores` at all (that means a purchase, and Subscription
     is the honest token for them), but they still belong under Store: Xbox
     with a "Game Pass Only" category. Every other store stays a plain
     membership test. */
  if (state.store) {
    const inStores = (g.stores || []).includes(state.store);
    const xboxByCategory = state.store === 'Xbox' && (g.categories || {}).xbox;
    if (!inStores && !xboxByCategory) return false;
  }
  if (state.category) {
    const key = { 'itch.io': 'itch', 'Xbox': 'xbox', 'Nintendo eShop': 'eshop' }[state.store];
    const cats = (g.categories || {})[key] || [];
    if (!cats.includes(state.category)) return false;
  }
  /* One pass over TAG_AXES rather than nine copies of the same three lines.
     `__untagged` is genre's own sentinel - it is a hole in the data, not a
     value in the vocabulary, which is why it cannot just be another option. */
  for (const [key] of TAG_AXES) {
    const want = state[key];
    if (!want) continue;
    if (key === 'genre' && want === '__untagged') {
      if (!(g.flags || []).includes('untagged')) return false;
    } else if (!(g[key] || []).includes(want)) return false;
  }
  if (state.status) {
    const s = state.status;
    /* "Played" is derived as everything that is not Unplayed, never as a list
       of the statuses that happen to exist today. A sixth value joins it on its
       own - handoff 3.3b. */
    if (s === 'played') { if (!g.status || g.status === 'Unplayed') return false; }
    else if (s === 'backlog') { if (!STARS.has(g.id)) return false; }
    else if (g.status !== s) return false;
  }
  /* Link-only filters. `series` used to fall through to a text search; it is a
     real filter now, and the only reason it has no dropdown is its size. */
  for (const [key] of LINK_FILTERS) {
    if (state[key] && !(g[key] || []).includes(state[key])) return false;
  }
  if (state.hideOn && state.hide.length && (g.shovelware || []).some(id => state.hide.includes(id))) return false;
  /* The Played view is every game with ANY status other than `Unplayed`.
     Derived, never a list of the statuses that happen to exist today - a
     seventh value joins it on its own, which is the whole lesson of the
     `Summary` sheet's missing `In Progress` COUNTIF (handoff 7, 3.3b).

     It was called Completions and excluded `Abandoned`, which was right for
     that name and wrong for this one: an abandoned game WAS played. Justin's
     call, 2026-09-05. `Abandoned` keeps its own coral styling here - it sits
     in the list without being dressed up as a completion. */
  if (state.view === 'played' && (!g.status || g.status === 'Unplayed')) return false;
  if (state.flag && !(g.flags || []).includes(state.flag)) return false;
  return true;
}

function compute() {
  RESULTS = search(state.q).filter(r => passes(r.g));
  /* A typed query with the sort control still at its untouched default (A-Z,
     ascending) ranks by relevance instead - that is what makes "mario wonder"
     put the actual game first. But it was overriding EVERY sort choice,
     including one the user had actually clicked, which just looked broken:
     picking "Newest" or "Z-A" mid-search silently kept showing relevance
     order. Any sort other than the untouched default now always applies. */
  const sortIsDefault = state.sort === 'title' && state.dir === 'asc';
  if (!state.q || !sortIsDefault) sortResults(RESULTS);
  RENDERED = 0;
  $('#view').replaceChildren();
  renderCount();
  renderMore();
}

/* Handoff 3.3 asks for the never-owned fact, and calls it the clearest proof
   the ownership model earns its complexity. Every number is read off the
   payload - handoff 7's rule is derive, don't string-replace, and it applies to
   prose as much as to formulas. This exact sentence has already drifted once
   (58 of 504 survived into three places in the v71 handoff after the real
   figure moved), so it is computed here and written down nowhere.

   It was a big green banner at the top of the Stats page until 2026-09-29.
   Justin's call: the statuses are a bar chart now ("What I've played"), and
   the definitions only need to be findable, so they are small print at the
   foot of the page. Built from META.statuses, so a seventh status needs a
   STATUS_GLOSS line and nothing else. */
function statusNotes() {
  const c = META.counts;
  const box = el('div', 'snotes');
  const p1 = el('p');
  p1.appendChild(el('b', null, 'Beaten'));
  p1.append(` includes ${c.beatenNeverOwned} ${c.beatenNeverOwned === 1 ? 'game' : 'games'} I've never owned`);
  const by = (META.neverOwnedBy || []).map(d => `${d.count} ${d.label}`).join(', ');
  p1.append(by ? ` — ${by}.` : '.');
  box.appendChild(p1);
  (META.statuses || [])
    .filter(d => d.count && STATUS_GLOSS[d.value])
    .forEach(d => {
      const p = el('p');
      p.appendChild(el('b', null, d.value));
      p.append(' ' + STATUS_GLOSS[d.value]);
      box.appendChild(p);
    });
  return box;
}

/* ---------------------------------------------------------------- render */

function renderCount() {
  const n = RESULTS.length;
  const bits = [];
  if (state.view === 'played') bits.push('played');
  /* Every active tag filter is named here, not just genre. The count line is
     the one place that always says why the list is the length it is. */
  TAG_AXES.forEach(([k]) => {
    if (state[k]) bits.push(k === 'genre' && state[k] === '__untagged' ? 'untagged' : state[k]);
  });
  if (state.store) bits.push(state.store);
  if (state.platform) bits.push(state.platform);
  LINK_FILTERS.forEach(([k]) => { if (state[k]) bits.push(state[k]); });
  if (state.flag) bits.push(state.flag.replace(/-/g, ' '));
  const label = bits.length ? ' · ' + bits.join(' · ') : '';
  $('#resultcount').innerHTML = `<b>${n.toLocaleString()}</b> game${n === 1 ? '' : 's'}${label}` +
    (state.q ? ` · matching “${esc(state.q)}”` : '');
}

/* Keyed off the status class, not the status name, so an unmapped status gets
   the neutral rail rather than `undefined`. */
const ROW_CLASS = { b: 'beaten', a: 'abandoned', p: 'progress', s: 'sampled', r: 'retired', x: 'other' };

function rowNode(r) {
  const g = r.g;
  const sl = statusLine(g);
  const a = el('a', 'row' + (sl ? ' ' + ROW_CLASS[sl.cls] : ''));
  a.href = '#/game/' + g.id;

  const cov = el('span', 'cov');
  if (hasCover(g.id)) {
    const img = el('img'); img.loading = 'lazy'; img.alt = '';
    img.onload = () => fitShape(img);
    img.src = 'covers/' + g.id + '.webp';
    img.onerror = () => { img.remove(); cov.textContent = 'no cover'; };
    cov.appendChild(img);
  } else cov.textContent = 'no cover';
  a.appendChild(cov);

  const main = el('span', 'main');
  const t = el('span', 'rtitle');
  t.appendChild(el('span', 't', g.title));
  const y = year(g); if (y) t.appendChild(el('span', 'yr', y));
  main.appendChild(t);

  const meta = el('span', 'meta');
  const push = (node, sep = true) => {
    if (sep && meta.childNodes.length) meta.appendChild(el('span', 'sep', '·'));
    meta.appendChild(node);
  };
  if (sl) push(el('span', 'st ' + sl.cls, sl.text), false);
  if (g.genre && g.genre.length) push(el('em', null, g.genre.join(' · ')));
  else if ((g.flags || []).includes('untagged')) push(el('span', 'flag gap', 'untagged'));
  if (g.developers && g.developers.length) push(document.createTextNode(g.developers[0]));
  const an = accessNote(g);
  if (an) push(el('span', an.kind === 'flag' ? 'flag' : 'whisper', an.text));
  main.appendChild(meta);

  if (r.inside) {
    const ins = el('span', 'inside');
    ins.append('↳ found inside — contains ');
    ins.appendChild(el('b', null, r.inside.slice(0, 3).join(', ')));
    if (r.inside.length > 3) ins.append(` and ${r.inside.length - 3} more`);
    main.appendChild(ins);
  }
  a.appendChild(main);

  const right = el('span', 'rright');
  if (g.platforms && g.platforms.length) right.appendChild(el('span', 'plat', simplifyPlatforms(g.platforms).slice(0, 2).join(' · ')));
  if (g.length && g.length.length) right.appendChild(el('span', 'len', g.length[0]));
  a.appendChild(right);
  a.appendChild(starButton(g.id));
  return a;
}

/* Grid card. Same status rail colouring as a list row (ROW_CLASS), but the
   card's job is different: art is the hero, and the title has to sit ON TOP
   of it rather than beside it, because so many titles are too long to fit a
   card-width line - "Super Mario Bros. Wonder: Nintendo Switch 2 Edition +
   Meetup in Bellabel Park" is a real one. A dark scrim (built from --ink, so
   it reads as this site's own colour rather than a generic black overlay)
   sits under the title and clamps to three lines instead of truncating to
   one, so the difference between two long titles stays legible.

   Cards are cropped to fill a uniform box (object-fit: cover) rather than
   letterboxed like the detail hero and list thumb - a scannable grid of
   hundreds of tiles wants one consistent shape more than it wants every
   landscape itch.io cover shown whole. That is a deliberate difference from
   fitShape()'s rule elsewhere on the site, not an oversight of it.

   Rows with no cover art (roughly 6% of the library, and it will never be
   100% - handoff) get a placeholder tile in the same shape, coloured like
   the list row's own `.cov` placeholder, with the title and platforms simply
   printed on it instead of scrimmed over an image. */
function cardNode(r) {
  const g = r.g;
  const sl = statusLine(g);
  const has = hasCover(g.id);
  const a = el('a', 'card' + (has ? ' has-cover' : ' no-cover') + (sl ? ' ' + ROW_CLASS[sl.cls] : ''));
  a.href = '#/game/' + g.id;

  const art = el('div', 'card-art');
  if (has) {
    const img = el('img'); img.loading = 'lazy'; img.alt = '';
    img.src = 'covers/' + g.id + '.webp';
    img.onerror = () => { img.remove(); a.classList.remove('has-cover'); a.classList.add('no-cover'); };
    art.appendChild(img);
  }
  if (sl) art.appendChild(el('span', 'card-chip ' + sl.cls, shortStatus(g)));
  art.appendChild(starButton(g.id));
  a.appendChild(art);

  const ov = el('div', 'card-ov');
  ov.appendChild(el('div', 'card-t', g.title));
  const plat = simplifyPlatforms(g.platforms || []).slice(0, 2).join(' · ');
  if (plat) ov.appendChild(el('div', 'card-p', plat));
  a.appendChild(ov);
  return a;
}

function renderMore() {
  if (state.mode !== 'list') return;
  const view = $('#view');
  if (!RESULTS.length) {
    const e = el('div', 'empty');
    e.appendChild(el('b', null, 'Nothing matches'));
    e.append('Try clearing a filter, or searching for a game inside a collection.');
    view.appendChild(e);
    return;
  }
  const grid = state.layout === 'grid';
  const wrapClass = grid ? 'cardgrid' : 'rows';
  let wrap = view.querySelector('.' + wrapClass);
  if (!wrap) { wrap = el('div', wrapClass); view.appendChild(wrap); }
  const slice = RESULTS.slice(RENDERED, RENDERED + PAGE);
  const frag = document.createDocumentFragment();
  slice.forEach(r => frag.appendChild(grid ? cardNode(r) : rowNode(r)));
  wrap.appendChild(frag);
  RENDERED += slice.length;
}

/* ---------------------------------------------------------------- detail */

const REL = [
  ['otherVersions', 'Other versions owned', 'other copies of this same game'],
  ['contains', 'Contains', 'separate games in this box'],
  ['dlc', 'Expansions & DLC owned', 'add-ons that need the base game'],
  ['altTitles', 'Alt titles', 'search aliases only'],
  ['partsCompleted', 'Parts completed', 'which components are finished']
];

/* Every tag on a game page filters the library by that tag.

   It used to filter only for `genre` and fall through to a free-text SEARCH for
   the other eight axes, so clicking `Single Player` searched the library for
   the words "single player" and found nothing - the tag was a link that
   promised a filter and delivered zero results. The heading above these tags
   says "every one filters the library", and now every one does. */
function tagLink(axis, value, cls) {
  const a = el('a', 'tagl' + (cls ? ' ' + cls : ''), value);
  a.href = '#/?' + axis + '=' + encodeURIComponent(value);
  return a;
}

/* --- old-URL rescue -------------------------------------------------------
   Merges retire `Site ID`s: seventeen went at v137 alone, and two of those
   were RETITLES, where the row still exists at a new address. A bookmark to
   any of them used to land on a bare "No such game".

   The map is DERIVED, never a hardcoded list of dead ids. Every `Alt Titles`
   and `Other Versions Owned` value is slugged, and any that is not itself a
   live id becomes an alias for the row carrying it. That is exactly the column
   the chat merges a retired title into, so this keeps working for merges that
   have not happened yet - including the `999: Nine Hourse` retitle waiting in
   RETURN_TO_CHAT.md.

   An alias claimed by two different rows is DROPPED, never guessed:
   `Batman: Return to Arkham` split into Arkham Asylum and Arkham City, and
   silently picking one would be worse than saying the link is dead. Those fall
   through to the not-found page, which now offers the search instead. */
const idSlug = t => String(t)
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\+/g, ' plus ')
  .replace(/[^\x00-\x7F]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 60);

let ALIAS = null;
function aliasIndex() {
  if (ALIAS) return ALIAS;
  const live = new Set(GAMES.map(g => g.id));
  ALIAS = new Map();
  const claim = (raw, id) => {
    const s = idSlug(raw);
    if (!s || live.has(s)) return;          /* never shadow a real page */
    if (!ALIAS.has(s)) ALIAS.set(s, id);
    else if (ALIAS.get(s) !== id) ALIAS.set(s, null);   /* contested */
  };
  GAMES.forEach(g => {
    (g.altTitles || []).forEach(t => claim(t, g.id));
    /* `otherVersions` entries are objects since the store-only display
       change - `{name, stores}`, `name` already stripped of any ownership
       suffix by export_json.py's parse_other_versions. */
    (g.otherVersions || []).forEach(t => claim(t.name, g.id));
  });
  return ALIAS;
}

/* Best-effort recovery for a dead id with no alias. Words shared with a live
   title, most first; a single shared word is noise, not a suggestion, so it is
   dropped. Ties are all returned - `batman-return-to-arkham` genuinely IS two
   games and showing both is the honest answer. */
function didYouMean(id) {
  const want = new Set(id.split('-').filter(w => w.length > 2));
  if (!want.size) return [];
  const scored = [];
  GAMES.forEach(g => {
    const have = new Set(idSlug(g.title).split('-'));
    let n = 0; want.forEach(w => { if (have.has(w)) n++; });
    if (n) scored.push([n, g]);
  });
  if (!scored.length) return [];
  const best = Math.max(...scored.map(x => x[0]));
  if (best < 2) return [];
  return scored.filter(x => x[0] === best)
               .map(x => x[1])
               .sort((a, b) => a.title.localeCompare(b.title))
               .slice(0, 4);
}

/* Which games actually have cover art. `META.covers` is the list of Site IDs
   with a file on disk, not a flag - art lands in waves, so asking for every
   row's image would 404 on the thousands not done yet. An empty list is
   truthy in JS, which is exactly the bug a plain `if (META.covers)` would
   reintroduce, so always go through hasCover(). */
let COVERSET = null;
const hasCover = id => {
  /* Built on first use, NOT at load: META is still null while the payload is
     being fetched, and touching it here threw before anything rendered. */
  if (COVERSET === null) COVERSET = new Set(Array.isArray(META && META.covers) ? META.covers : []);
  return COVERSET.has(id);
};

/* Cover art is not one shape, so one crop rule cannot serve all of it.
   Every store ships portrait box art EXCEPT itch.io, whose standard cover is
   630x500 - landscape by design. Justin owns 1,745 itch.io games, so the
   library will eventually hold well over a thousand landscape covers, plus a
   handful of store banners Playnite filed as box art (`Hades` arrived as a
   460x215 Steam header).

   Cropping those to fill a portrait slot throws away most of the picture. So:
   portrait art fills the slot as before, and anything square or wider is fitted
   INSIDE it instead - the whole image, uncropped, on the slot's own background.
   Nothing is ever stretched either way. Measured from the decoded image, so it
   needs no data from the payload and works for art that has not arrived yet. */
function fitShape(img) {
  if (!img.naturalWidth || !img.naturalHeight) return;
  if (img.naturalWidth / img.naturalHeight > 1.02) img.classList.add('wide');
}

/* Fetched once, on the first detail page, and reused after that. The promise
   itself is cached rather than the result, so two rapid navigations share one
   request instead of firing two. */
let DESC_PROMISE = null;
function loadDescriptions() {
  if (!DESC_PROMISE) {
    /* Cache-buster taken from THIS script's own stamped URL. `index.html` is
       written with `app.js?v=<hash>` and that hash covers descriptions.json
       too, so a description-only change still lands on a fresh URL. Reading it
       back here avoids a second version field that could disagree - and
       `library.json` is not rewritten when only descriptions move, so a field
       inside it could not have carried this. */
    const stamp = (document.querySelector('script[src*="app.js"]') || {}).src || '';
    const v = (stamp.match(/[?&]v=([^&]+)/) || [, ''])[1];
    DESC_PROMISE = fetch('data/descriptions.json' + (v ? '?v=' + v : ''))
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}));
  }
  return DESC_PROMISE;
}

function renderDetail(id) {
  const g = GAMES.find(x => x.id === id);
  const view = $('#view');
  state.mode = 'detail';
  view.replaceChildren();
  $('#browse').hidden = true;
  $('#stats').hidden = true;
  $('#sentinel').hidden = true;
  if (!g) {
    /* Reachable for real now: `syndicate` was merged away at v120, so any
       old link or bookmark to a retired Site ID lands here. Reset the title
       too - renderDetail sets it only on the found path, so without this the
       tab keeps the previously-viewed game's name on a dead link. */
    const moved = aliasIndex().get(id);
    if (moved) {
      /* `replace`, not `assign`: the dead id must not sit in history, or Back
         from the game lands on it and bounces straight forward again. */
      location.replace('#/game/' + moved);
      return;
    }
    document.title = 'Game Library';
    const e = el('div', 'empty');
    e.appendChild(el('b', null, 'No such game'));
    /* No alias, so the row was split rather than merged - `Batman: Return to
       Arkham` became Arkham Asylum and Arkham City. Handing the id straight to
       the search box does NOT work: search is an AND over every word, and no
       one row contains `batman` AND `return` AND `arkham`, so it lands on
       "Nothing matches" - a dead end dressed up as a route. Score the live
       titles on shared words instead and offer the best ones directly. */
    const near = didYouMean(id);
    if (near.length) {
      e.appendChild(el('div', 'plain', 'It may have been split or renamed. Did you mean:'));
      const list = el('div', 'plain');
      near.forEach((n, i) => {
        if (i) list.append(' \u00b7 ');
        const a = el('a', null, n.title); a.href = '#/game/' + n.id; list.appendChild(a);
      });
      e.appendChild(list);
    }
    const back = el('a', null, '\u2190 Back to the library'); back.href = lastListUrl;
    e.appendChild(back);
    view.appendChild(e);
    return;
  }
  document.title = g.title + ' — Game Library';

  const crumb = el('div', 'crumb');
  /* The last library URL actually visited, filters and search intact - never
     a hardcoded '#/'. Justin's ask, 2026-09-10: this link used to reset to the
     bare homepage no matter what was filtered when you left it. */
  const back = el('a', null, backFromDetail ? backFromDetail.label : '← Library');
  back.href = backFromDetail ? backFromDetail.href : lastListUrl;
  crumb.appendChild(back);
  view.appendChild(crumb);

  const head = el('div', 'dhead');
  const cov = el('div', 'cover-slot');
  if (hasCover(g.id)) {
    const img = el('img'); img.alt = '';
    img.onload = () => fitShape(img);
    img.src = 'covers/' + g.id + '.webp';
    img.onerror = () => { img.remove(); cov.append('◻', el('div', null, 'cover art'), el('div', null, 'coming soon')); };
    cov.appendChild(img);
  } else { cov.append('◻'); cov.appendChild(el('div', null, 'cover art')); cov.appendChild(el('div', null, 'coming soon')); }
  head.appendChild(cov);

  const dt = el('div', 'dtitle');
  dt.appendChild(el('h1', null, g.title));
  const sub = el('div', 'dsub');
  const y = year(g); if (y) sub.append(y);
  /* A studio that both made and published a game appears in BOTH columns, and
     the byline used to print it twice - `MidBoss · MidBoss`. 1,555 of 4,321
     rows are affected and on 1,152 the two lists are identical, so this is the
     common case, not the edge one. Dedupe on the way in; order is preserved,
     developers first, so the reading is unchanged where the names differ. */
  [...new Set([...(g.developers || []), ...(g.publishers || [])])].slice(0, 4).forEach(p => {
    if (sub.childNodes.length) sub.append(' · ');
    const a = el('a', null, p); a.href = '#/?q=' + encodeURIComponent(p); sub.appendChild(a);
  });
  dt.appendChild(sub);

  const st = el('div', 'statusline');
  const sl = statusLine(g);
  if (sl) { const p = el('span', 'spill ' + sl.cls); p.appendChild(el('span', 'dot')); p.append(sl.text); st.appendChild(p); }
  const ownedText = g.owned ? 'Owned' : 'Not owned';
  st.appendChild(el('span', 'spill' + (g.owned ? '' : ' no'), ownedText));
  /* `Access` is the workbook's own richer answer (Playable, "Requires
     resubscribe (GWG)", "No access - service shut down") and earns a second
     pill - except when it's just "Not owned" again, word for word, which
     happens whenever nothing more specific was on record. `Yakuza 0` showed
     "Not owned" twice for exactly this reason. */
  if (g.access && g.access !== ownedText) st.appendChild(el('span', 'spill', g.access));
  st.appendChild(starButton(g.id));
  dt.appendChild(st);
  dt.appendChild(el('div', 'slug', hasCover(g.id) ? 'covers/' + g.id + '.webp' : g.id));
  head.appendChild(dt);
  view.appendChild(head);

  /* Descriptions live in their own file and are fetched the first time any
     detail page opens - never in `library.json`, which every visit loads to
     power search and the filters. Full text there would take it from 2.4 MB to
     about 8 MB for prose most visits never read.

     The HTML is third-party store copy, sanitised at export time down to a
     14-tag allowlist with every attribute dropped: no `img`, `iframe`, `a`,
     `script`, `src` or `href` survives, so `innerHTML` here has nothing left to
     inject. Verified on all 4,150 values. */
  const dbox = el('div', 'desc-empty', 'Loading description…');
  view.appendChild(dbox);
  loadDescriptions().then(map => {
    const html = map && map[g.id];
    if (html) {
      dbox.className = 'desc';
      dbox.innerHTML = html;
    } else {
      dbox.className = 'desc-empty';
      dbox.textContent = 'No description yet.';
    }
  }).catch(() => {
    dbox.className = 'desc-empty';
    dbox.textContent = 'No description yet.';
  });

  /* Ownership & access first - it is the main thing you want when you look a
     game up. Tags second. */
  const own = el('div', 'fieldset');
  own.appendChild(el('div', 'fs-label', 'Ownership & access'));
  const dl1 = el('dl', 'kv');
  const kv = (dl, k, node) => { dl.appendChild(el('dt', null, k)); const d = el('dd'); d.appendChild(node); dl.appendChild(d); };
  if (g.ownedOn && g.ownedOn.length) kv(dl1, 'Owned on', el('span', 'plain', simplifyPlatforms(g.ownedOn).join(' · ')));
  if (g.availableOn && g.availableOn.length) kv(dl1, 'Available on', el('span', 'plain', simplifyPlatforms(g.availableOn).join(' · ')));
  if (g.stores && g.stores.length) {
    const d = el('span'); d.style.display = 'contents';
    const wrapper = el('span'); wrapper.style.display = 'flex'; wrapper.style.flexWrap = 'wrap'; wrapper.style.gap = '6px';
    /* "Xbox" reads as a purchase everywhere else on this page, and for a pure
       GWG freebie (no separate real purchase - see the "owned" precedence in
       export_json.py) it never was one. Shown as "Subscription" instead,
       deep-linked straight to the Games With Gold category rather than the
       plain Store: Xbox link every other pill gets. A game that ALSO has a
       real Xbox purchase (the "owned" category) keeps the honest "Xbox" pill
       - this only fires for the gwg-only case. */
    const xboxCats = (g.categories || {}).xbox || [];
    const gwgOnly = xboxCats.length === 1 && xboxCats[0] === 'gwg';
    /* A store holding only PART of a collection gets a dashed pill. The rule
       is the chat's (handoff v229): wherever `Complete Edition On` is filled,
       every store NOT named in it is partial. Deliberately not derived from
       the `Contains` suffixes - that guess misfires on Tomb Raider I-III,
       where Steam holds a component AND the full set. Blank `Complete Edition
       On` is the normal case and means nothing here: no pill goes dashed. */
    const full = g.completeEditionOn || [];
    g.stores.forEach(s => {
      const isGwgXbox = s === 'Xbox' && gwgOnly;
      const partial = full.length > 0 && !full.includes(s);
      const a = el('a', 'tagl' + (partial ? ' partial' : ''), isGwgXbox ? 'Subscription' : s);
      a.href = isGwgXbox ? '#/?store=Xbox&category=gwg' : '#/?store=' + encodeURIComponent(s);
      if (partial) {
        /* Name the part when `Contains` records it (Google Play -> "Sonic CD");
           otherwise say so generically - SEGA's eShop copy is partial because
           the Switch release lacks the PC-only games, which no suffix names. */
        const parts = (g.contains || []).filter(c => (c.ownedOn || []).includes(s)).map(c => c.name);
        a.title = parts.length ? 'Only ' + parts.join(', ') : 'Only part of this collection';
      }
      wrapper.appendChild(a);
    });
    /* The tooltip never fires on a phone, so the dashed style gets a one-line
       key beside it - only on the handful of rows that actually use it. */
    if (full.length && g.stores.some(s => !full.includes(s))) {
      wrapper.appendChild(el('span', 'partnote', 'dashed = only part of the collection'));
    }
    kv(dl1, 'Stores', wrapper);
  }
  /* Complete Edition On - workbook column 43, added at v94 for exactly one
     question: Justin owns Alice: Madness Returns on four stores and cannot tell
     which store's copy is the Complete Collection without opening each launcher.
     `Stores` says he owns it somewhere; it never says what that store's copy IS.

     So this sits directly under Stores, styled to be read at a glance rather
     than hunted for - answering the question is the whole point of the column.

     EMPTY IS THE NORMAL CASE (4,311 of 4,338 rows) and is NOT a data gap: it
     only means anything where a game's copies genuinely differ. Nothing here
     renders a placeholder, a "needs filling" prompt or a missing-data flag, and
     it is deliberately absent from the health view. */
  if (g.completeEditionOn && g.completeEditionOn.length) {
    const w = el('span', 'cedition');
    w.appendChild(el('span', 'ce-tick', '\u2605'));
    const lbl = el('span', 'ce-txt');
    lbl.append('Complete edition on ');
    g.completeEditionOn.forEach((sname, i) => {
      if (i) lbl.append(g.completeEditionOn.length > 2 && i < g.completeEditionOn.length - 1 ? ', ' : ' and ');
      const a = el('a', 'ce-store', sname);
      a.href = '#/?store=' + encodeURIComponent(sname);
      lbl.appendChild(a);
    });
    w.appendChild(lbl);
    kv(dl1, 'Complete edition', w);
  }
  if (g.ownership && g.ownership.length) kv(dl1, 'Ownership', el('span', 'plain', g.ownership.join(' · ')));
  /* The one row (so far) where "Game Pass Only" undersells it: a real Xbox
     purchase exists, just not of the base game. Derived in export_json.py
     from the DLC's own store suffix - see xbox_note there. */
  if (g.xboxNote) kv(dl1, 'Note', el('span', 'plain', g.xboxNote));
  if (g.playedOn && g.playedOn.length) kv(dl1, 'Played on', el('span', 'plain mono', g.playedOn.map(simplifyPlatform).join(' · ')));
  /* Finished / stopped / played - three meanings, so the label is looked up,
     never assumed. Handoff 9.13. */
  if (g.completed) kv(dl1, (statusMeta(g) || {}).dateLabel || 'Completed', el('span', 'plain mono', g.completed));
  own.appendChild(dl1);
  view.appendChild(own);

  const tags = el('div', 'fieldset');
  tags.appendChild(el('div', 'fs-label', 'Tags — every one filters the library'));
  const dl2 = el('dl', 'kv');
  TAG_AXES.forEach(([key, label]) => {
    const vals = g[key] || [];
    if (!vals.length) return;
    const w = el('span'); w.style.display = 'flex'; w.style.flexWrap = 'wrap'; w.style.gap = '6px';
    vals.forEach(v => w.appendChild(tagLink(key, v)));
    kv(dl2, label, w);
  });
  /* Series is a LIST. A game can sit in more than one - Hyrule Warriors: Age
     of Imprisonment belongs to both Hyrule Warriors and Breath of the Wild, and
     rendering the raw cell made that one unclickable blob. */
  if ((g.series || []).length) {
    const w = el('span'); w.style.display = 'flex'; w.style.flexWrap = 'wrap'; w.style.gap = '6px';
    g.series.forEach(v => w.appendChild(tagLink('series', v)));
    kv(dl2, g.series.length > 1 ? 'Series' : 'Series', w);
  }
  /* Switch folders live with the tags, per Justin. Still never a search facet
     and never merged into Genre - handoff 5 and 15. */
  if (g.shelf && g.shelf.length) {
    const w = el('span'); w.style.display = 'flex'; w.style.flexWrap = 'wrap'; w.style.gap = '6px';
    g.shelf.forEach(s => { const a = el('a', 'tagl shelf', s); a.href = '#/?shelf=' + encodeURIComponent(s); w.appendChild(a); });
    kv(dl2, 'Switch shelf', w);
  }
  if (dl2.childNodes.length) { tags.appendChild(dl2); view.appendChild(tags); }

  /* The five relationship columns get five separate boxes. Conflating them has
     caused real bugs - handoff 4. */
  const rels = REL.filter(([k]) => (g[k] || []).length);
  if (rels.length) {
    const fs = el('div', 'fieldset');
    fs.appendChild(el('div', 'fs-label', 'Relationships — five separate questions'));
    const box = el('div', 'rel');
    const doneMap = {};
    (g.partsCompleted || []).forEach(p => {
      const i = p.lastIndexOf(' - ');
      /* simplifyPlatform() here, same as `Played On` and Contains' "also
         owned on" already get - Justin's ask, 2026-09-17, noticed on
         Guacamelee: the completion checkmark should read "PC", not the raw
         "PC (Windows)" workbook value; for a completion he only cares which
         platform, not the storefront-flavored spelling of it. */
      if (i > 0) doneMap[p.slice(0, i).trim()] = simplifyPlatform(p.slice(i + 3).trim());
    });
    rels.forEach(([key, label, hint]) => {
      /* The standalone Parts Completed box is redundant whenever Contains OR
         Other Versions Owned is showing - both already carry the same fact
         as a "✓ <date>" checkmark right next to the part/edition it belongs
         to (see doneMap above). Justin's ask, 2026-09-17, noticed on
         Guacamelee: with Other Versions Owned showing "Guacamelee! Gold
         Edition ✓ PC (Q3 2014)", a separate "Parts Completed: Guacamelee!
         Gold Edition - PC (Windows) (Q3 2014)" box underneath is just the
         same fact twice, in the least-simplified spelling of the two. */
      if (key === 'partsCompleted' && ((g.contains || []).length || (g.otherVersions || []).length)) return;
      const b = el('div', 'relbox');
      const rh = el('div', 'rh'); rh.appendChild(el('b', null, label)); rh.appendChild(el('i', null, hint));
      b.appendChild(rh);
      const ul = el('ul');
      g[key].forEach(entry => {
        /* `contains` and `otherVersions` entries are objects; every other
           relationship column is still a plain string. `partsCompleted`
           itself is "Name - Platform (Date)" and only reaches this render at
           all when neither box above already showed it - same platform
           simplification as doneMap, so it never shows the raw "PC
           (Windows)" spelling either. */
        const isObj = key === 'contains' || key === 'otherVersions';
        let v = isObj ? entry.name : entry;
        if (key === 'partsCompleted') {
          const i = v.lastIndexOf(' - ');
          if (i > 0) v = v.slice(0, i + 3) + simplifyPlatform(v.slice(i + 3));
        }
        const li = el('li');
        const match = GAMES.find(x => x.title === v);
        if (match) { const a = el('a', null, v); a.href = '#/game/' + match.id; li.appendChild(a); }
        else li.append(v);
        /* `Parts Completed` can name an `Other Versions Owned` entry too, not
           just a `Contains` component - Trine 4: The Nightmare Prince is
           genuinely beaten and is also the pre-merge edition now listed here.
           Same checkmark, same doneMap, just not scoped to Contains alone. */
        if ((key === 'contains' || key === 'otherVersions') && doneMap[v]) {
          li.appendChild(el('span', 'done', '✓ ' + doneMap[v]));
        }
        /* Justin's ask, in his words: "if I own one part of a complete
           collection on GOG, it should say that in the Contains section."
           Blank means the part comes only with the box, which is the common
           case and deliberately renders nothing at all. */
        if (key === 'contains' && entry.ownedOn && entry.ownedOn.length) {
          const own = el('span', 'own-sep');
          own.append(' also owned on ');
          entry.ownedOn.forEach((t, i) => {
            if (i) own.append(', ');
            own.appendChild(el('b', null, simplifyPlatform(t)));
          });
          li.appendChild(own);
        }
        /* Justin's ask, 2026-09-14: "where to find" this other version should
           list just the store(s), not the platform - "it will look cleaner."
           A suffix that was platform-only leaves `stores` empty, same
           blank-means-nothing-to-say rule as Contains above. */
        if (key === 'otherVersions' && entry.stores && entry.stores.length) {
          const own = el('span', 'own-sep');
          own.append(' on ');
          entry.stores.forEach((t, i) => {
            if (i) own.append(', ');
            own.appendChild(el('b', null, t));
          });
          li.appendChild(own);
        }
        ul.appendChild(li);
      });
      b.appendChild(ul);
      box.appendChild(b);
    });
    fs.appendChild(box);
    view.appendChild(fs);
  }

  if ((g.completionNotes || []).length) {
    /* On the two `Sampled` anthologies the note is the whole story - it carries
       the detail the status deliberately no longer does (handoff 9.13), so it
       gets its own heading rather than being called a completion. */
    const sm = statusMeta(g);
    const fs = el('div', 'fieldset');
    fs.appendChild(el('div', 'fs-label', (sm && sm.notesLabel) || 'Completion notes'));
    const n = el('div', 'notes' + (sm && sm.cls !== 'b' ? ' ' + sm.cls : ''));
    g.completionNotes.forEach(t => n.appendChild(el('p', null, t)));
    fs.appendChild(n);
    view.appendChild(fs);
  }
  if (g.switchNotes) {
    const fs = el('div', 'fieldset');
    fs.appendChild(el('div', 'fs-label', 'Switch notes'));
    fs.appendChild(el('div', 'plain', g.switchNotes));
    view.appendChild(fs);
  }
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- filter UI */

/* Closes every open dropdown panel this function built - called before
   opening a different one (only one at a time, same as a native <select>),
   and from the document-level click/Escape handlers registered at boot. Safe
   to call with nothing open. */
function closeAllDropdowns() {
  document.querySelectorAll('.dpanel:not([hidden])').forEach(p => { p.hidden = true; });
  document.querySelectorAll('.dtrigger[aria-expanded="true"]')
    .forEach(t => t.setAttribute('aria-expanded', 'false'));
}

function buildFilters() {
  const box = $('#filters');
  box.replaceChildren();

  /* Replaces a native <select> with a button that opens a floating panel of
     its own - the same shape Sort and Hide already use elsewhere on this
     page, chosen here so the panel can carry a HEADER: the field's name and,
     for anything with more than a couple of values, a small #/A-Z switch
     that reorders just that one list. A native <select>'s popup is drawn by
     the OS and cannot hold either.

     `rows(order)` returns this field's options for a given order - callers
     that pin an entry first or last (Status's `Played`, Genre's `Untagged`)
     do that inside their own `rows`, not here, so this function never needs
     to know which fields have exceptions. `parent` defaults to the
     always-visible bar; the More-filters panel passes itself. `onClear` is
     what the lone × next to an active filter runs - Store also clears the
     dependent Category, so this stays the caller's rule rather than a
     generic "set state[key] = ''" this function would get wrong. */
  const mkDropdown = (key, label, rows, value, allLabel, opts) => {
    const o = opts || {};
    const g = el('span', 'fgroup');
    g.appendChild(el('label', null, label));

    const dwrap = el('span', 'ddwrap');
    const trigger = el('button', 'dtrigger' + (value ? ' active' : '') + (o.cls ? ' ' + o.cls : ''));
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    const triggerText = el('span', null, allLabel);
    trigger.append(triggerText, el('span', 'arrow', '▾'));
    dwrap.appendChild(trigger);
    if (value && o.onClear) {
      trigger.classList.add('clearable');
      const x = el('button', 'fselclear', '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Clear ' + label);
      x.onclick = e => { e.preventDefault(); e.stopPropagation(); o.onClear(); };
      dwrap.appendChild(x);
    }
    g.appendChild(dwrap);

    const panel = el('div', 'dpanel');
    panel.hidden = true;
    /* `dphead`, not `dhead` - `dhead` is already the detail page's own
       cover+title row and the class collision was silently eating this
       header's padding (see the CSS comment on `.dphead`). */
    const head = el('div', 'dphead');
    head.appendChild(el('h6', null, label));
    let order = (o.sortable === false) ? 'count' : (optSort[key] || 'count');
    if (o.sortable !== false) {
      const tog = el('div', 'ordertoggle');
      const bCount = el('button', order === 'count' ? 'on' : '', '#');
      const bAlpha = el('button', order === 'alpha' ? 'on' : '', 'A–Z');
      bCount.type = 'button'; bAlpha.type = 'button';
      const pick = (which, btn, other) => {
        order = which; optSort[key] = which; saveOptSort(optSort);
        btn.classList.add('on'); other.classList.remove('on');
        renderOptions();
      };
      bCount.onclick = e => { e.stopPropagation(); pick('count', bCount, bAlpha); };
      bAlpha.onclick = e => { e.stopPropagation(); pick('alpha', bAlpha, bCount); };
      tog.append(bCount, bAlpha);
      head.appendChild(tog);
    }
    panel.appendChild(head);
    /* Status is a short, fixed, fully-enumerable list (nine rows, max) - the
       shared `.doptions` 300px cap was built for the long filters (Genre,
       Platform, Store) that genuinely need a scrollbar, and clipped the
       bottom two Status rows (`Unplayed`, `Priority backlog`) with no visible
       scroll affordance to say there was more below. Justin's ask, 2026-09-14
       ("I need an Unplayed... it can go at the bottom under abandoned") - it
       was already there in STATUS_ORDER, just invisible. `doptions-short`
       opts this one dropdown out of the cap instead of raising it everywhere. */
    const list = el('div', 'doptions' + (key === 'status' ? ' doptions-short' : ''));
    panel.appendChild(list);

    function renderOptions() {
      list.replaceChildren();
      const any = el('button', 'dopt' + (value ? '' : ' on'));
      any.type = 'button';
      any.appendChild(el('span', null, allLabel));
      any.onclick = () => { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); o.onSelect(''); };
      list.appendChild(any);
      rows(order).forEach(r => {
        const b = el('button', 'dopt' + (r.value === value ? ' on' : ''));
        b.type = 'button';
        b.appendChild(el('span', null, r.label));
        if (r.count != null) b.appendChild(el('span', 'n', r.count.toLocaleString()));
        b.onclick = () => { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); o.onSelect(r.value); };
        list.appendChild(b);
      });
    }
    renderOptions();

    /* The selected row's own label, looked up rather than re-derived, so the
       trigger reads exactly what the open panel would highlight - Genre's
       `Unknown` shows its explanatory text, not the bare value. */
    if (value) {
      const selRow = rows('count').find(r => r.value === value);
      triggerText.textContent = selRow ? selRow.label : allLabel;
    }

    trigger.onclick = e => {
      e.stopPropagation();
      const opening = panel.hidden;
      closeAllDropdowns();
      panel.hidden = !opening;
      trigger.setAttribute('aria-expanded', String(opening));
    };
    panel.onclick = e => e.stopPropagation();

    g.appendChild(panel);
    (o.parent || box).appendChild(g);
    return g;
  };

  const fx = META.facets;
  /* Shared by every plain facet-backed field (Platform, Store, and each of
     the eight More-filters axes) - Genre and Status build their own `rows`
     instead, since each pins an entry or two out of the normal order. */
  const facetRows = facet => order => {
    const list = order === 'alpha'
      ? [...facet].sort((a, b) => a.value.localeCompare(b.value, 'en', { numeric: true }))
      : facet;
    return list.map(f => ({ value: f.value, label: f.value, count: f.count }));
  };

  mkDropdown('platform', 'Platform', facetRows(fx.platform), state.platform, 'Any platform',
    { onClear: () => { state.platform = ''; sync(); },
      onSelect: v => { state.platform = v; sync(); } });

  mkDropdown('store', 'Store', facetRows(fx.store), state.store, 'All stores',
    { onClear: () => { state.store = ''; state.category = ''; sync(); },
      onSelect: v => { state.store = v; state.category = ''; sync(); } });

  /* Category only exists for the three stores that have one. Not rendered at
     all otherwise - no permanently dead control. A curated parent/child list
     of two or three entries, so no sort toggle - alphabetising it would
     separate a child from the parent it is indented under. */
  const cats = META.storeCategories[state.store];
  if (cats) {
    const catRows = () => cats.map(c => ({ value: c.id, label: c.label }));
    const cg = mkDropdown('category', 'Category', catRows, state.category, 'All categories',
      { cls: 'dep', sortable: false,
        onClear: () => { state.category = ''; sync(); },
        onSelect: v => { state.category = v; sync(); } });
    cg.classList.add('appears');
  }

  /* `Unknown` is a real, selectable Genre value (an itch.io bundle row whose
     description gave no clean genre signal) rather than a hole in the data -
     that's what makes it different from `__untagged` below. But it's also
     the single largest Genre value in the sheet, so sorted with everything
     else it would land at the TOP of the dropdown, ahead of every real
     genre. Pinned after the real vocabulary instead, in both orders, with a
     label that says what it means. `Untagged` only appears at all once its
     count is nonzero - a choice that can never return a result is clutter,
     not a choice (it sat at 0 once the chat cleared the last gap). */
  const genreCore = fx.genre.filter(f => f.value !== 'Unknown');
  const unknownGenre = fx.genre.find(f => f.value === 'Unknown');
  const genreRows = order => {
    const list = order === 'alpha'
      ? [...genreCore].sort((a, b) => a.value.localeCompare(b.value, 'en', { numeric: true }))
      : genreCore;
    const rows = list.map(f => ({ value: f.value, label: f.value, count: f.count }));
    if (unknownGenre) {
      rows.push({ value: 'Unknown', label: 'Unknown (itch.io bundle, no genre signal)', count: unknownGenre.count });
    }
    if (META.counts.untagged) rows.push({ value: '__untagged', label: 'Untagged', count: META.counts.untagged });
    return rows;
  };
  mkDropdown('genre', 'Genre', genreRows, state.genre, 'Any genre',
    { onClear: () => { state.genre = ''; sync(); },
      onSelect: v => { state.genre = v; sync(); } });

  /* Built from META.statuses, which is tallied off the workbook, but shown in
     a FIXED order rather than the workbook's own count order or an A-Z
     toggle - Justin's ask, 2026-09-10: this list reads as a sequence (how far
     a game got), and reordering it by number of games or alphabetically
     breaks that reading every time the counts shift. `Played` and `Priority
     backlog` are not workbook statuses at all - they're the site's own
     derived views - so they are pinned outside this order, first and last.
     A status the workbook carries that ISN'T in this list still ships,
     appended before "Priority backlog" rather than silently dropped - the
     same resilience handoff 3.3b already asks for, just no longer expressed
     as a sort. */
  const STATUS_ORDER = ['Beaten', 'Sampled', 'In Progress', 'Retired', 'Abandoned', 'Unplayed'];
  const c = META.counts;
  const statusRows = () => {
    const byValue = new Map((META.statuses || []).map(d => [d.value, d]));
    const rows = [];
    if (c.played) rows.push({ value: 'played', label: 'Played', count: c.played });
    STATUS_ORDER.forEach(v => {
      const d = byValue.get(v);
      if (d) { rows.push({ value: d.value, label: d.value, count: d.count }); byValue.delete(v); }
    });
    byValue.forEach(d => rows.push({ value: d.value, label: d.value, count: d.count }));
    rows.push({ value: 'backlog', label: 'Priority Backlog', count: STARS.size || null });
    return rows;
  };
  mkDropdown('status', 'Status', statusRows, state.status, 'Any status',
    { sortable: false,
      onClear: () => { state.status = ''; sync(); },
      onSelect: v => { state.status = v; sync(); } });

  /* ---- the eight axes behind "More filters" ----------------------------
     Kept off the opening screen on purpose: Platform, Store, Genre and Status
     answer almost every question, and nine dropdowns in a row is a wall.

     The panel FORCES ITSELF OPEN whenever one of its filters is set, which is
     what makes arriving from a game page work: click `Single Player`, land on
     a filtered library, and the control that did it is visible and clearable
     rather than an invisible reason the list looks short. */
  const activeExtras = EXTRA_AXES.filter(([k]) => state[k]);
  const open = panelOpen || activeExtras.length > 0;

  const more = el('button', 'morebtn' + (open ? ' on' : ''));
  more.type = 'button';
  more.setAttribute('aria-expanded', open ? 'true' : 'false');
  more.appendChild(el('span', 'chev', open ? '▾' : '▸'));
  more.append(open ? 'Fewer filters' : 'More filters');
  if (activeExtras.length) more.appendChild(el('span', 'cnt', String(activeExtras.length)));
  more.onclick = () => {
    /* Closing the panel clears what is inside it. Leaving a filter applied
       behind a closed panel is exactly the "invisible reason the list looks
       short" this feature exists to remove. */
    if (open) { EXTRA_AXES.forEach(([k]) => { state[k] = ''; }); }
    panelOpen = panelPref(!open);
    sync();
  };
  box.appendChild(more);

  if (open) {
    const panel = el('div', 'morepanel');
    EXTRA_AXES.forEach(([key, label]) => {
      const facet = fx[key];
      /* An axis with no facet in the payload renders nothing at all, rather
         than an empty dropdown that looks broken. `artSound` was in this
         position until v120. */
      if (!facet || !facet.length) return;
      mkDropdown(key, label, facetRows(facet), state[key], 'Any ' + label.toLowerCase(),
        { parent: panel,
          onClear: () => { state[key] = ''; sync(); },
          onSelect: v => { state[key] = v; sync(); } });
    });
    box.appendChild(panel);
  }

  /* Hide Shovelware is deliberately NOT part of this - Justin's ask,
     2026-09-10. It is a display preference, not a filter: it should never
     make "Clear filters" appear on its own, and "Clear filters" should never
     touch it. Whatever is checked stays checked, on or off, no matter what
     else on this bar gets cleared. */
  const anyFilter = state.platform || state.store || state.category || state.status ||
    state.flag || TAG_AXES.some(([k]) => state[k]) || LINK_FILTERS.some(([k]) => state[k]);
  if (anyFilter) {
    const b = el('button', 'clearall', 'Clear filters');
    b.onclick = () => {
      state.platform = state.store = state.category = state.status = '';
      state.flag = '';
      TAG_AXES.forEach(([k]) => { state[k] = ''; });
      LINK_FILTERS.forEach(([k]) => { state[k] = ''; });
      sync();
    };
    box.appendChild(b);
  }
}

/* ---------------------------------------------------------------- sort UI */

function renderSortMenu() {
  const m = $('#sortmenu');
  m.replaceChildren();
  m.appendChild(el('h6', null, 'Sort by'));

  Object.entries(SORTS).forEach(([key, cfg]) => {
    const b = el('button', 'sortopt' + (state.sort === key ? ' on' : ''));
    b.appendChild(el('span', 'tick', state.sort === key ? '✓' : ''));
    b.append(cfg.name);
    b.appendChild(el('span', 'dir', state.sort === key
      ? (state.dir === 'asc' ? cfg.label : cfg.rev) + ' ⇅'
      : ''));
    b.onclick = () => {
      if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort = key; state.dir = key === 'title' ? 'asc' : 'desc'; }
      renderSortMenu(); updateSortLabel(); compute(); writeUrl('push');
    };
    m.appendChild(b);
  });
}

function updateSortLabel() {
  const cfg = SORTS[state.sort];
  $('#sortlabel').textContent = state.dir === 'asc' ? cfg.label : cfg.rev;
}

/* ---------------------------------------------------------------- hide UI */

/* One dropdown, not two controls - the on/off switch lives IN the panel's own
   header, same spot every other dropdown puts its #/A-Z toggle, so "Hide
   Shovelware" reads as one more field instead of a pill sitting next to an
   unrelated-looking button. Off doesn't hide the category list - it dims it,
   pointer-events and all - so the checked set stays visible and legible while
   it isn't in effect, rather than vanishing the moment the switch flips.

   Each row is one of META.shovelwareRules (export_json.py) - Demos, Hidden
   Object Games, itch.io Highlights, itch.io Bundles, Unplayed Free Switch
   Games as of 2026-09-10. Data-driven the same way the sort menu's own list
   is: adding a sixth rule is an entry in SHOVELWARE_RULES, no code here to
   touch. */
function renderHideMenu() {
  const list = $('#hidelist');
  list.replaceChildren();
  list.classList.toggle('off', !state.hideOn);
  (META.shovelwareRules || []).forEach(r => {
    const row = el('button', 'sortcheck');
    const on = state.hide.includes(r.id);
    row.appendChild(el('span', 'box' + (on ? ' on' : ''), on ? '✓' : ''));
    row.appendChild(el('span', null, `${r.label}  (${r.count.toLocaleString()})`));
    row.onclick = e => {
      /* #hidemenu is a persistent element (static markup, unlike the sort
         menu's own options this mirrors); renderHideMenu() replaces THIS
         button as one of its children. Without stopPropagation the click
         still bubbles to document after that swap, and by then e.target is
         detached - m.contains(e.target) reads false and the outside-click
         handler below closes the menu on every single checkbox click. */
      e.stopPropagation();
      state.hide = on ? state.hide.filter(id => id !== r.id) : [...state.hide, r.id];
      renderHideMenu(); updateHideLabel(); sync();
    };
    list.appendChild(row);
  });
}

function updateHideLabel() {
  const sw = $('#hidetoggle');
  sw.classList.toggle('on', state.hideOn);
  sw.querySelector('.tgl').classList.toggle('on', state.hideOn);
  sw.setAttribute('aria-checked', String(state.hideOn));
  /* Justin's ask, 2026-09-14: always read as "Hidden (N)", not "Hide
     Shovelware" that only grows a count once something's checked - N is 0
     with the switch off rather than the label just dropping the number. */
  const inEffect = state.hideOn && state.hide.length > 0;
  $('#hidelabel').textContent = `Hidden (${state.hideOn ? state.hide.length : 0})`;
  $('#hidebtn').classList.toggle('active', inEffect);
  $('#hidelist').classList.toggle('off', !state.hideOn);
}

/* ---------------------------------------------------------------- stats */

/* A ranked bar list: one measure, one hue, sorted. The form comes first and
   magnitude-by-category is a bar chart - never a pie, never a second axis.
   Because there is exactly ONE series there is no categorical palette to get
   wrong and no legend to need; the row label carries identity.

   Values are direct-labelled on every row on purpose. That is normally wrong on
   a dense plot, but this is a short ranked table with a magnitude cue, and the
   number is the thing being compared. Text stays in ink tokens - never the
   series colour. */
function barList(rows, opts) {
  const o = opts || {};
  const max = Math.max(...rows.map(r => r.n), 1);
  const box = el('div', 'bars');
  rows.forEach(r => {
    const line = r.href ? el('a', 'bar') : el('div', 'bar');
    if (r.href) line.href = r.href;
    line.title = `${r.label} — ${r.n.toLocaleString()} ${o.unit || 'games'}`;
    line.appendChild(el('span', 'bl', r.label));
    const track = el('span', 'bt');
    const fill = el('span', 'bf');
    /* Width is the value's share of the largest bar, so the baseline is a true
       zero and lengths are comparable. A minimum keeps a 1-row category from
       rendering as an invisible sliver. */
    fill.style.width = Math.max(2, (r.n / max) * 100) + '%';
    if (r.cls) fill.classList.add(r.cls);
    track.appendChild(fill);
    line.appendChild(track);
    line.appendChild(el('span', 'bv', r.n.toLocaleString()));
    box.appendChild(line);
  });
  return box;
}

function statPanel(title, note, body) {
  const d = el('div', 'spanel');
  d.appendChild(el('h3', null, title));
  if (note) d.appendChild(el('p', 'pnote', note));
  d.appendChild(body);
  return d;
}

/* Games played per year, off the `Completed` quarter on every played row.

   Every status with a date counts (Justin, 2026-09-29: "games played by
   year"). That is the chart's question, so an Abandoned or Retired row belongs
   in it - but `Completed` carries four meanings (finished, stopped, played,
   put down), so in the year's list every non-Beaten title wears its status and
   is never presented as a finish. In Progress rows carry no date, so they
   cannot appear here; they have their own bar in "What I've played".

   Change-over-time, so it is columns rather than a ranked list. One series, so
   no legend. Only the peak is direct-labelled - a number over every column is
   the classic way to make a small chart unreadable; the rest are on hover.

   Every column is a button (Justin's ask): it opens that year's list right
   under the chart, grouped by quarter, each title a link to its page. Inline
   rather than a jump into the library, because the library has no year filter
   and a year is a question he asks about his history, not a way to browse. */
function playedByYear() {
  const byYear = new Map();
  GAMES.forEach(g => {
    if (!g.status || g.status === 'Unplayed' || !g.completed) return;
    const m = /(\d{4})/.exec(g.completed);
    if (!m) return;
    if (!byYear.has(m[1])) byYear.set(m[1], []);
    byYear.get(m[1]).push(g);
  });
  if (!byYear.size) return null;
  const years = [...byYear.keys()].sort();
  const from = +years[0], to = +years[years.length - 1];
  const max = Math.max(...[...byYear.values()].map(a => a.length));
  const box = el('div');
  const wrap = el('div', 'cols');
  const detail = el('div', 'ydetail');
  detail.hidden = true;
  let open = null;

  const show = (y, btn) => {
    wrap.querySelectorAll('.col.on').forEach(x => x.classList.remove('on'));
    if (open === y) { open = null; statsYear = ''; detail.hidden = true; detail.replaceChildren(); writeStatsUrl(); return; }
    open = y;
    statsYear = y;
    writeStatsUrl();
    btn.classList.add('on');
    const games = byYear.get(y).slice().sort((a, b) =>
      quarterKey(a.completed) - quarterKey(b.completed) || a.title.localeCompare(b.title));
    detail.replaceChildren();
    const head = el('p', 'yhead');
    head.appendChild(el('b', null, `Played in ${y}`));
    head.append(` · ${games.length} ${games.length === 1 ? 'game' : 'games'}`);
    const beaten = games.filter(g => g.status === 'Beaten').length;
    if (beaten !== games.length) head.append(`, ${beaten} beaten`);
    detail.appendChild(head);
    const byQ = new Map();
    games.forEach(g => {
      const q = (/Q[1-4]/.exec(g.completed) || ['Undated'])[0];
      if (!byQ.has(q)) byQ.set(q, []);
      byQ.get(q).push(g);
    });
    byQ.forEach((list, q) => {
      const row = el('div', 'yq');
      row.appendChild(el('span', 'yql', q));
      const ul = el('ul');
      list.forEach(g => {
        const li = el('li'); const a = el('a', null, g.title);
        if (g.status !== 'Beaten') {
          a.appendChild(el('span', 'ytag ' + (STATUS_BAR[g.status] || ''), g.status));
        }
        a.href = '#/game/' + g.id; li.appendChild(a); ul.appendChild(li);
      });
      row.appendChild(ul);
      detail.appendChild(row);
    });
    detail.hidden = false;
  };

  for (let y = from; y <= to; y++) {
    const games = byYear.get(String(y)) || [];
    const n = games.length;
    const c = el(n ? 'button' : 'div', 'col');
    c.title = `${y} — ${n} ${n === 1 ? 'game' : 'games'}`;
    if (n) {
      c.type = 'button';
      c.setAttribute('aria-label', `${y}: ${n} ${n === 1 ? 'game' : 'games'} played`);
      c.onclick = () => show(String(y), c);
    }
    const barwrap = el('div', 'colbar');
    const f = el('div', 'colf');
    f.style.height = n ? Math.max(3, (n / max) * 100) + '%' : '0';
    if (n === max) { f.classList.add('peak'); barwrap.appendChild(el('span', 'colv', String(n))); }
    barwrap.appendChild(f);
    c.appendChild(barwrap);
    /* Every fifth year and the endpoints, so the axis never collides with
       itself on a narrow screen - and a fifth year within two of an endpoint
       is dropped, because 2025 beside 2026 overprinted on a phone. */
    const lab = y === from || y === to || (y % 5 === 0 && y - from > 2 && to - y > 2);
    c.appendChild(el('span', 'coly', lab ? String(y) : ''));
    wrap.appendChild(c);
  }
  box.appendChild(wrap);
  box.appendChild(detail);
  const again = statsYear && wrap.querySelector(`button.col[aria-label^="${statsYear}:"]`);
  if (again) show(statsYear, again);
  else statsYear = '';
  return box;
}

/* Status -> bar colour, the same tokens as the list rail and the pills, so a
   status looks like itself everywhere. Unknown statuses get the default blue. */
const STATUS_BAR = { 'Beaten': 'st-b', 'Abandoned': 'st-a', 'In Progress': 'st-p', 'Sampled': 'st-s', 'Retired': 'st-r' };

function renderStats() {
  const h = $('#stats');
  h.replaceChildren();
  const c = META.counts;
  const sheet = el('div', 'sheet');
  sheet.appendChild(el('h2', null, 'Stats'));
  sheet.appendChild(el('p', 'sub',
    'Every number here is counted from the library itself. Most of them are filters — click one to drop into the library with it applied.'));

  /* ---- headline tiles. A hero number is not a chart; four of them are not a
     chart either. Bar charts start below. `Tagged` was retired 2026-09-29 -
     every row is tagged, so it only ever read 100%. ---- */
  const tiles = el('div', 'stiles');
  const tile = (n, label, sub, href) => {
    if (n == null) return;
    const b = href ? el('a', 'stile') : el('div', 'stile');
    if (href) b.href = href;
    b.appendChild(el('b', null, n.toLocaleString()));
    b.appendChild(el('span', 'sl', label));
    if (sub) b.appendChild(el('span', 'ss', sub));
    tiles.appendChild(b);
  };
  const pct = n => Math.round((n / c.logged) * 100) + '%';
  tile(c.logged, 'Logged', 'every row in the library');
  tile(c.owned, 'Owned', pct(c.owned) + ' of the library', '#/');
  tile(c.played, 'Played', pct(c.played) + ' of the library', '#/played');
  tile(c.beaten, 'Beaten', c.beatenNeverOwned + ' never owned', '#/?status=Beaten');
  sheet.appendChild(tiles);

  /* ---- what "played" is made of. Every status the workbook carries except
     Unplayed, off META.statuses, biggest first - no hand-written list. ---- */
  const played = (META.statuses || [])
    .filter(d => d.value !== 'Unplayed' && d.count)
    .sort((a, b) => b.count - a.count)
    .map(d => ({ label: d.value, n: d.count, cls: STATUS_BAR[d.value],
                 href: '#/played?status=' + encodeURIComponent(d.value) }));
  if (played.length) {
    sheet.appendChild(statPanel("What I've played",
      `${c.played.toLocaleString()} games with some play history. What each one means is at the bottom of the page.`,
      barList(played)));
  }

  const yr = playedByYear();
  if (yr) sheet.appendChild(statPanel('Games played by year',
    'Counted off the quarter recorded against every played game. Click a year to see them.', yr));

  /* ---- the ranked lists, scoped by a tab ------------------------------

     Two questions, and they are genuinely different: "what is in the library"
     and "what have I actually played". Owning 24 Star Wars games says something
     about a bundle; having played six says something about him. `Played`
     leads because it is the more interesting of the two - Justin's call.

     Every list below is computed from the SET, never from META.facets, so both
     tabs go down one code path and cannot drift apart. The facets are still the
     authority for one thing - the duration ORDER of `length` - because that
     ordering is derived at export time from the value itself. */
  const scopeWrap = el('div', 'scoped');
  sheet.appendChild(scopeWrap);

  const SCOPES = [
    ['played', 'Played', () => GAMES.filter(g => g.status && g.status !== 'Unplayed'), '#/played'],
    ['logged', 'Logged', () => GAMES, '#/']
  ];

  function drawScope() {
    scopeWrap.replaceChildren();
    const tabs = el('div', 'stabs');
    SCOPES.forEach(([id, label, getSet]) => {
      const n = getSet().length;
      const b = el('button', 'stab' + (statsScope === id ? ' on' : ''));
      b.appendChild(el('b', null, label));
      b.appendChild(el('span', null, n.toLocaleString() + ' games'));
      b.onclick = () => { statsScope = id; drawScope(); writeStatsUrl(); };
      tabs.appendChild(b);
    });
    scopeWrap.appendChild(tabs);

    /* What used to be the "Library health" section, 2026-09-29. Justin: not
       worth its own callout. It is a quiet line on the Logged tab now, because
       not-owned and resubscribe are facts about the library, not about play.
       The data-gap flags (untagged, unverified, ownership contradictions,
       Switch games with no shelf) are all zero today and simply don't render -
       but they stay wired, so a gap that reopens still surfaces here. */
    if (statsScope === 'logged') {
      const bits = [
        [c.ownershipConflict, 'ownership contradictions', 'ownership-conflict'],
        [c.untagged, 'untagged', 'untagged'],
        [c.unverified, 'marked unverified', 'unverified'],
        [c.notOwned, 'not owned', 'not-owned'],
        [c.needsResub, 'need a resubscribe', 'needs-resub'],
        [c.noShelf, 'Switch games with no shelf', 'no-shelf']
      ].filter(([n]) => n);
      if (bits.length) {
        const p = el('p', 'sflags');
        p.append('Also in the library: ');
        bits.forEach(([n, label, flag], i) => {
          if (i) p.append(' · ');
          const a = el('a', null, `${n.toLocaleString()} ${label}`);
          a.href = '#/?flag=' + flag;
          p.appendChild(a);
        });
        scopeWrap.appendChild(p);
      }
    }

    const [, , getSet, hrefBase] = SCOPES.find(sc => sc[0] === statsScope) || SCOPES[0];
    const set = getSet();
    const noun = statsScope === 'played' ? 'played' : 'logged';
    /* Links stay INSIDE the scope being looked at: a series on the Played tab
       goes to that series filtered to played games, so the number he clicked is
       the number he lands on. Nothing is more confusing on a stats page than a
       figure that changes when you follow it. */
    const link = (k, v) => hrefBase + '?' + k + '=' + encodeURIComponent(v);

    /* One tally for every axis, over whichever set the tab selected. */
    const tallyOf = key => {
      const m = new Map();
      set.forEach(g => (g[key] || []).forEach(v => m.set(v, (m.get(v) || 0) + 1)));
      return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    };
    const rows = (arr, n, key) => arr.slice(0, n).map(([value, count]) =>
      ({ label: value, n: count, href: link(key, value) }));

    const pair = () => { const d = el('div', 'spair'); scopeWrap.appendChild(d); return d; };

    /* `Unknown` (itch.io bundle rows with no genre signal) is real and
       filterable, but it isn't a genre anyone means when they ask "what do
       I play most" - and at 648 rows it would otherwise top this list
       outright. Excluded here the same way `Unverified` already is. */
    const genres = tallyOf('genre').filter(([v]) => v !== 'Unverified' && v !== 'Unknown');
    const series = tallyOf('series');
    const r1 = pair();
    if (genres.length) {
      r1.appendChild(statPanel('Most common genres',
        `${genres.length} genres across the ${set.length.toLocaleString()} ${noun} games.`,
        barList(rows(genres, 10, 'genre'))));
    }
    if (series.length) {
      const inSeries = set.filter(g => (g.series || []).length).length;
      r1.appendChild(statPanel('Biggest series',
        `${series.length} series across ${inSeries.toLocaleString()} ${noun} games.`,
        barList(rows(series, 10, 'series'))));
    }

    /* Developers are not a facet in the payload - they are a search term - so
       these link to a search rather than a filter, scoped by nothing. That is
       the one link here that cannot honour the tab, and it is why the panel
       says "owned" or "played" in its own title rather than implying it. */
    const devs = tallyOf('developers');
    const r2 = pair();
    if (devs.length) {
      r2.appendChild(statPanel(
        statsScope === 'played' ? 'Studios I have played the most' : 'Studios I own the most from',
        `${devs.length.toLocaleString()} developers named across the ${noun} games.`,
        barList(devs.slice(0, 10).map(([name, n]) =>
          ({ label: name, n, href: '#/?q=' + encodeURIComponent(name) })))));
    }
    /* The Played tab asks where he PLAYED them, so it reads `playedGroups` -
       parsed from `Played On`. `platformGroups` blends owned-with-played, which
       is right for browsing and would answer the wrong question here: it puts
       PC at 153 played games when only 30 were actually played on PC.

       The platform FILTER behind these links is the blended one, so on the
       Played tab the bars and the destination count can differ. Said out loud
       in the note rather than quietly papered over. */
    const usePlayed = statsScope === 'played';
    const plats = tallyOf(usePlayed ? 'playedGroups' : 'platformGroups');
    if (plats.length) {
      let note = 'By platform group.';
      if (usePlayed) {
        const noPlat = set.filter(g => !(g.playedGroups || []).length).length;
        note = 'Where they were actually played, not where they are owned.'
          + (noPlat ? ` ${noPlat} played ${noPlat === 1 ? 'game has' : 'games have'} no platform recorded.` : '');
      }
      r2.appendChild(statPanel(usePlayed ? 'Where I played them' : 'Where the library lives',
        note, barList(rows(plats, 8, 'platform'))));
    }

    const r3 = pair();
    const lenCounts = new Map(tallyOf('length'));
    /* Duration order, taken from the export's own ordering of the facet, so a
       value with zero games on this tab simply drops out rather than being
       re-sorted to the wrong place. */
    const lenRows = (META.facets.length || [])
      .filter(f => lenCounts.get(f.value))
      .map(f => ({ label: f.value, n: lenCounts.get(f.value), href: link('length', f.value) }));
    if (lenRows.length) {
      r3.appendChild(statPanel('How long the games are', 'Shortest first, not biggest first.',
        barList(lenRows)));
    }
    const stores = tallyOf('stores');
    if (stores.length) {
      r3.appendChild(statPanel('Stores', `${stores.length} of them.`, barList(rows(stores, 8, 'store'))));
    }
  }
  drawScope();

  sheet.appendChild(statusNotes());

  /* Every count on this page is over the WHOLE library, but the library hides
     shovelware by default - so "85 not owned" used to land on 58 games, "27
     need a resubscribe" on 0, and 11 Retired on 10. Every link out of here
     turns the hide switch off (visibly: the pill reads "Hidden (0)"), so the
     number he clicked is the number he lands on. Done once, here, over the
     finished page, so no link can be built without it. Game pages are exempt;
     they are not filtered lists. The scope tabs rebuild their links, so they
     get the same pass on every redraw. */
  const unhide = root => root.querySelectorAll('a[href^="#/"]').forEach(a => {
    const href = a.getAttribute('href');
    if (href.startsWith('#/game/') || /[?&]hideoff=/.test(href)) return;
    a.setAttribute('href', href + (href.includes('?') ? '&' : '?') + 'hideoff=1');
  });
  unhide(sheet);
  new MutationObserver(() => unhide(scopeWrap)).observe(scopeWrap, { childList: true });

  sheet.appendChild(el('p', 'foot-note',
    `${META.source} · ${META.version} · generated ${META.generated} · ` +
    `${c.logged.toLocaleString()} games, ${c.blankRowsSkipped} blank rows skipped`));
  h.appendChild(sheet);
}

/* Stats is a route (#/stats). Opened fresh from the button it starts at the
   top; reached by Back or Forward it returns to where he left it, tab, open
   year and scroll position included. */
function openStats(params) {
  const h = $('#stats');
  statsScope = params.get('scope') === 'logged' ? 'logged' : 'played';
  statsYear = params.get('year') || '';
  state.mode = 'stats';
  document.title = 'Stats — Game Library';
  renderStats();
  h.hidden = false;
  $('#browse').hidden = true;
  $('#view').replaceChildren();
  $('#sentinel').hidden = true;
  $('#statsbtn').classList.add('on');
  $('#statsbtn').setAttribute('aria-expanded', 'true');
  writeStatsUrl();
  const back = !statsFresh && statsScroll && statsScroll.url === lastStatsUrl;
  window.scrollTo(0, back ? statsScroll.y : 0);
  statsFresh = false;
  statsScroll = null;
}

/* Every exit from the stats page goes through here, so the button state, the
   panel and the browse bar can never disagree with each other. */
function closeStats() {
  $('#stats').hidden = true;
  $('#stats').replaceChildren();
  $('#statsbtn').classList.remove('on');
  $('#statsbtn').setAttribute('aria-expanded', 'false');
  $('#browse').hidden = false;
  $('#sentinel').hidden = false;
}

/* ---------------------------------------------------------------- routing */

/* `how`: omitted = a user changed something, so it is a new history step
   (Back undoes it); 'replace' = route() re-applying a URL that is already in
   history; false = don't touch the URL. Every filter used to replace, so Back
   skipped straight past every filter change to whatever came before. */
function sync(how) {
  buildFilters();
  compute();
  if (how !== false) writeUrl(how === 'replace' ? 'replace' : 'push');
}

/* Keep the address bar in step with the filters, without re-routing. */
let writing = false;
function writeUrl(how) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.platform) p.set('platform', state.platform);
  if (state.store) p.set('store', state.store);
  if (state.category) p.set('category', state.category);
  TAG_AXES.forEach(([k]) => { if (state[k]) p.set(k, state[k]); });
  if (state.status) p.set('status', state.status);
  if (state.flag) p.set('flag', state.flag);
  LINK_FILTERS.forEach(([k]) => { if (state[k]) p.set(k, state[k]); });
  if (state.sort !== 'title' || state.dir !== 'asc') p.set('sort', state.sort + ':' + state.dir);
  /* Only written when it differs from defaultHideIds(), same convention as
     every other filter here - a URL that matches the default state stays
     clean. An explicit empty list ("hide=", nothing checked) still has to
     round-trip as different from "no hide param at all" (every rule), so it
     is written whenever the set isn't exactly the default - including empty. */
  const defHide = defaultHideIds();
  const hideIsDefault = state.hide.length === defHide.length &&
    defHide.every(id => state.hide.includes(id));
  if (!hideIsDefault) p.set('hide', state.hide.join(','));
  if (!state.hideOn) p.set('hideoff', '1');
  const base = state.view === 'played' ? '#/played' : '#/';
  const next = base + (p.toString() ? '?' + p : '');
  /* The detail page's "← Library" link reads this instead of a hardcoded
     '#/'. Set on every call rather than only inside route(): typing a search
     or touching a filter calls writeUrl() straight from its own handler
     without ever going through route() (that is the whole point of
     replaceState here - it keeps the address bar in sync without
     re-routing), so route() alone would miss most of what a reader actually
     had on screen before clicking into a game. */
  lastListUrl = next;
  if (next !== location.hash) {
    writing = true;
    if (how === 'push') history.pushState(null, '', next);
    else history.replaceState(null, '', next);
    writing = false;
  }
}
let lastListUrl = '#/';
let backFromDetail = null;

/* Remembers where a reader was scrolled when they clicked into a game, so the
   browser Back button (or the detail page's own "← Library" link, which reuses
   lastListUrl) can put them back there instead of dumping them at the top of a
   long list. Keyed to the exact list URL they left from - see the restore
   check below for why that guards against the tag-click case. */
let listScroll = null;

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');

  /* Every number on the Stats page is a link into the library, so leaving it by
     clicking one is the normal path, not an edge case. Closing here covers all
     of them at once - and the detail route below, which hides it separately. */
  const leftStats = state.mode === 'stats';
  if (leftStats) statsScroll = { url: lastStatsUrl, y: window.scrollY };
  if (!$('#stats').hidden) closeStats();

  if (path === '/stats') {
    openStats(params);
    return;
  }

  if (path.startsWith('/game/')) {
    if (state.mode === 'list') listScroll = { url: lastListUrl, y: window.scrollY, rendered: RENDERED };
    /* The game page's own back link goes wherever he came from. */
    if (leftStats) backFromDetail = { href: lastStatsUrl, label: '← Stats' };
    else if (state.mode === 'list') backFromDetail = null;
    renderDetail(path.slice(6));
    return;
  }

  document.title = 'Game Library';
  const cameFromDetail = state.mode === 'detail';
  state.mode = 'list';
  $('#browse').hidden = false;
  $('#sentinel').hidden = false;
  /* `/completions` still resolves. It was the tab's name until 2026-09-05 and
     the site is public, so old links and bookmarks must not break. */
  state.view = (path === '/played' || path === '/completions') ? 'played' : 'library';
  $('#tab-library').classList.toggle('on', state.view === 'library');
  $('#tab-played').classList.toggle('on', state.view === 'played');

  /* The URL fully describes the view. Reset every filter first, then apply
     only what the params say - otherwise filters accumulate across hash
     navigations and #/?store=Xbox silently keeps the previous genre. */
  TAG_AXES.forEach(([k]) => { state[k] = params.get(k) || ''; });
  state.store = params.get('store') || '';
  state.platform = params.get('platform') || '';
  state.category = params.get('category') || '';
  state.status = params.get('status') || '';
  state.flag = params.get('flag') || '';
  LINK_FILTERS.forEach(([k]) => { state[k] = params.get(k) || ''; });
  state.q = params.get('q') || '';
  const sp = (params.get('sort') || 'title:asc').split(':');
  state.sort = SORTS[sp[0]] ? sp[0] : 'title';
  state.dir = sp[1] === 'desc' ? 'desc' : 'asc';
  const validHideIds = new Set((META.shovelwareRules || []).map(r => r.id));
  const hideParam = params.get('hide');
  state.hide = hideParam == null
    ? defaultHideIds()
    : hideParam.split(',').filter(id => validHideIds.has(id));
  state.hideOn = params.get('hideoff') !== '1';
  updateSortLabel();
  updateHideLabel();
  $('#q').value = state.q;
  $('#q-clear').hidden = !state.q;

  sync('replace');
  if (leftStats) window.scrollTo(0, 0);

  /* Coming back from a game page: restore the scroll position we left at, but
     only when this is genuinely the Back move - the URL matches exactly what
     was on screen when the reader clicked in. A tag clicked ON the detail page
     lands on a different filter and must NOT inherit that old scroll spot;
     tags sit well down a long detail page, so it used to land mid-list with
     the filter bar off-screen above - "nothing happened". That case still
     falls through to the plain scrollTo(0, 0) it always used. */
  if (cameFromDetail && listScroll && listScroll.url === lastListUrl) {
    const target = listScroll;
    listScroll = null;
    while (RENDERED < target.rendered && RENDERED < RESULTS.length) renderMore();
    window.scrollTo(0, target.y);
  } else {
    listScroll = null;
    if (cameFromDetail) window.scrollTo(0, 0);
  }
}

/* ---------------------------------------------------------------- boot */

/* GitHub Pages serves everything with `cache-control: max-age=600` and no
   revalidation, and index.html, app.js and library.json expire INDEPENDENTLY.
   So for ten minutes after a publish a visitor can hold any mixture of old and
   new - including new code against an old payload, which is a broken page
   rather than merely a stale one.

   The publish stamps a content hash onto this script's own URL, so reading it
   back off `document.currentScript` ties the payload to exactly the code that
   asked for it. No hash locally, where the query is absent and this is a no-op. */
Promise.all([
  fetch('data/library.json' + (ASSET_V ? '?v=' + ASSET_V : ''))
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
  /* Never lets a slow/unreachable Worker block the library from loading -
     loadStars() always resolves, empty set on failure. */
  loadStars()
])
  .then(([d]) => {
    DATA = d; META = d.meta; GAMES = d.games;
    buildIndex();
    const c = META.counts;
    /* The games count moved out of the wordmark and into its own `Logged`
       pill - it was the same number printed twice. Justin's call. */
    $('#wm-sub').textContent = META.version;
    $('#c-logged').textContent = c.logged.toLocaleString();
    $('#c-owned').textContent = c.owned.toLocaleString();
    $('#c-beaten').textContent = c.beaten.toLocaleString();

    /* List vs grid. Static markup starts on List (see index.html), so a
       stored 'grid' preference is applied here rather than baked into the
       HTML - the common case (first visit, nothing stored) needs no swap. */
    state.layout = layoutPref();
    const setLayout = v => {
      if (state.layout === v) return;
      state.layout = v;
      layoutPref(v);
      $('#v-list').classList.toggle('on', v === 'list');
      $('#v-grid').classList.toggle('on', v === 'grid');
      RENDERED = 0;
      $('#view').replaceChildren();
      renderMore();
    };
    $('#v-list').classList.toggle('on', state.layout === 'list');
    $('#v-grid').classList.toggle('on', state.layout === 'grid');
    $('#v-list').onclick = () => setLayout('list');
    $('#v-grid').onclick = () => setLayout('grid');

    let timer;
    $('#q').addEventListener('input', e => {
      state.q = e.target.value;
      $('#q-clear').hidden = !state.q;
      clearTimeout(timer);
      /* Starting a search is a step Back should undo; every keystroke after
         that refines the same step rather than adding one per letter. */
      timer = setTimeout(() => {
        const prevQ = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
        compute(); writeUrl(prevQ ? 'replace' : 'push');
      }, 120);
    });
    $('#q-clear').onclick = () => { state.q = ''; $('#q').value = ''; $('#q-clear').hidden = true; compute(); writeUrl('push'); $('#q').focus(); };

    $('#sortbtn').onclick = e => {
      e.stopPropagation();
      const m = $('#sortmenu');
      m.hidden = !m.hidden;
      $('#sortbtn').setAttribute('aria-expanded', String(!m.hidden));
      if (!m.hidden) renderSortMenu();
    };
    /* Left of the sort button, Justin's call - was in the main filter row,
       moved 2026-09-08. Static markup - `#hidebtn`/`#hidemenu` carry the same
       `.dtrigger`/`.dpanel` classes buildFilters() gives every OTHER filter
       dropdown, so they open/close/anchor exactly the same way and need no
       special case in the outside-click or Escape handlers below. */
    $('#hidebtn').onclick = e => {
      e.stopPropagation();
      const opening = $('#hidemenu').hidden;
      closeAllDropdowns();
      $('#hidemenu').hidden = !opening;
      $('#hidebtn').setAttribute('aria-expanded', String(opening));
      if (opening) renderHideMenu();
    };
    /* Blank click on the panel's own padding still has to stop here - every
       OTHER dropdown's panel is built fresh by mkDropdown with this same
       line, but this one is static markup so it needs its own copy. */
    $('#hidemenu').onclick = e => e.stopPropagation();
    /* The switch: on/off only, and it stays open when clicked - the
       checkboxes right below it are the reason anyone opened this panel, and
       flipping the switch is not a reason to lose sight of them. Which
       categories apply lives in the checkboxes and is untouched by this -
       toggling off and back on restores exactly what was checked before. */
    $('#hidetoggle').onclick = e => {
      e.stopPropagation();
      state.hideOn = !state.hideOn;
      updateHideLabel();
      sync();
    };
    document.addEventListener('click', e => {
      const m = $('#sortmenu');
      if (!m.hidden && !m.contains(e.target) && e.target !== $('#sortbtn')) {
        m.hidden = true; $('#sortbtn').setAttribute('aria-expanded', 'false');
      }
      /* Every filter dropdown's own trigger and panel stop this click from
         bubbling here at all (see mkDropdown, and the two handlers just
         above for the Hide dropdown's static markup), so any click that DOES
         reach this point is by definition outside all of them. */
      closeAllDropdowns();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        $('#sortmenu').hidden = true; $('#sortbtn').setAttribute('aria-expanded', 'false');
        closeAllDropdowns();
      }
    });

    /* Stats opens over the library. It is a page, not a settings tray, which is
       why the browse bar goes away while it is up rather than sitting above it
       filtering a list nobody can see. */
    $('#statsbtn').onclick = () => {
      if (state.mode === 'stats') { location.hash = lastListUrl; return; }
      statsFresh = true;
      location.hash = '#/stats';
    };

    new IntersectionObserver(es => {
      if (state.mode !== 'list') return;
      if (es[0].isIntersecting && RENDERED < RESULTS.length) renderMore();
    }, { rootMargin: '600px' }).observe($('#sentinel'));

    /* Back to top - shows once there's actually somewhere to jump back from.
       One shared button rather than one per view: the library list, the
       Played list and a long detail page (dozens of tags, a big Contains
       box) all get the same threshold and the same button. `scroll` fires far
       more often than the button's own visibility needs to update, so the
       toggle is gated behind a single `requestAnimationFrame` per scroll
       burst rather than running on every event. */
    const totop = $('#totop');
    let totopTicking = false;
    window.addEventListener('scroll', () => {
      if (totopTicking) return;
      totopTicking = true;
      requestAnimationFrame(() => {
        totop.classList.toggle('show', window.scrollY > 600);
        totopTicking = false;
      });
    }, { passive: true });
    totop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });


    window.addEventListener('hashchange', () => { if (!writing) route(); });
    route();
  })
  .catch(err => {
    $('#view').replaceChildren();
    const e = el('div', 'empty');
    e.appendChild(el('b', null, "Couldn't load the library"));
    e.append(String(err.message) + '. If you opened this file directly, run it through a local server instead — index.html needs to fetch data/library.json.');
    $('#view').appendChild(e);
  });
