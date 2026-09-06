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

const state = {
  q: '', platform: '', store: '', category: '', status: '',
  flag: '', shelf: '', series: '',
  view: 'library', hideShovelware: false, sort: 'title', dir: 'asc',
  /* 'list' or 'detail'. The infinite-scroll observer must only ever append
     rows while a list is on screen. */
  mode: 'list'
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

/* Which set the Stats page's ranked lists describe: 'played' or 'logged'.
   Played is the default - it is the more interesting question, and the one the
   whole-library figures at the top of the page do not answer. */
let statsScope = 'played';

const SORTS = {
  title:     { label: 'A\u2013Z',    rev: 'Z\u2013A',   name: 'Alphabetical' },
  /* label = ascending, rev = descending. */
  release:   { label: 'Oldest',   rev: 'Newest', name: 'Release date' },
  completed: { label: 'Earliest', rev: 'Latest', name: 'Completion date' }
};

/* ---------------------------------------------------------------- helpers */

function year(g) {
  const m = /(\d{4})/.exec(g.releaseDate || '');
  return m ? m[1] : '';
}

function statusLine(g) {
  const m = statusMeta(g);
  return m ? { cls: m.cls, text: m.pill(g) } : null;
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
  if (own.includes('GWG')) return { kind: 'flag', text: 'requires resubscribe' };
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
    g._contains = (g.contains || []).map(norm);
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
    const hits = (g.contains || []).filter((_, i) =>
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
  'In Progress': 'means a collection I am partway through.'
};

function passes(g) {
  if (state.platform && !(g.platformGroups || []).includes(state.platform)) return false;
  if (state.store && !(g.stores || []).includes(state.store)) return false;
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
    else if (s === 'backlog') { if (!g.backlog) return false; }
    else if (g.status !== s) return false;
  }
  /* Link-only filters. `series` used to fall through to a text search; it is a
     real filter now, and the only reason it has no dropdown is its size. */
  for (const [key] of LINK_FILTERS) {
    if (state[key] && !(g[key] || []).includes(state[key])) return false;
  }
  if (state.hideShovelware && (g.shovelware || []).length) return false;
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
  /* A typed query sorts by relevance; otherwise the chosen sort applies. */
  if (!state.q) sortResults(RESULTS);
  RENDERED = 0;
  $('#view').replaceChildren();
  renderCount();
  renderMore();
}

/* Handoff 3.3 asks for this fact prominently, and calls it the clearest proof
   the ownership model earns its complexity. Every number is read off the
   payload - handoff 7's rule is derive, don't string-replace, and it applies to
   prose as much as to formulas. This exact sentence has already drifted once
   (58 of 504 survived into three places in the v71 handoff after the real
   figure moved), so it is computed here and written down nowhere.

   It used to sit on top of the Completions list. It lives on the Stats page
   now - Justin's call - because it is a fact ABOUT the collection, not a
   caption the list needed every time he opened it. */
function playedFacts() {
  const c = META.counts;
  const b = el('div', 'cbanner');
  const p1 = el('p');
  p1.appendChild(el('b', null,
    `${c.beatenNeverOwned} of my ${c.beaten.toLocaleString()} completions are on games I've never owned`));
  const by = (META.neverOwnedBy || []).map(d => `${d.count} ${d.label}`).join(', ');
  if (by) p1.append(` — ${by}.`);
  b.appendChild(p1);

  /* Say why the Played view holds more rows than the Beaten count, rather than
     letting the two numbers look like a bug.

     Built from META.statuses - every status the workbook actually carries,
     minus Beaten and Unplayed - so it needs no list of its own. That is what
     let `Abandoned` join the view without touching this function: it was
     already being computed, it had simply been filtered out upstream. */
  const extra = (META.statuses || [])
    .filter(d => d.value !== 'Beaten' && d.value !== 'Unplayed' && d.count)
    .map(d => ({ st: d.value, n: d.count }));
  if (extra.length) {
    const p2 = el('p', 'sub');
    const list = extra.map(e => `${e.n} ${e.st.toLowerCase()}`);
    const phrase = list.length > 1
      ? list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]
      : list[0];
    p2.append(`Also here: ${phrase} — all of them real play history.`);
    extra.forEach(e => {
      const gloss = STATUS_GLOSS[e.st];
      if (!gloss) return;
      p2.append(' ');
      p2.appendChild(el('b', null, e.st));
      p2.append(' ' + gloss);
    });
    b.appendChild(p2);
  }
  return b;
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
  if (g.platforms && g.platforms.length) right.appendChild(el('span', 'plat', g.platforms.slice(0, 2).join(' · ')));
  if (g.length && g.length.length) right.appendChild(el('span', 'len', g.length[0]));
  a.appendChild(right);
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
  let rows = view.querySelector('.rows');
  if (!rows) { rows = el('div', 'rows'); view.appendChild(rows); }
  const slice = RESULTS.slice(RENDERED, RENDERED + PAGE);
  const frag = document.createDocumentFragment();
  slice.forEach(r => frag.appendChild(rowNode(r)));
  rows.appendChild(frag);
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
    /* `Other Versions Owned` is `Name (Platform)`, and the platform half can
       itself hold brackets - `The Outer Worlds (PC (Windows))`. Greedy, so the
       whole trailing parenthetical goes. */
    (g.otherVersions || []).forEach(t => claim(String(t).replace(/\s*\(.*\)\s*$/, ''), g.id));
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
    const back = el('a', null, '\u2190 Back to the library'); back.href = '#/';
    e.appendChild(back);
    view.appendChild(e);
    return;
  }
  document.title = g.title + ' — Game Library';

  const crumb = el('div', 'crumb');
  const back = el('a', null, '← Library'); back.href = '#/';
  crumb.appendChild(back);
  view.appendChild(crumb);

  const head = el('div', 'dhead');
  const cov = el('div', 'cover-slot');
  if (hasCover(g.id)) {
    const img = el('img'); img.alt = ''; img.src = 'covers/' + g.id + '.webp';
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
  st.appendChild(el('span', 'spill' + (g.owned ? '' : ' no'), g.owned ? 'Owned' : 'Not owned'));
  if (g.access) st.appendChild(el('span', 'spill', g.access));
  dt.appendChild(st);
  dt.appendChild(el('div', 'slug', hasCover(g.id) ? 'covers/' + g.id + '.webp' : g.id));
  head.appendChild(dt);
  view.appendChild(head);

  view.appendChild(el('div', 'desc-empty',
    'No description yet — descriptions and cover art are on the way.'));

  /* Ownership & access first - it is the main thing you want when you look a
     game up. Tags second. */
  const own = el('div', 'fieldset');
  own.appendChild(el('div', 'fs-label', 'Ownership & access'));
  const dl1 = el('dl', 'kv');
  const kv = (dl, k, node) => { dl.appendChild(el('dt', null, k)); const d = el('dd'); d.appendChild(node); dl.appendChild(d); };
  if (g.ownedOn && g.ownedOn.length) kv(dl1, 'Owned on', el('span', 'plain', g.ownedOn.join(' · ')));
  if (g.availableOn && g.availableOn.length) kv(dl1, 'Available on', el('span', 'plain', g.availableOn.join(' · ')));
  if (g.stores && g.stores.length) {
    const d = el('span'); d.style.display = 'contents';
    const wrapper = el('span'); wrapper.style.display = 'flex'; wrapper.style.flexWrap = 'wrap'; wrapper.style.gap = '6px';
    g.stores.forEach(s => { const a = el('a', 'tagl', s); a.href = '#/?store=' + encodeURIComponent(s); wrapper.appendChild(a); });
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
  if (g.playedOn && g.playedOn.length) kv(dl1, 'Played on', el('span', 'plain mono', g.playedOn.join(' · ')));
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
      if (i > 0) doneMap[p.slice(0, i).trim()] = p.slice(i + 3).trim();
    });
    rels.forEach(([key, label, hint]) => {
      if (key === 'partsCompleted' && (g.contains || []).length) return;
      const b = el('div', 'relbox');
      const rh = el('div', 'rh'); rh.appendChild(el('b', null, label)); rh.appendChild(el('i', null, hint));
      b.appendChild(rh);
      const ul = el('ul');
      g[key].forEach(v => {
        const li = el('li');
        const match = GAMES.find(x => x.title === v);
        if (match) { const a = el('a', null, v); a.href = '#/game/' + match.id; li.appendChild(a); }
        else li.append(v);
        if (key === 'contains' && doneMap[v]) li.appendChild(el('span', 'done', '✓ ' + doneMap[v]));
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

function buildFilters() {
  const box = $('#filters');
  box.replaceChildren();

  /* `parent` defaults to the always-visible bar; the extra-filter panel passes
     itself so its controls are built straight into it. */
  const mk = (id, label, options, value, cls, parent) => {
    const g = el('span', 'fgroup');
    const l = el('label', null, label); l.htmlFor = 'f-' + id;
    const s = el('select'); s.id = 'f-' + id;
    if (value) s.className = 'active' + (cls ? ' ' + cls : ''); else if (cls) s.className = cls;
    options.forEach(o => {
      const opt = el('option', null, o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      s.appendChild(opt);
    });
    g.append(l, s);
    (parent || box).appendChild(g);
    return s;
  };

  const fx = META.facets;
  const opts = (arr, all) => [{ value: '', label: all }].concat(
    arr.map(f => ({ value: f.value, label: `${f.value}  (${f.count.toLocaleString()})` })));

  mk('platform', 'Platform', opts(fx.platform, 'Any platform'), state.platform)
    .onchange = e => { state.platform = e.target.value; sync(); };

  mk('store', 'Store', opts(fx.store, 'All stores'), state.store)
    .onchange = e => { state.store = e.target.value; state.category = ''; sync(); };

  /* Category only exists for the three stores that have one. Not rendered at
     all otherwise - no permanently dead control. */
  const cats = META.storeCategories[state.store];
  if (cats) {
    const list = [{ value: '', label: 'All categories' }].concat(
      cats.map(c => ({ value: c.id, label: (c.parent ? '   ↳ ' : '') + c.label })));
    const csel = mk('category', 'Category', list, state.category, 'dep');
    csel.parentNode.classList.add('appears');
    csel.onchange = e => { state.category = e.target.value; sync(); };
  }

  const genreOpts = opts(fx.genre, 'Any genre');
  genreOpts.push({ value: '__untagged', label: `Untagged  (${META.counts.untagged.toLocaleString()})` });
  mk('genre', 'Genre', genreOpts, state.genre)
    .onchange = e => { state.genre = e.target.value; sync(); };

  /* Built from META.statuses, which is tallied off the workbook. Nothing here
     names a status, so `Sampled` appeared at v73 without a code change and a
     sixth value would too - handoff 3.3b. Values are shown with the workbook's
     own wording; the controlled vocabulary ships as-is (handoff 16). */
  const c = META.counts;
  const statusOpts = [{ value: '', label: 'Any status' }];
  if (c.played) statusOpts.push({ value: 'played', label: `Played  (${c.played.toLocaleString()})` });
  (META.statuses || []).forEach(d =>
    statusOpts.push({ value: d.value, label: `${d.value}  (${d.count.toLocaleString()})` }));
  statusOpts.push({ value: 'backlog', label: 'Priority backlog' });
  mk('status', 'Status', statusOpts, state.status)
    .onchange = e => { state.status = e.target.value; sync(); };

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
      const sel = mk(key, label, opts(facet, 'Any ' + label.toLowerCase()),
                     state[key], null, panel);
      sel.onchange = e => { state[key] = e.target.value; sync(); };
    });
    box.appendChild(panel);
  }

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
      renderSortMenu(); updateSortLabel(); compute(); writeUrl();
    };
    m.appendChild(b);
  });

  m.appendChild(el('div', 'sortsep'));

  const rules = (META.shovelwareRules || []).map(r => r.label.toLowerCase()).join(', ');
  const c = el('button', 'sortcheck');
  const box = el('span', 'box' + (state.hideShovelware ? ' on' : ''), state.hideShovelware ? '✓' : '');
  const txt = el('span');
  txt.append('Hide shovelware');
  txt.appendChild(el('small', null,
    `Currently hides ${rules} (${META.counts.untagged.toLocaleString()}). More rules can be added later.`));
  c.append(box, txt);
  c.onclick = () => { state.hideShovelware = !state.hideShovelware; renderSortMenu(); compute(); writeUrl(); };
  m.appendChild(c);
}

function updateSortLabel() {
  const cfg = SORTS[state.sort];
  $('#sortlabel').textContent = state.dir === 'asc' ? cfg.label : cfg.rev;
}

/* ---------------------------------------------------------------- health */

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

/* Completions per year, off the `Completed` quarter on every played row.

   Change-over-time, so it is columns rather than a ranked list. One series, so
   no legend. Only the peak is direct-laballed - a number over every column is
   the classic way to make a small chart unreadable; the rest are on hover. */
function completionsByYear() {
  const byYear = new Map();
  GAMES.forEach(g => {
    if (!g.status || g.status === 'Unplayed' || !g.completed) return;
    const m = /(\d{4})/.exec(g.completed);
    if (!m) return;
    byYear.set(m[1], (byYear.get(m[1]) || 0) + 1);
  });
  if (!byYear.size) return null;
  const years = [...byYear.keys()].sort();
  const from = +years[0], to = +years[years.length - 1];
  const max = Math.max(...byYear.values());
  const wrap = el('div', 'cols');
  for (let y = from; y <= to; y++) {
    const n = byYear.get(String(y)) || 0;
    const c = el('div', 'col');
    c.title = `${y} — ${n} ${n === 1 ? 'game' : 'games'}`;
    const barwrap = el('div', 'colbar');
    const f = el('div', 'colf');
    f.style.height = n ? Math.max(3, (n / max) * 100) + '%' : '0';
    if (n === max) { f.classList.add('peak'); barwrap.appendChild(el('span', 'colv', String(n))); }
    barwrap.appendChild(f);
    c.appendChild(barwrap);
    /* Every fifth year and the endpoints, so the axis never collides with
       itself on a narrow screen. */
    c.appendChild(el('span', 'coly', (y % 5 === 0 || y === from || y === to) ? String(y) : ''));
    wrap.appendChild(c);
  }
  return wrap;
}

function renderStats() {
  const h = $('#stats');
  h.replaceChildren();
  const c = META.counts;
  const sheet = el('div', 'sheet');
  sheet.appendChild(el('h2', null, 'Stats'));
  sheet.appendChild(el('p', 'sub',
    'Every number here is counted from the library itself. Most of them are filters — click one to drop into the library with it applied.'));

  /* ---- headline tiles. A hero number is not a chart; four of them are not a
     chart either. Bar charts start below. ---- */
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
  tile(c.logged - c.untagged - c.unverified, 'Tagged',
       pct(c.logged - c.untagged - c.unverified) + ' have a genre');
  sheet.appendChild(tiles);

  sheet.appendChild(playedFacts());

  const yr = completionsByYear();
  if (yr) sheet.appendChild(statPanel('Games finished each year',
    'Counted off the quarter recorded against every played game. Hover a column for its year.', yr));

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
      b.onclick = () => { statsScope = id; drawScope(); };
      tabs.appendChild(b);
    });
    scopeWrap.appendChild(tabs);

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

    const genres = tallyOf('genre').filter(([v]) => v !== 'Unverified');
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

  /* ---- library health, unchanged in substance ---- */
  const hsec = el('div', 'spanel');
  hsec.appendChild(el('h3', null, 'Library health'));
  hsec.appendChild(el('p', 'pnote', 'Open data gaps. Every one is a filter.'));
  const grid = el('div', 'hgrid');
  /* A gap that no longer exists is not worth a card. Both ownership
     contradictions and all six missing Switch folders were fixed in the chat at
     v65-v67, so those cards now vanish rather than reading "0". */
  const card = (n, label, flag, alert) => {
    if (!n) return;
    const b = el('button', 'hcard' + (alert ? ' alert' : ''));
    b.appendChild(el('b', null, n.toLocaleString()));
    b.appendChild(el('span', null, label));
    b.onclick = () => { state.flag = flag; state.view = 'library'; closeStats(); sync(); };
    grid.appendChild(b);
  };
  card(c.ownershipConflict, 'Ownership contradictions', 'ownership-conflict', true);
  card(c.untagged, 'Untagged', 'untagged');
  card(c.unverified, 'Marked Unverified', 'unverified');
  /* Labelled "Played, never owned" until 2026-09-05, and that was wrong: the
     `not-owned` flag is every row without an owning token - 96 of them - and
     only 57 have been played (all Beaten). The other 39 are never-owned and
     never-played, mostly subscription titles. The interesting figure, 57, is on
     the Beaten tile above where it is actually true. */
  card(c.notOwned, 'Not owned', 'not-owned');
  card(c.needsResub, 'Need a resubscribe', 'needs-resub');
  card(c.noShelf, 'Switch games with no shelf', 'no-shelf');
  hsec.appendChild(grid);
  if (!grid.childNodes.length) {
    hsec.appendChild(el('p', 'pnote', 'No open data gaps. Every flag this panel tracks is currently clear.'));
  }

  const conflicts = GAMES.filter(g => (g.flags || []).includes('ownership-conflict'));
  if (conflicts.length) {
    const n = el('div', 'hnames'); n.style.borderColor = 'var(--coral-line)';
    const t = el('p', 't');
    t.appendChild(el('b', null, 'These two contradict themselves'));
    t.append(' — and they cancel out, which is why the totals still balance. Corrected at the source, not on the site.');
    n.appendChild(t);
    const ul = el('ul');
    conflicts.forEach(g => { const li = el('li'); const a = el('a', null, g.title); a.href = '#/game/' + g.id; li.appendChild(a); ul.appendChild(li); });
    n.appendChild(ul);
    hsec.appendChild(n);
  }

  const noShelf = GAMES.filter(g => (g.flags || []).includes('no-shelf'));
  if (noShelf.length) {
    const n = el('div', 'hnames');
    const t = el('p', 't');
    t.appendChild(el('b', null, noShelf.length + ' Switch games have no shelf folder'));
    t.append(' — these lost it in a merge rather than never having one.');
    n.appendChild(t);
    const ul = el('ul');
    noShelf.forEach(g => { const li = el('li'); const a = el('a', null, g.title); a.href = '#/game/' + g.id; li.appendChild(a); ul.appendChild(li); });
    n.appendChild(ul);
    hsec.appendChild(n);
  }
  sheet.appendChild(hsec);

  sheet.appendChild(el('p', 'foot-note',
    `${META.source} · ${META.version} · generated ${META.generated} · ` +
    `${c.logged.toLocaleString()} games, ${c.blankRowsSkipped} blank rows skipped`));
  h.appendChild(sheet);
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

function sync(pushUrl) {
  buildFilters();
  compute();
  if (pushUrl !== false) writeUrl();
}

/* Keep the address bar in step with the filters, without re-routing. */
let writing = false;
function writeUrl() {
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
  if (state.hideShovelware) p.set('hide', 'shovelware');
  const base = state.view === 'played' ? '#/played' : '#/';
  const next = base + (p.toString() ? '?' + p : '');
  if (next !== location.hash) {
    writing = true;
    history.replaceState(null, '', next);
    writing = false;
  }
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');

  /* Every number on the Stats page is a link into the library, so leaving it by
     clicking one is the normal path, not an edge case. Closing here covers all
     of them at once - and the detail route below, which hides it separately. */
  if (!$('#stats').hidden) closeStats();

  if (path.startsWith('/game/')) { renderDetail(path.slice(6)); return; }

  document.title = 'Game Library';
  /* Coming back from a game page, start at the top. Tags sit well down a long
     detail page, so clicking one used to land you in the middle of the filtered
     list with the filter bar off-screen above you - it read as "nothing
     happened". Only on the detail -> list move: leave scroll alone when a
     filter changes, or the page would jump under you mid-browse. */
  const cameFromDetail = state.mode === 'detail';
  state.mode = 'list';
  if (cameFromDetail) window.scrollTo(0, 0);
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
  state.hideShovelware = params.get('hide') === 'shovelware';
  updateSortLabel();
  $('#q').value = state.q;
  $('#q-clear').hidden = !state.q;

  sync();
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
fetch('data/library.json' + (ASSET_V ? '?v=' + ASSET_V : ''))
  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(d => {
    DATA = d; META = d.meta; GAMES = d.games;
    buildIndex();
    const c = META.counts;
    /* The games count moved out of the wordmark and into its own `Logged`
       pill - it was the same number printed twice. Justin's call. */
    $('#wm-sub').textContent = META.version;
    $('#c-logged').textContent = c.logged.toLocaleString();
    $('#c-owned').textContent = c.owned.toLocaleString();
    $('#c-beaten').textContent = c.beaten.toLocaleString();

    let timer;
    $('#q').addEventListener('input', e => {
      state.q = e.target.value;
      $('#q-clear').hidden = !state.q;
      clearTimeout(timer);
      timer = setTimeout(() => { compute(); writeUrl(); }, 120);
    });
    $('#q-clear').onclick = () => { state.q = ''; $('#q').value = ''; $('#q-clear').hidden = true; compute(); $('#q').focus(); };

    $('#sortbtn').onclick = e => {
      e.stopPropagation();
      const m = $('#sortmenu');
      m.hidden = !m.hidden;
      $('#sortbtn').setAttribute('aria-expanded', String(!m.hidden));
      if (!m.hidden) renderSortMenu();
    };
    document.addEventListener('click', e => {
      const m = $('#sortmenu');
      if (!m.hidden && !m.contains(e.target) && e.target !== $('#sortbtn')) {
        m.hidden = true; $('#sortbtn').setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('#sortmenu').hidden = true; $('#sortbtn').setAttribute('aria-expanded', 'false'); }
    });

    /* Stats opens over the library. It is a page, not a settings tray, which is
       why the browse bar goes away while it is up rather than sitting above it
       filtering a list nobody can see. */
    $('#statsbtn').onclick = () => {
      const h = $('#stats');
      if (!h.hidden) { closeStats(); sync(); return; }

      const open = () => {
        renderStats();
        h.hidden = false;
        $('#browse').hidden = true;
        $('#view').replaceChildren();
        $('#sentinel').hidden = true;
        $('#statsbtn').classList.add('on');
        $('#statsbtn').setAttribute('aria-expanded', 'true');
        window.scrollTo(0, 0);
      };

      if (state.mode === 'detail') {
        /* Leave the game page first, and open only once that navigation has
           landed. Setting the hash routes ASYNCHRONOUSLY, and route() closes the
           stats page - so opening first meant our own navigation immediately
           undid it. The listener is registered before the hash is set and runs
           after the app's own hashchange handler, which is what orders these
           two correctly. */
        window.addEventListener('hashchange', open, { once: true });
        location.hash = '#/';
      } else {
        open();
      }
    };

    new IntersectionObserver(es => {
      if (state.mode !== 'list') return;
      if (es[0].isIntersecting && RENDERED < RESULTS.length) renderMore();
    }, { rootMargin: '600px' }).observe($('#sentinel'));

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
