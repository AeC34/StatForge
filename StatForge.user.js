// ==UserScript==
// @name         StatForge
// @namespace    torn-ratio-helper
// @version      2.0.0
// @description  Live ratio panel for Torn gym stats with rep-counter automation and per-stat gym switching. Reads your gym-gain perks (Steadfast, education, property, books) from the Torn API (requires your own API key) to weight training gains by your real multipliers and protect your special-gym access ratios. Inspired by ClasixTV's original Torn ratio helper. TornPDA users should set injection time to END.
// @author       AeC3
// @match        https://www.torn.com/*
// @grant        None
// @license      MIT
// @run-at       document-end
// @updateURL    https://greasyfork.org/scripts/575007/code/StatForge.meta.js
// @downloadURL  https://greasyfork.org/scripts/575007/code/StatForge.user.js
// ==/UserScript==

(function () {
  'use strict';

  // GM storage fallback
  // TornPDA doesn't support GM_getValue/GM_setValue so we fall back to
  // localStorage if they're not available
  const store = {
    get: (key, def) => {
      if (typeof GM_getValue === 'function') return GM_getValue(key, def);
      try {
        const v = localStorage.getItem('gymiq_' + key);
        return v !== null ? JSON.parse(v) : def;
      } catch(e) { return def; }
    },
    set: (key, val) => {
      if (typeof GM_setValue === 'function') return GM_setValue(key, val);
      try { localStorage.setItem('gymiq_' + key, JSON.stringify(val)); } catch(e) {}
    },
  };

  // Persistent state
  let selectedRatio  = store.get('trh_ratio', 'baldr');
  let highStat       = store.get('trh_high', 'str');
  let defensiveDump  = store.get('trh_def_dump', 'str');
  let customMults    = store.get('trh_custom', { high: 1.00, secondary: 0.80, tert1: 0.60, tert2: 0.60 });
  let history        = store.get('trh_history', []);
  // Per-stat gym-gain multipliers (Steadfast + all gym-gain perks), combined
  // multiplicatively. Defaults to 1.0 (no bonus) until fetched from the Torn
  // API, so the rep plan still works for users without a key.
  let gymMults       = store.get('trh_gym_mults', { str: 1, spd: 1, def: 1, dex: 1 });
  let gymMultsFetchedAt = store.get('trh_gym_mults_at', 0);
  // Why the last fetch failed, or null when the cached multipliers are trustworthy.
  // Deliberately NOT persisted: a stored error would outlive the condition that
  // caused it and accuse a key that has since been fixed. Kept in memory so the
  // panel can say "these numbers are stale, and here is why" instead of showing
  // month-old multipliers as if they were current.
  let gymMultsError  = null;
  // Custom ratio exactly as the user typed it (e.g. [1.25, 1, 0.75, 0.75]);
  // customMults holds the same ratio normalised to the 1st stat.
  let customRaw      = store.get('trh_custom_raw', null);
  // Which closed-by-default sections the user has opened (id -> true).
  let openSections   = store.get('trh_open', {});
  let showAllHistory = false;

  // Ratio definitions
  const RATIOS = {
    baldr: {
      label: "Baldr's Ratio",
      short: "Baldr's",
      desc:  "High : 80% : 60% : 60%",
      raw:   [1.25, 1, 0.75, 0.75],
      multipliers: { high: 1.00, secondary: 0.80, tert1: 0.60, tert2: 0.60 },
    },
    hank: {
      label: "Hank's Ratio",
      short: "Hank's",
      desc:  "High : 80% : 80% : ~0%",
      raw:   [1.25, 1, 1, 0],
      multipliers: { high: 1.00, secondary: 0.80, tert1: 0.80, tert2: 0.00 },
    },
    aec3: {
      label: "Aec3 Ratio",
      short: "Aec3",
      desc:  "High : 78% : 78% : 14%",
      raw:   [37, 29, 29, 5],
      forcedDump: 'dex',
      multipliers: { high: 1.00, secondary: 0.7838, tert1: 0.7838, tert2: 0.1351 },
    },
    custom: {
      label: "Custom Ratio",
      short: "Custom",
      desc:  "Your own multipliers",
      get multipliers() { return customMults; },
      get raw() {
        return customRaw || [1, customMults.secondary, customMults.tert1, customMults.tert2];
      },
    },
  };

  const STAT_LABELS  = { str: 'Strength', spd: 'Speed', def: 'Defense', dex: 'Dexterity' };

  // True while executeTrainStepAsync is mid-step. Rapid clicks on the train
  // button while this is set are ignored — Torn's UI hasn't reached the
  // expected post-click state yet, so processing another click would race.
  let trainStepInFlight = false;
  // Train Next state. failSafeStat: the stat the fail-safe is currently catching
  // back up to its cap (sticky until it reaches 100% of target) so a starved
  // stat isn't abandoned. headroomBaseHigh: the high-stat value captured when we
  // started a headroom raise — we keep training the high stat until it is
  // HEADROOM_STEP above this, so each unlock opens a meaningful chunk of room
  // instead of one rep's worth (which would just flip back to the best stat).
  // recReason: short text explaining the current pick, read by the Train Next
  // render so the UI matches the actual strategy.
  let failSafeStat = null;
  let headroomBaseHigh = null;
  let recReason = '';

  // Gym dots per stat, keyed by Torn gym id.
  // Data ported from stephenlynx/autogymswitch (MIT licensed).
  // Source: https://gitgud.io/stephenlynx/autogymswitch
  const GYM_INFO = {
    1:  { str: 2,   spd: 2,   def: 2,   dex: 2   },
    2:  { str: 2.4, spd: 2.4, def: 2.7, dex: 2.4 },
    3:  { str: 2.7, spd: 3.2, def: 3.0, dex: 2.7 },
    4:  { str: 3.2, spd: 3.2, def: 3.2, dex: 0   },
    5:  { str: 3.4, spd: 3.6, def: 3.4, dex: 3.2 },
    6:  { str: 3.4, spd: 3.6, def: 3.6, dex: 3.8 },
    7:  { str: 3.7, spd: 0,   def: 3.7, dex: 3.7 },
    8:  { str: 4,   spd: 4,   def: 4,   dex: 4   },
    9:  { str: 4.8, spd: 4.4, def: 4,   dex: 4.2 },
    10: { str: 4.4, spd: 4.6, def: 4.8, dex: 4.4 },
    11: { str: 5,   spd: 4.6, def: 5.2, dex: 4.6 },
    12: { str: 5,   spd: 5.2, def: 5,   dex: 5   },
    13: { str: 5,   spd: 5.4, def: 4.8, dex: 5.2 },
    14: { str: 5.5, spd: 5.7, def: 5.5, dex: 5.2 },
    15: { str: 0,   spd: 5.5, def: 5.5, dex: 5.7 },
    16: { str: 6,   spd: 6,   def: 6,   dex: 6   },
    17: { str: 6,   spd: 6.2, def: 6.4, dex: 6.2 },
    18: { str: 6.5, spd: 6.4, def: 6.2, dex: 6.2 },
    19: { str: 6.4, spd: 6.5, def: 6.4, dex: 6.8 },
    20: { str: 6.4, spd: 6.4, def: 6.8, dex: 7   },
    21: { str: 7,   spd: 6.4, def: 6.4, dex: 6.5 },
    22: { str: 6.8, spd: 6.5, def: 7,   dex: 6.5 },
    23: { str: 6.8, spd: 7,   def: 7,   dex: 6.8 },
    24: { str: 7.3, spd: 7.3, def: 7.3, dex: 7.3 },
    25: { str: 0,   spd: 0,   def: 7.5, dex: 7.5 },
    26: { str: 7.5, spd: 7.5, def: 0,   dex: 0   },
    27: { str: 8,   spd: 0,   def: 0,   dex: 0   },
    28: { str: 0,   spd: 0,   def: 8,   dex: 0   },
    29: { str: 0,   spd: 8,   def: 0,   dex: 0   },
    30: { str: 0,   spd: 0,   def: 0,   dex: 8   },
    31: { str: 9,   spd: 9,   def: 9,   dex: 9   },
    32: { str: 10,  spd: 10,  def: 10,  dex: 10  },
    33: { str: 3.4, spd: 3.4, def: 4.6, dex: 0   },
  };

  // Gym id -> display name. Verified against gym.php DOM dumps.
  // Id 32 is Fight Club (10 dots, 10 energy/train).
  const GYM_NAMES = {
    1:  "Premier Fitness",
    2:  "Average Joes",
    3:  "Woody's Workout Club",
    4:  "Beach Bods",
    5:  "Silver Gym",
    6:  "Pour Femme",
    7:  "Davies Den",
    8:  "Global Gym",
    9:  "Knuckle Heads",
    10: "Pioneer Fitness",
    11: "Anabolic Anomalies",
    12: "Core",
    13: "Racing Fitness",
    14: "Complete Cardio",
    15: "Legs, Bums and Tums",
    16: "Deep Burn",
    17: "Apollo Gym",
    18: "Gun Shop",
    19: "Force Training",
    20: "Cha Cha's",
    21: "Atlas",
    22: "Last Round",
    23: "The Edge",
    24: "George's",
    25: "Balboas Gym",
    26: "Frontline Fitness",
    27: "Gym 3000",
    28: "Mr. Isoyamas",
    29: "Total Rebound",
    30: "Elites",
    31: "The Sports Science Lab",
    32: "Fight Club",
  };
  const gymName = (id) => GYM_NAMES[id] || ('Gym #' + id);

  // Helpers
  function parseStatValue(text) {
    if (!text) return null;
    const cleaned = text.replace(/,/g, '').match(/[\d.]+/);
    return cleaned ? parseFloat(cleaned[0]) : null;
  }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '???';
    return Math.round(n).toLocaleString();
  }

  function fmtShort(n) {
    if (n === null || n === undefined || isNaN(n)) return '???';
    const r = Math.round(n);
    const abs = Math.abs(r);
    if (abs >= 1e6) return (r / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return Math.round(r / 1e3) + 'K';
    return String(r);
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function parseInputNumber(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function readNumberInput(id, fallback) {
    const input = document.getElementById(id);
    if (!input) return fallback;
    if (typeof input.valueAsNumber === 'number' && !Number.isNaN(input.valueAsNumber)) {
      return input.valueAsNumber;
    }
    return parseInputNumber(input.value, fallback);
  }

  function getRoles(highStatKey) {
    const order = ['str', 'spd', 'def', 'dex'];
    const pair  = { str: 'spd', spd: 'str', def: 'dex', dex: 'def' };
    const remaining = order.filter(k => k !== highStatKey);

    // User's Dump Stat preference wins for every ratio. A ratio preset
    // can declare a recommended `forcedDump` (Aec3 recommends Dex), but
    // the user can always override it via the Dump Stat buttons in
    // Settings. Fall back to the legacy defaults when the stored
    // preference matches the current high stat.
    let dump = defensiveDump;
    if (!remaining.includes(dump)) {
      dump = (highStatKey === 'str' || highStatKey === 'spd') ? 'dex' : 'str';
    }

    const others = remaining.filter(k => k !== dump);
    // Prefer the paired stat of the high as the 2nd slot so the natural
    // Str/Spd and Def/Dex pairings are kept. If the user picks the paired
    // stat as the dump, fall back to natural order for 2nd/3rd.
    let secondary, tert1;
    if (others.includes(pair[highStatKey])) {
      secondary = pair[highStatKey];
      tert1 = others.find(k => k !== secondary);
    } else {
      const sorted = others.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
      secondary = sorted[0];
      tert1 = sorted[1];
    }

    return { high: highStatKey, secondary: secondary, tert1: tert1, tert2: dump };
  }

  // True if the ratio explicitly says NOT to train this stat — i.e. the
  // ratio's multiplier for whichever role `key` occupies is exactly 0.
  // This is what makes Hank's tert2-zero behave as a hard dump (DEX skipped
  // entirely) while Aec3's 0.1351 multiplier is honoured as a real target
  // (DEX trained up to 13.51% of high). Custom ratios that zero out 1, 2,
  // or even 3 slots get the same treatment for free — supporting 2- and
  // 3-stat training plans declaratively.
  //
  // Note: ratio.forcedDump is intentionally NOT consulted here. It's the
  // recommended default for the user's dump-stat picker (UI hint), not a
  // signal that the stat should be skipped — the multiplier drives skipping.
  // Use at every site that decides whether to skip a stat from rep
  // allocation or grading. Replaces the previous hardcoded
  // `ratioKey === 'hank' && roles.tert2 === key` check.
  function isStatDumped(key, ratioKey, roles) {
    const conf = RATIOS[ratioKey];
    if (!conf) return false;
    for (const role of Object.keys(roles)) {
      if (roles[role] !== key) continue;
      const mults = conf.multipliers || {};
      const mult = mults[role];
      if (typeof mult === 'number' && mult === 0) return true;
      break;
    }
    return false;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function readStatsFromPage() {
    const stats = { str: null, spd: null, def: null, dex: null };

    // Torn's gym page structure (class suffixes are randomised):
    // <div class="propertyTitle___XXXX">
    //   <h3 class="title___XXXX">Strength</h3>
    //   <span class="propertyValue___XXXX">2,049.27</span>
    // </div>
    const statNames = { str: 'strength', spd: 'speed', def: 'defense', dex: 'dexterity' };

    const titleBlocks = document.querySelectorAll('[class*="propertyTitle"]');
    for (const block of titleBlocks) {
      const h3 = block.querySelector('h3');
      if (!h3) continue;
      const label = h3.textContent.trim().toLowerCase();
      const valueEl = block.querySelector('[class*="propertyValue"]');
      if (!valueEl) continue;
      const v = parseStatValue(valueEl.textContent);
      if (v === null) continue;
      for (const [key, name] of Object.entries(statNames)) {
        if (label === name) { stats[key] = v; break; }
      }
    }

    // Fall back to scanning page text if any stats are still missing
    if (Object.values(stats).some(v => v === null)) {
      const patterns = {
        str: /\bstrength\b[\s\S]{0,40}?\b([\d,.]+)\b/i,
        spd: /\bspeed\b[\s\S]{0,40}?\b([\d,.]+)\b/i,
        def: /\bdefense\b[\s\S]{0,40}?\b([\d,.]+)\b/i,
        dex: /\bdexterity\b[\s\S]{0,40}?\b([\d,.]+)\b/i,
      };
      const gymArea = document.querySelector('.gym-content, #gym-root, [class*="gym"], [class*="stats"], main');
      const searchText = gymArea ? gymArea.innerText : document.body.innerText;

      for (const [key, rx] of Object.entries(patterns)) {
        if (stats[key] !== null) continue;
        const matches = [...searchText.matchAll(new RegExp(rx.source, 'gi'))];
        let best = null;
        for (const m of matches) {
          const v = parseStatValue(m[1]);
          if (v !== null && v >= 0 && (best === null || v > best)) best = v;
        }
        if (best !== null) stats[key] = best;
      }
    }

    // If one stat looks tiny compared to the others it's probably a bad read
    const validStats = Object.values(stats).filter(v => v !== null);
    if (validStats.length >= 2) {
      const maxStat = Math.max(...validStats);
      for (const key of Object.keys(stats)) {
        if (stats[key] !== null && maxStat > 10000 && stats[key] < maxStat * 0.001) {
          stats[key] = null;
        }
      }
    }

    return stats;
  }

  function computeTargets(stats, ratioKey, highStatKey) {
    const ratio   = RATIOS[ratioKey];
    const roles   = getRoles(highStatKey);
    const mults   = ratio.multipliers;
    const highVal = stats[highStatKey] || 0;
    const targets = {};
    for (const [role, statKey] of Object.entries(roles)) {
      targets[statKey] = highVal * mults[role];
    }
    return targets;
  }

  function getStatus(actual, target, isDump) {
    if (isDump) {
      if (actual < 1000)   return { color: '#4ade80', emoji: 'OK', grade: 'A', label: 'Great' };
      if (actual < 50000)  return { color: '#facc15', emoji: '!', grade: 'C', label: 'Okay' };
                           return { color: '#f87171', emoji: 'X', grade: 'F', label: 'Too high' };
    }
    if (!target) return { color: '#64748b', emoji: '-', grade: '-', label: 'N/A' };
    const pct = actual / target;
    if (pct >= 0.98 && pct <= 1.05) return { color: '#4ade80', emoji: 'OK', grade: 'A+', label: 'Perfect' };
    if (pct >= 0.95 && pct < 0.98)  return { color: '#86efac', emoji: 'OK', grade: 'A',  label: 'On target' };
    if (pct >= 0.90 && pct < 0.95)  return { color: '#bef264', emoji: '!', grade: 'B',  label: 'Close' };
    if (pct >= 0.85 && pct < 0.90)  return { color: '#facc15', emoji: '!', grade: 'C',  label: 'Low' };
    if (pct >= 0.70 && pct < 0.85)  return { color: '#fb923c', emoji: '~', grade: 'D',  label: 'Far off' };
    if (pct < 0.70)                  return { color: '#f87171', emoji: 'X', grade: 'F',  label: 'Very far off' };
    if (pct > 1.05 && pct <= 1.15)  return { color: '#fb923c', emoji: '~', grade: 'B',  label: 'Slightly over' };
                                     return { color: '#f87171', emoji: 'X', grade: 'D',  label: 'Way over' };
  }

  function overallGrade(stats, targets, roles, ratioKey) {
    let totalPct = 0; let count = 0;
    for (const [key] of Object.entries(STAT_LABELS)) {
      const isDump = isStatDumped(key, ratioKey, roles);
      if (isDump || !targets[key]) continue;
      const actual = stats[key] || 0;
      totalPct += Math.min(actual / targets[key], 1.0);
      count++;
    }
    if (!count) return { score: 0, letter: 'F' };
    const score = Math.round((totalPct / count) * 100);
    const letter = score >= 98 ? 'A+' : score >= 93 ? 'A' : score >= 88 ? 'B+' : score >= 83 ? 'B'
                 : score >= 78 ? 'C+' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
    return { score, letter };
  }

  function recordHistory(stats) {
    const allFound = Object.values(stats).every(v => v !== null);
    if (!allFound) return;
    const lastEntry = history[history.length - 1];
    if (lastEntry && ['str', 'spd', 'def', 'dex'].every(key => lastEntry[key] === stats[key])) {
      return;
    }
    const now = Date.now();
    if (history.length > 0 && now - history[history.length - 1].ts < 3600000) {
      history[history.length - 1] = { ts: now, ...stats };
    } else {
      history.push({ ts: now, ...stats });
      if (history.length > 30) history = history.slice(-30);
    }
    store.set('trh_history', history);
  }

  // CSS — "calm" look shared with Dossier: one answer card, a few numbers,
  // everything else in closed sections. Colours follow Torn's own theme
  // (body.dark-mode); colour is only used for direction (+/-) and warnings,
  // stats are identified by a small dot.
  const CSS = `
    #trh-root {
      --sf-bg: #ffffff; --sf-card: #ffffff; --sf-fg: #1c2330; --sf-dim: #656d76;
      --sf-line: #d0d7de; --sf-soft: #f2f4f7; --sf-primary: #107569; --sf-primary-fg: #ffffff;
      --sf-pos: #107569; --sf-neg: #c81e3f; --sf-warn: #9a6700; --sf-ring: #0969da;
      --sf-str: #0969da; --sf-spd: #bc4c00; --sf-dex: #00866b; --sf-def: #9c2f8a;
    }
    #trh-root.trh-dark {
      --sf-bg: #131924; --sf-card: #1c2432; --sf-fg: #d9e0e8; --sf-dim: #a7b2c0;
      --sf-line: #3d4a5a; --sf-soft: #253040; --sf-primary: #34d399; --sf-primary-fg: #131924;
      --sf-pos: #34d399; --sf-neg: #fb5c73; --sf-warn: #d29922; --sf-ring: #58a6ff;
      --sf-str: #3987e5; --sf-spd: #d95926; --sf-dex: #199e70; --sf-def: #c855b8;
    }
    #trh-root, #trh-root * { box-sizing: border-box; }
    #trh-root [hidden] { display: none !important; }
    #trh-root {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 14px; line-height: 1.4; color: var(--sf-fg); background: var(--sf-bg);
      border: 1px solid var(--sf-line); border-radius: 10px; margin: 14px 0; max-width: 600px;
      overflow: hidden; text-align: left;
    }
    #trh-root button {
      font: inherit; appearance: none; -webkit-appearance: none; cursor: pointer;
      text-transform: none; letter-spacing: normal; margin: 0;
    }
    #trh-root button:focus-visible, #trh-root summary:focus-visible, #trh-root input:focus-visible {
      outline: 2px solid var(--sf-ring); outline-offset: 2px;
    }
    #trh-header {
      display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
      padding: 10px 16px; border-bottom: 1px solid var(--sf-line);
    }
    #trh-title { font-weight: 600; font-size: 14px; }
    .trh-ctx { font-size: 12px; color: var(--sf-dim); text-align: right; }
    #trh-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }

    .trh-eyebrow { font-size: 12px; color: var(--sf-dim); }
    .trh-dim { color: var(--sf-dim); }
    .trh-pos { color: var(--sf-pos); }
    .trh-neg { color: var(--sf-neg); }
    .trh-warntext { color: var(--sf-warn); }
    .trh-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
    .trh-dot-str { background: var(--sf-str); } .trh-dot-spd { background: var(--sf-spd); }
    .trh-dot-def { background: var(--sf-def); } .trh-dot-dex { background: var(--sf-dex); }

    .trh-answer {
      background: var(--sf-card); border-radius: 10px; padding: 12px 16px;
      border: 1px solid color-mix(in srgb, var(--sf-primary) 45%, var(--sf-line));
      display: flex; flex-direction: column; gap: 6px;
    }
    .trh-verb { font-size: 24px; font-weight: 600; line-height: 1.2; display: flex; align-items: center; gap: 8px; }
    .trh-verb .trh-dot { width: 10px; height: 10px; }
    .trh-facts { font-size: 15px; line-height: 1.45; font-variant-numeric: tabular-nums; }
    .trh-marks { display: flex; flex-wrap: wrap; gap: 6px; }
    .trh-mark { font-size: 12px; border: 1px solid var(--sf-warn); color: var(--sf-warn); border-radius: 999px; padding: 1px 8px; }
    #trh-root .trh-go {
      margin-top: 4px; font-weight: 600; font-size: 15px; min-height: 44px; padding: 11px 14px;
      background: var(--sf-primary); color: var(--sf-primary-fg); border: 0; border-radius: 8px; width: 100%;
    }
    .trh-prov { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--sf-dim); }

    .trh-keys { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .trh-tile { border: 1px solid var(--sf-line); border-radius: 10px; padding: 10px 12px; background: var(--sf-card); min-width: 0; }
    .trh-tile-v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .trh-tile-s { font-size: 12px; color: var(--sf-dim); margin-top: 2px; }
    @media (max-width: 380px) { .trh-tile { padding: 8px 10px; } .trh-tile-v { font-size: 17px; } }

    #trh-root details { border: 1px solid var(--sf-line); border-radius: 10px; background: var(--sf-card); }
    #trh-root summary {
      list-style: none; display: flex; align-items: center; gap: 10px; min-height: 48px;
      padding: 0 14px; cursor: pointer; user-select: none;
    }
    #trh-root summary::-webkit-details-marker { display: none; }
    #trh-root summary::before {
      content: ""; width: 6px; height: 6px; flex: none; transform: rotate(-45deg);
      border-right: 1.5px solid var(--sf-dim); border-bottom: 1.5px solid var(--sf-dim);
    }
    #trh-root details[open] > summary::before { transform: rotate(45deg); }
    .trh-st { font-weight: 600; }
    .trh-sm { margin-left: auto; font-size: 12px; color: var(--sf-dim); text-align: right; }
    .trh-inner { padding: 2px 14px 12px; display: flex; flex-direction: column; }

    .trh-row {
      display: flex; justify-content: space-between; align-items: center; gap: 10px;
      padding: 6px 0; border-bottom: 1px solid var(--sf-line); font-variant-numeric: tabular-nums;
    }
    .trh-row:last-child { border-bottom: 0; }
    .trh-row-l { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
    .trh-row-r { text-align: right; white-space: nowrap; }
    .trh-sub { font-size: 12px; color: var(--sf-dim); }
    .trh-statcol { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .trh-bar { height: 4px; background: var(--sf-soft); border-radius: 2px; margin-top: 4px; overflow: hidden; }
    .trh-bar i { display: block; height: 100%; background: var(--sf-dim); border-radius: 2px; }

    .trh-lbl { font-size: 12px; color: var(--sf-dim); padding-top: 10px; }
    .trh-ctl { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0; }
    #trh-root .trh-btn {
      font-size: 13px; padding: 6px 10px; min-height: 36px; border-radius: 6px;
      border: 1px solid var(--sf-line); background: transparent; color: var(--sf-fg);
    }
    #trh-root .trh-btn.active { border-color: var(--sf-primary); color: var(--sf-primary); font-weight: 600; }
    #trh-root .trh-btn:hover { border-color: var(--sf-dim); }

    .trh-cgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding-top: 4px; }
    .trh-cf { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--sf-dim); }
    .trh-cf span { display: flex; align-items: center; gap: 6px; }
    #trh-root .trh-cf input {
      font: inherit; font-size: 14px; padding: 7px 9px; width: 100%; border-radius: 6px;
      border: 1px solid var(--sf-line); background: var(--sf-bg); color: var(--sf-fg);
      font-variant-numeric: tabular-nums;
    }

    .trh-htable { overflow-x: auto; }
    .trh-htable table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
    .trh-htable th, .trh-htable td { padding: 5px 4px; text-align: right; border-bottom: 1px solid var(--sf-line); white-space: nowrap; }
    .trh-htable th:first-child, .trh-htable td:first-child { text-align: left; }
    .trh-htable th { font-weight: 400; color: var(--sf-dim); }
    .trh-export-box {
      font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre; overflow-x: auto;
      background: var(--sf-soft); border-radius: 6px; padding: 10px; margin: 6px 0 0; color: var(--sf-fg);
    }
    .trh-prose { font-size: 13px; line-height: 1.55; max-width: 62ch; }
    .trh-prose p { margin: 6px 0; }
    .trh-prose h4 { font-size: 13px; font-weight: 600; margin: 12px 0 2px; }
    .trh-prose b { font-weight: 600; }
  `;

  // Feature helpers

  // Currently active gym id, read from Torn's DOM.
  // Verified structure against gym.php DOM dump: each gym tile is
  //   <button class="gymButton___... active___...">   when active
  // Tiles are in DOM order matching gym id (tile[0] = id 1, tile[31] = id 32).
  function getActiveGymId() {
    const tiles = document.querySelectorAll('button[class*="gymButton___"]');
    for (let i = 0; i < tiles.length; i++) {
      if (/active___/.test(tiles[i].className || '')) {
        return i + 1;
      }
    }
    return null;
  }

  // Set of gym ids the user currently has unlocked (parent tile lacks a "locked*" class)
  // Set of gym ids the user can currently train at.
  // Verified against gym.php DOM dump: each tile carries state classes -
  //   locked___          = membership not purchased
  //   lockedPurchased___ = paid for, but stat ratio below requirement
  //   (neither)          = usable
  // Tiles are in DOM order 0..31 for gym ids 1..32.
  function getUnlockedGymIds() {
    const unlocked = new Set();
    const tiles = document.querySelectorAll('button[class*="gymButton___"]');
    for (let i = 0; i < tiles.length; i++) {
      const id = i + 1;
      if (!GYM_INFO[id]) continue;
      const cls = tiles[i].className || '';
      if (/locked___/.test(cls)) continue;
      if (/lockedPurchased___/.test(cls)) continue;
      unlocked.add(id);
    }
    return unlocked;
  }

  // Pick the unlocked gym with the highest dots for a given stat
  function findBestGymForStat(statKey) {
    const unlocked = getUnlockedGymIds();
    let bestId = null; let bestDots = 0;
    for (const id of unlocked) {
      const info = GYM_INFO[id];
      if (!info) continue;
      const dots = info[statKey] || 0;
      if (dots > bestDots) { bestDots = dots; bestId = id; }
    }
    return bestId ? { id: bestId, dots: bestDots } : null;
  }

  // The gym tile element for a given id.
  // Verified against gym.php DOM dump: tiles render as <button class="gymButton___...">
  // in DOM order matching gym id 1..32, so tile at index (id - 1) is
  // the right one. Returns null when the page hasn't rendered tiles yet
  // or the id is out of range.
  function findTornGymTile(gymId) {
    const tiles = document.querySelectorAll('button[class*="gymButton___"]');
    return tiles[gymId - 1] || null;
  }

  // Torn's Train-<stat> button. Verified shape against gym.php DOM dump:
  //   <button class="torn-btn" aria-label="Train strength">TRAIN</button>
  // All four buttons share the same visible "TRAIN" text; the stat
  // name only appears in aria-label. Pass 1 matches on aria-label
  // directly (this is the happy path on every live Torn build we've
  // seen). Pass 2 is a structural fallback that walks from each TRAIN
  // button up to an ancestor whose text contains exactly one stat
  // name - used only if some build strips aria-label from the button.
  // Returns null if no matching enabled button is found.
  function findTornTrainButton(statKey) {
    const allStatWords = ['strength', 'speed', 'defense', 'defence', 'dexterity'];
    const needles = {
      str: ['strength'],
      spd: ['speed'],
      def: ['defense', 'defence'],
      dex: ['dexterity'],
    }[statKey] || [];

    const isOurs = el => el.closest('#trh-wrapper');

    // Pass 1: aria-label match (covers alt Torn builds that still use it).
    const labelled = Array.from(document.querySelectorAll(
      'button[aria-label], [role="button"][aria-label]'
    )).filter(el => !isOurs(el) && !el.disabled);
    for (const el of labelled) {
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      for (const needle of needles) {
        if (aria === 'train ' + needle
            || aria === needle
            || aria.startsWith('train ' + needle + ' ')
            || aria.startsWith(needle + ' ')
            || aria.endsWith(' ' + needle)) {
          return el;
        }
      }
    }

    // Pass 2: structural match. Find all TRAIN buttons, walk up to the
    // first container whose text names exactly one stat.
    const trainButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(el => {
        if (isOurs(el)) return false;
        if (el.disabled) return false;
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'train';
      });

    for (const btn of trainButtons) {
      let node = btn.parentElement;
      for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
        const text = (node.textContent || '').toLowerCase();
        const present = allStatWords.filter(w => text.includes(w));
        // Skip containers that match zero or multiple stats.
        if (present.length !== 1) continue;
        if (needles.includes(present[0])) return btn;
        break; // this button belongs to a different stat
      }
    }

    return null;
  }

  // Torn's gym-membership confirm button that appears after clicking a gym tile.
  // Primary label seen in the wild: "ACTIVATE MEMBERSHIP". Defensive match also
  // covers "switch"/"confirm" variants in case Torn changes copy.
  function findTornSwitchConfirmButton() {
    const pools = [
      document.querySelectorAll('button.torn-btn'),
      document.querySelectorAll('[class*="actionButtons"] button'),
      document.querySelectorAll('[class*="actionButtons"] [role="button"]'),
      document.querySelectorAll('button'),
      document.querySelectorAll('[role="button"]'),
    ];
    const seen = new Set();
    for (const pool of pools) {
      for (const el of pool) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.closest('#trh-wrapper')) continue;
        if (el.disabled) continue;
        const text = (el.textContent || '').trim().toLowerCase();
        if (!text || text.length > 40) continue;
        if (text === 'activate membership'
            || text.startsWith('activate membership')
            || text === 'switch'
            || text.startsWith('switch to gym')
            || text.startsWith('switch gym')
            || text === 'confirm'
            || text.startsWith('confirm switch')) {
          return el;
        }
      }
    }
    return null;
  }

  // Step-wizard: each human click triggers exactly one script click.
  // Inspects current DOM and decides which single action to take next.
  // Never polls, never times out, never acts on its own.
  //
  // Order of steps (earliest applicable wins):
  //   1. confirm modal is up      -> click ACTIVATE MEMBERSHIP
  //   2. active gym != best gym   -> click the best gym's tile
  //   3. counter != planned reps  -> fill the counter for this stat
  //   4. otherwise                -> click TRAIN for this stat
  //
  // The fill step sets the counter to 999 (plannedRepsFor) so Torn spends all
  // available energy on this stat, capped only by the stat's access headroom so
  // it can't break special-gym access; it's recomputed on each click.
  function nextTrainStep(statKey, stats) {
    const statLabel = STAT_LABELS[statKey] || statKey;

    if (findTornSwitchConfirmButton()) {
      return { action: 'confirm', labelAfter: 'Train ' + statLabel };
    }

    const active = getActiveGymId();
    const best = findBestGymForStat(statKey);
    if (best && best.id !== active) {
      const tile = findTornGymTile(best.id);
      if (tile) return { action: 'switch', target: best.id, labelAfter: 'Activate Membership' };
    }

    const planned = plannedRepsFor(statKey, stats);
    if (planned > 0) {
      const card = findStatCardForStat(statKey);
      const input = card ? findCounterInputInCard(card) : null;
      if (input && !input.disabled) {
        const current = parseInt(input.value, 10);
        if (!Number.isFinite(current) || current !== planned) {
          return { action: 'fill', reps: planned, labelAfter: 'Train ' + statLabel };
        }
      }
    }

    return { action: 'train', labelAfter: 'Train ' + statLabel };
  }

  // Counter value for `statKey`: 999 so Torn trains as many reps as the
  // player's energy allows (Torn caps the actual count to available energy —
  // 150 energy at a 50/train gym trains 3). See body for the one 0 case.
  function plannedRepsFor(statKey, stats) {
    const energy = readPageEnergy();
    if (!energy || energy.current <= 0) return 0;
    // Always 999 — Torn trains only as many reps as the player's energy allows.
    // We never reduce 999. The single exception is a stat already at/over its
    // special-gym access limit (a direct ratio check on current stats, no gain
    // estimate): return 0 so we don't train a maxed stat past the x1.25 limit.
    // The high stat is uncapped (headroom Infinity) -> always 999.
    const roles = getRoles(highStat);
    const room = computeAccessHeadroom(stats, selectedRatio, highStat, roles);
    const h = room[statKey];
    return (h === Infinity || h > 0) ? 999 : 0;
  }

  // Render-time label: tells the user what their NEXT click will do.
  function nextTrainLabel(statKey, stats) {
    const step = nextTrainStep(statKey, stats);
    const statLabel = STAT_LABELS[statKey] || statKey;
    if (step.action === 'confirm') return 'Activate Membership';
    if (step.action === 'switch')  return 'Switch to ' + gymName(step.target);
    if (step.action === 'fill')    return 'Set ' + step.reps + ' reps';
    return 'Train ' + statLabel;
  }

  // Resolves true the first time `predicate()` returns truthy after any DOM
  // mutation under <body>, or false on timeout. Same shape as TSA's
  // qtWaitForCondition — used to wait for Torn's UI to reach a stable state
  // after a click, so spamming the train button can't race the transition.
  function sfWaitForCondition(predicate, maxMs) {
    return new Promise((resolve) => {
      let done = false;
      let t;
      let obs;
      const finish = (val) => {
        if (done) return;
        done = true;
        try { if (obs) obs.disconnect(); } catch(e) {}
        try { clearTimeout(t); } catch(e) {}
        resolve(val);
      };
      try { if (predicate()) return finish(true); } catch(e) {}
      obs = new MutationObserver(() => {
        try { if (predicate()) finish(true); } catch(e) {}
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      t = setTimeout(() => finish(false), maxMs);
    });
  }

  // Execute exactly one DOM click based on current state, then wait for
  // Torn's UI to settle into the expected next state before resolving.
  // Async so the click handler can serialise rapid clicks behind a single
  // in-flight lock (no races during gym/train transitions).
  async function executeTrainStepAsync(statKey, stats) {
    const step = nextTrainStep(statKey, stats);

    if (step.action === 'confirm') {
      const btn = findTornSwitchConfirmButton();
      if (!btn) return { ok: false, reason: 'confirm-not-found' };
      btn.click();
      // Ready when the membership-confirm button is gone — Torn has accepted
      // the switch and re-rendered the gym/stat layout.
      await sfWaitForCondition(() => !findTornSwitchConfirmButton(), 3000);
      return { ok: true, labelAfter: step.labelAfter };
    }

    if (step.action === 'switch') {
      const tile = findTornGymTile(step.target);
      if (!tile) return { ok: false, reason: 'tile-not-found' };
      tile.click();
      // Ready when EITHER the membership-confirm button shows up (paid switch
      // requiring activation) OR the active gym tile already changed (free
      // switch — no confirmation needed).
      await sfWaitForCondition(() => {
        if (findTornSwitchConfirmButton()) return true;
        return getActiveGymId() === step.target;
      }, 3000);
      return { ok: true, labelAfter: step.labelAfter };
    }

    if (step.action === 'fill') {
      const card = findStatCardForStat(statKey);
      const input = card ? findCounterInputInCard(card) : null;
      if (!input) return { ok: false, reason: 'counter-not-found' };
      if (input.disabled) return { ok: false, reason: 'counter-disabled' };
      setInputValueReactSafe(input, step.reps);
      // React-safe setter is normally synchronous, but give it a short grace
      // window to commit the value into the rendered DOM.
      await sfWaitForCondition(() => {
        const v = (input.value || '').replace(/,/g, '');
        return v === String(step.reps);
      }, 500);
      return { ok: true, labelAfter: step.labelAfter };
    }

    const trainBtn = findTornTrainButton(statKey);
    if (!trainBtn) return { ok: false, reason: 'train-not-found' };
    // Snapshot energy BEFORE clicking so we can detect Torn deducting it.
    const beforeEnergy = readPageEnergy();
    trainBtn.click();
    // Ready when the train button is re-enabled (Torn's UI re-rendered with
    // fresh energy/state) OR the energy reading dropped — either signals the
    // train cycle has been processed.
    await sfWaitForCondition(() => {
      const fresh = findTornTrainButton(statKey);
      if (fresh && !fresh.disabled) return true;
      const after = readPageEnergy();
      return !!(beforeEnergy && after && after.current < beforeEnergy.current);
    }, 3000);
    return { ok: true, labelAfter: step.labelAfter };
  }

  // Parse "X / Y" energy from the gym block. Falls back to null if not found.
  function readPageEnergy() {
    const text = document.body ? (document.body.textContent || '') : '';
    const m = text.match(/You have\s+(\d+)\s*\/\s*(\d+)\s+energy/i);
    return m ? { current: parseInt(m[1], 10), max: parseInt(m[2], 10) } : null;
  }


  // Walk up from the Train button for `statKey` to find the stat card -
  // the closest ancestor whose text contains exactly one stat name.
  function findStatCardForStat(statKey) {
    const btn = findTornTrainButton(statKey);
    if (!btn) return null;
    const allWords = ['strength', 'speed', 'defense', 'defence', 'dexterity'];
    const needles = { str: ['strength'], spd: ['speed'], def: ['defense', 'defence'], dex: ['dexterity'] }[statKey] || [];
    let node = btn.parentElement;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const text = (node.textContent || '').toLowerCase();
      const present = allWords.filter(w => text.includes(w));
      if (present.length !== 1) continue;
      if (needles.includes(present[0])) return node;
      return null;
    }
    return null;
  }

  // Find the rep-counter input inside a stat card. Tries common input
  // shapes; returns null if none found (caller falls back to showing
  // the plan as text so the user can set counters manually).
  function findCounterInputInCard(card) {
    if (!card) return null;
    return card.querySelector('input[type="number"], input[type="tel"], input[type="text"]') || null;
  }

  // Set an input value in a React-safe way: use the native setter so
  // React notices the change, then dispatch input+change so any
  // handlers fire.
  function setInputValueReactSafe(input, value) {
    try {
      const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;
      if (setter) setter.call(input, String(value));
      else input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- Gym-gain multipliers + special-gym access (Steadfast-aware planning) ---

  // Parse every gym-gain perk line from a Torn user?selections=perks response
  // into a per-stat multiplicative modifier. Per-stat lines (e.g. "+ 16% speed
  // gym gains") apply to that stat; general lines (e.g. "+ 20% gym gains", no
  // stat word) apply to all four. Each perk is its own factor (1 + pct/100),
  // multiplied together — matching Torn's gym formula (perks stack
  // multiplicatively, not additively). Verified against live API output.
  function parseGymMultsFromPerks(data) {
    const mults = { str: 1, spd: 1, def: 1, dex: 1 };
    const lists = ['faction_perks', 'property_perks', 'education_perks', 'book_perks',
                   'job_perks', 'merit_perks', 'enhancer_perks', 'stock_perks'];
    const statWord = { strength: 'str', speed: 'spd', defense: 'def', defence: 'def', dexterity: 'dex' };
    const reStat = /\+\s*([\d.]+)%\s+(strength|speed|defense|defence|dexterity)\s+gym gains/i;
    const reGen  = /\+\s*([\d.]+)%\s+gym gains/i;
    const reAnyStat = /(strength|speed|defense|defence|dexterity)/i;
    for (const listKey of lists) {
      const arr = data[listKey];
      if (!Array.isArray(arr)) continue;
      for (const line of arr) {
        const ms = reStat.exec(line);
        if (ms) {
          const key = statWord[ms[2].toLowerCase()];
          if (key) mults[key] *= (1 + parseFloat(ms[1]) / 100);
          continue;
        }
        // General gym gains: mentions "gym gains" but names no specific stat.
        if (/gym gains/i.test(line) && !reAnyStat.test(line)) {
          const mg = reGen.exec(line);
          if (mg) {
            const f = 1 + parseFloat(mg[1]) / 100;
            mults.str *= f; mults.spd *= f; mults.def *= f; mults.dex *= f;
          }
        }
      }
    }
    return mults;
  }

  // A build keeps special-gym access only if no trained (non-dump) secondary
  // stat targets more than 80% of the high stat — i.e. the build's targets fit
  // under the x1.25 access ceiling (high / 1.25 = 0.8 * high). baldr/hank/aec3
  // all qualify; a balanced custom ratio (secondary > 80%) does not, so the
  // access guard stays OFF for it and the plan is unchanged for those builds.
  function buildKeepsSpecialGyms(ratioKey, roles) {
    const conf = RATIOS[ratioKey];
    if (!conf) return false;
    const mults = conf.multipliers || {};
    for (const role of ['secondary', 'tert1', 'tert2']) {
      const k = roles[role];
      if (!k || isStatDumped(k, ratioKey, roles)) continue;
      const m = typeof mults[role] === 'number' ? mults[role] : 0;
      if (m > 0.801) return false;
    }
    return true;
  }

  // Special-gym access headroom in stat POINTS, read straight from the current
  // stats — the gym limit IS the ratio, so no gain estimate is needed. The
  // single-stat gym (Hank's) needs high >= 1.25 * every other stat, i.e. each
  // other stat may rise to high/1.25; the combo gym needs the pair holding
  // high to be >= 1.25 * the other pair (str/spd share Frontline; def/dex
  // share Balboa) and is only enforced while currently held. The high stat is
  // uncapped (training it only widens access), and a non-special build returns
  // Infinity everywhere. A value <= 0 means the stat is at/over its limit.
  function computeAccessHeadroom(stats, ratioKey, highStatKey, roles) {
    const order = ['str', 'spd', 'def', 'dex'];
    const room = { str: Infinity, spd: Infinity, def: Infinity, dex: Infinity };
    if (!buildKeepsSpecialGyms(ratioKey, roles)) return room;

    const high = stats[highStatKey] || 0;
    if (high <= 0) return room;
    const primaryPair = (highStatKey === 'str' || highStatKey === 'spd')
      ? ['str', 'spd'] : ['def', 'dex'];
    const secondaryPair = order.filter(k => !primaryPair.includes(k));
    const primarySum = primaryPair.reduce((a, k) => a + (stats[k] || 0), 0);
    const secondarySum = secondaryPair.reduce((a, k) => a + (stats[k] || 0), 0);
    // The combo headroom is shared by the secondary pair; split it only among
    // the members the build actually trains so a dumped stat doesn't waste
    // half the allowance.
    const trainedSecondary = secondaryPair.filter(k => !isStatDumped(k, ratioKey, roles));
    const splitN = Math.max(1, trainedSecondary.length);
    // Only enforce the combo gym while it's CURRENTLY held — an unreachable
    // combo (e.g. aec3 Defense-high can never reach Balboa) must not freeze the
    // secondary pair. The single-stat rule is always kept.
    const comboHeld = primarySum >= 1.25 * secondarySum;

    for (const k of order) {
      if (k === highStatKey) continue;
      let headroom = (high / 1.25) - (stats[k] || 0);          // single-stat rule
      if (comboHeld && secondaryPair.includes(k)) {
        const comboHeadroom = (primarySum / 1.25) - secondarySum;
        headroom = Math.min(headroom, comboHeadroom / splitN);  // combo rule
      }
      room[k] = headroom;
    }
    return room;
  }

  // Train Next recommendation (Steadfast-aware, ratio-targeted).
  //
  // Strategy: ride the highest-yield stat (best-gym dots x your gym-gain
  // multiplier) that still has room under its ratio target. When it reaches
  // its cap it can't be trained further without breaking the ratio, so we
  // fall through to the next-highest-yield stat that still has room — only
  // once NO trained stat has room do we train the HIGH stat instead, which
  // lifts every cap and re-opens headroom. So the loop is: ride best -> best
  // caps -> ride next-best -> ... -> all capped -> bump high to open room ->
  // ride best again. The dump slot (roles.tert2, e.g. aec3 Dex) is never
  // "ridden" this way; it only gets topped up by the fail-safe below.
  //
  // Headroom raises are sticky: raising the high stat by a single rep opens only
  // a sliver of room and would flip the pick straight back to the best stat, so
  // once we start a raise we keep training the high stat until it is HEADROOM_STEP
  // (8%) above where it was when the best stat capped — opening ~8% more headroom
  // each time before we resume riding the best stat. A bigger step opens more
  // room per unlock, so the best stat can be ridden longer between gym switches.
  //
  // Fail-safe: because we keep raising the high stat, every other stat's cap
  // keeps rising and a neglected stat would drift ever further below ratio. So
  // whenever any trained stat falls below FAILSAFE_PCT of its cap it becomes
  // top priority and is trained back up to its cap (sticky via failSafeStat)
  // before we resume the strategy. This guarantees everything gets trained even
  // when a lower-yield stat never becomes the highest-yield rideable pick.
  function recommendStat(stats, roles, targets) {
    const FAILSAFE_PCT = 0.92;  // catch a stat up once it drops below 92% of its cap (max 8% lag)
    const HEADROOM_STEP = 0.08; // raise the high stat 8% per headroom unlock
    const trained = [];
    for (const k of Object.keys(STAT_LABELS)) {
      if (k === highStat) continue;
      if (isStatDumped(k, selectedRatio, roles)) continue; // hard-dumped (mult 0): skip entirely
      const target = targets[k];
      if (!target) continue;
      const cur = stats[k] || 0;
      const best = findBestGymForStat(k);
      if (!best) continue;
      trained.push({
        k,
        pct: cur / target,            // 1.0 = at ratio cap
        room: cur < target,           // still below the cap -> trainable
        yld: best.dots * (gymMults[k] || 1),
      });
    }
    if (!trained.length) { failSafeStat = null; headroomBaseHigh = null; recReason = 'raise'; return highStat; }

    // --- FAIL-SAFE: catch up a starved stat, sticky until it reaches its cap ---
    if (failSafeStat) {
      const fs = trained.find(c => c.k === failSafeStat);
      if (!fs || fs.pct >= 1.0) failSafeStat = null; // recovered or no longer valid
    }
    if (!failSafeStat) {
      const starved = trained.filter(c => c.pct < FAILSAFE_PCT);
      if (starved.length) failSafeStat = starved.reduce((a, b) => (b.pct < a.pct ? b : a)).k;
    }
    if (failSafeStat) { recReason = 'failsafe'; return failSafeStat; }

    // --- HEADROOM RAISE (sticky): keep training high until it is +8% from base ---
    const high = stats[highStat] || 0;
    if (headroomBaseHigh) {
      if (high >= headroomBaseHigh * (1 + HEADROOM_STEP)) headroomBaseHigh = null; // reached +8%
      else { recReason = 'headroom'; return highStat; }
    }

    // --- RIDE THE BEST STAT (the dump slot is excluded from riding) ---
    // Pick the highest-yield stat that still has room, not the highest-yield
    // stat overall — otherwise a higher-yield stat sitting at its cap blocks a
    // lower-yield stat from ever being ridden (it would fall through straight
    // to a headroom raise instead), leaving that stat parked at the fail-safe
    // floor indefinitely even though it still has room under its own target.
    const rideable = trained.filter(c => c.k !== roles.tert2);
    const pool = rideable.length ? rideable : trained;
    const trainable = pool.filter(c => c.room);
    if (trainable.length) {
      const best = trainable.reduce((a, b) => (b.yld > a.yld ? b : a));
      recReason = 'best';
      return best.k;
    }

    // No rideable stat has room -> start an 8% high-stat raise to open more headroom.
    headroomBaseHigh = high;
    recReason = 'headroom';
    return highStat;
  }

  function getDriftWarnings(stats, targets, roles) {
    if (history.length < 2) return [];
    const prev = history[history.length - 2];
    const prevTargets = computeTargets(prev, selectedRatio, highStat);
    const warnings = [];
    for (const [key] of Object.entries(STAT_LABELS)) {
      const isDump = isStatDumped(key, selectedRatio, roles);
      if (isDump || !targets[key] || !prevTargets[key]) continue;
      const currPct = (stats[key] || 0) / targets[key];
      const prevPct = (prev[key] || 0) / prevTargets[key];
      if (prevPct >= 0.90 && currPct < prevPct - 0.05) {
        warnings.push({ key, currPct, prevPct });
      }
    }
    return warnings;
  }

  function buildExportText(stats, targets, roles) {
    const tbs = Object.values(stats).reduce((a, v) => a + (v || 0), 0);
    const grade = overallGrade(stats, targets, roles, selectedRatio);
    const pad = (s, n) => String(s).padEnd(n);
    return [
      `=== StatForge Export ===`,
      `Date:   ${new Date().toLocaleString()}`,
      `Ratio:  ${RATIOS[selectedRatio].label} | High: ${STAT_LABELS[highStat]}`,
      `Health: ${grade.letter} (${grade.score}%) | TBS: ${fmtNum(tbs)}`,
      ``,
      `${pad('STAT',12)} ${pad('CURRENT',12)} ${pad('TARGET',12)} STATUS`,
      ...Object.entries(STAT_LABELS).map(([key, label]) => {
        const actual = stats[key] || 0;
        const target = targets[key] || 0;
        const isDump = isStatDumped(key, selectedRatio, roles);
        const status = getStatus(actual, target, isDump);
        return `${pad(label,12)} ${pad(fmtNum(actual),12)} ${pad(isDump?'minimize':fmtNum(Math.round(target)),12)} ${status.label}`;
      }),
    ].join('\n');
  }

  // Render — one page, no tabs:
  //   answer card (Train Next) -> 3 key numbers -> closed sections.
  // Section open/closed state persists in trh_open.

  const statDot = (k) => `<span class="trh-dot trh-dot-${k}"></span>`;
  const fmtRatioNum = (n) => String(Math.round((Number(n) || 0) * 10000) / 10000);
  const tbsOf = (s) => Object.keys(STAT_LABELS).reduce((a, k) => a + ((s && s[k]) || 0), 0);

  function section(id, title, summary, inner, summaryClass) {
    return `
      <details data-trh-sec="${id}"${openSections[id] ? ' open' : ''}>
        <summary><span class="trh-st">${title}</span><span class="trh-sm${summaryClass ? ' ' + summaryClass : ''}">${summary}</span></summary>
        <div class="trh-inner">${inner}</div>
      </details>`;
  }

  function renderAnswer(stats, targets, roles) {
    const rec = recommendStat(stats, roles, targets);
    const allFound = Object.values(stats).every(v => v !== null);
    const marks = [];
    if (!allFound) marks.push('<span class="trh-mark trh-missing">Some stats not read, refresh the page</span>');
    for (const w of getDriftWarnings(stats, targets, roles)) {
      marks.push(`<span class="trh-mark">${STAT_LABELS[w.key]} drifted ${Math.round((w.prevPct - w.currPct) * 100)}%</span>`);
    }
    if (gymMultsError) marks.push('<span class="trh-mark">Gym perks not updated, see Settings</span>');
    const marksHtml = marks.length ? `<div class="trh-marks">${marks.join('')}</div>` : '';

    if (!rec) {
      return `<div class="trh-answer"><div class="trh-eyebrow">Train next</div>
        <div class="trh-facts">No stat to recommend yet.</div>${marksHtml}</div>`;
    }

    const cur = stats[rec] || 0;
    const tgt = Math.round(targets[rec] || 0);
    const need = Math.round(tgt - cur);
    const needText = need > 0 ? `+${fmtShort(need)} to target`
                   : need < 0 ? `${fmtShort(-need)} over target` : 'On target';
    const reason = recReason === 'headroom'
      ? 'Opening headroom so you can keep training your best stat'
      : recReason === 'raise'
        ? 'Every other stat is at its ratio cap, so the bar goes up'
        : recReason === 'failsafe'
          ? 'Catching up, it fell below 92% of its ratio cap'
          : 'Best yield now' + ((gymMults[rec] || 1) > 1.001 ? ` (+${Math.round(((gymMults[rec] || 1) - 1) * 100)}% gym gains)` : '');
    const bestGym = findBestGymForStat(rec);
    const activeId = getActiveGymId();
    const gymLine = !bestGym ? 'Gym info not detected'
      : bestGym.id !== activeId ? `Best gym: ${escapeHtml(gymName(bestGym.id))} (${bestGym.dots} dots)`
      : `You are at the best gym, ${escapeHtml(gymName(activeId))}`;

    return `
      <div class="trh-answer">
        <div class="trh-eyebrow">Train next</div>
        <div class="trh-verb">${statDot(rec)}${STAT_LABELS[rec]}</div>
        <div class="trh-facts">${needText} <span class="trh-dim">· ${fmtShort(cur)} of ${fmtShort(tgt)}</span></div>
        <div class="trh-facts trh-dim">${reason}. ${gymLine}.</div>
        ${marksHtml}
        <button class="trh-go" id="trh-train-now" data-trh-stat="${rec}">${nextTrainLabel(rec, stats)}</button>
        <div class="trh-prov"><span>Each click is one action</span><span>Read from this page</span></div>
      </div>`;
  }

  function renderKeyStats(stats, targets, roles) {
    const grade = overallGrade(stats, targets, roles, selectedRatio);
    const tbs = tbsOf(stats);
    const lastEntry = history.length >= 2 ? history[history.length - 2] : null;
    const tbsDelta = lastEntry ? tbs - tbsOf(lastEntry) : null;
    const energy = readPageEnergy();
    const deltaLine = tbsDelta === null ? 'Total battle stats'
      : `<span class="${tbsDelta >= 0 ? 'trh-pos' : 'trh-neg'}">${tbsDelta >= 0 ? '+' : '−'}${fmtShort(Math.abs(tbsDelta))} since last</span>`;
    return `
      <div class="trh-keys">
        <div class="trh-tile"><div class="trh-eyebrow">Ratio health</div>
          <div class="trh-tile-v">${grade.letter}</div><div class="trh-tile-s">${grade.score}% on ratio</div></div>
        <div class="trh-tile"><div class="trh-eyebrow">Total stats</div>
          <div class="trh-tile-v" title="${fmtNum(tbs)}">${fmtShort(tbs)}</div><div class="trh-tile-s">${deltaLine}</div></div>
        <div class="trh-tile"><div class="trh-eyebrow">Energy</div>
          <div class="trh-tile-v">${energy ? fmtNum(energy.current) : '—'}</div>
          <div class="trh-tile-s">${energy ? 'of ' + fmtNum(energy.max) : 'not on page'}</div></div>
      </div>`;
  }

  function renderHeadroom(stats, roles) {
    const room = computeAccessHeadroom(stats, selectedRatio, highStat, roles);
    const atLimit = [];
    const rows = Object.entries(STAT_LABELS).map(([k, l]) => {
      const best = findBestGymForStat(k);
      const h = room[k];
      let txt, cls = '';
      if (k === highStat || h === Infinity) txt = 'no limit';
      else if (h <= 0) { txt = 'at limit'; cls = 'trh-warntext'; atLimit.push(l); }
      else { txt = fmtShort(h) + ' to limit'; if (h < (stats[k] || 0) * 0.005) cls = 'trh-warntext'; }
      return `<div class="trh-row"><span class="trh-row-l">${statDot(k)}${l}${best ? ` <span class="trh-sub">@ ${escapeHtml(gymName(best.id))}</span>` : ''}</span>
        <span class="trh-row-r ${cls}">${txt}</span></div>`;
    }).join('');
    const keeps = buildKeepsSpecialGyms(selectedRatio, roles);
    const summary = !keeps ? 'No gym limits for this ratio'
      : atLimit.length ? atLimit.join(', ') + ' at limit' : 'All stats have room';
    return section('headroom', 'Headroom', summary, rows, atLimit.length ? 'trh-warntext' : '');
  }

  function renderStats(stats, targets, roles) {
    const roleName = { high: '1st', secondary: '2nd', tert1: '3rd', tert2: 'dump' };
    let below = 0;
    const rows = Object.keys(STAT_LABELS).map((k) => {
      const role = Object.keys(roles).find(r => roles[r] === k);
      const actual = stats[k] || 0;
      const target = targets[k] || 0;
      const isDump = isStatDumped(k, selectedRatio, roles);
      const pct = isDump || !target ? 0 : Math.min(actual / target, 1) * 100;
      const diff = Math.round(target - actual);
      let sub;
      if (isDump) sub = 'keep low';
      else if (target && actual / target < 0.95) { sub = `+${fmtShort(diff)} needed`; below++; }
      else if (target && actual / target > 1.05) sub = `${fmtShort(-diff)} over`;
      else sub = 'on target';
      return `
        <div class="trh-row">
          <div class="trh-statcol">
            <span class="trh-row-l">${statDot(k)}${STAT_LABELS[k]} <span class="trh-sub">${roleName[role] || ''}</span></span>
            ${isDump ? '' : `<div class="trh-bar"><i style="width:${pct.toFixed(1)}%"></i></div>`}
          </div>
          <div class="trh-row-r">${fmtShort(actual)}<div class="trh-sub">${sub}</div></div>
        </div>`;
    }).join('');
    const summary = below ? `${below} below target` : 'All on target';
    return section('stats', 'Stats', summary, rows);
  }

  function renderHistorySection(stats, targets, roles) {
    const exportText = escapeHtml(buildExportText(stats, targets, roles));
    const exportBits = `
      <div class="trh-ctl">
        ${history.length > 3 ? `<button class="trh-btn" id="trh-history-all">${showAllHistory ? 'Show fewer' : 'Show all ' + history.length}</button>` : ''}
        <button class="trh-btn" id="trh-copy-export">Copy snapshot</button>
        ${history.length ? '<button class="trh-btn" id="trh-clear-history">Clear history</button>' : ''}
      </div>
      <pre id="trh-export-text" class="trh-export-box" hidden>${exportText}</pre>`;

    if (!history.length) {
      return section('history', 'History', 'No snapshots yet',
        `<div class="trh-sub" style="padding:6px 0">A snapshot is saved each time you open the gym.</div>${exportBits}`);
    }

    const sorted = [...history].reverse();
    let body;
    if (showAllHistory) {
      const keys = Object.keys(STAT_LABELS);
      body = `<div class="trh-htable"><table>
        <thead><tr><th>Date</th>${keys.map(k => `<th>${statDot(k)}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${sorted.map((e, i) => {
          const prev = sorted[i + 1];
          const d = prev ? tbsOf(e) - tbsOf(prev) : null;
          return `<tr><td>${fmtDate(e.ts)}</td>${keys.map(k => `<td>${fmtShort(e[k])}</td>`).join('')}
            <td>${fmtShort(tbsOf(e))}${d ? ` <span class="${d > 0 ? 'trh-pos' : 'trh-neg'}">${d > 0 ? '+' : '−'}${fmtShort(Math.abs(d))}</span>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`;
    } else {
      body = sorted.slice(0, 3).map((e, i) => {
        const prev = sorted[i + 1];
        const d = prev ? tbsOf(e) - tbsOf(prev) : null;
        return `<div class="trh-row"><span class="trh-row-l">${fmtDate(e.ts)}</span>
          <span class="trh-row-r">${fmtShort(tbsOf(e))}${d ? ` <span class="trh-sub ${d > 0 ? 'trh-pos' : 'trh-neg'}">${d > 0 ? '+' : '−'}${fmtShort(Math.abs(d))}</span>` : ''}</span></div>`;
      }).join('');
    }

    const weekAgo = Date.now() - 7 * 86400000;
    const base = history.find(e => e.ts >= weekAgo);
    const weekGain = base && base !== history[history.length - 1] ? tbsOf(history[history.length - 1]) - tbsOf(base) : 0;
    const summary = `${history.length} snapshot${history.length === 1 ? '' : 's'}` +
      (weekGain ? ` · ${weekGain > 0 ? '+' : '−'}${fmtShort(Math.abs(weekGain))} this week` : '');
    return section('history', 'History', summary, body + exportBits);
  }

  function renderSettingsSection(roles) {
    const ratio = RATIOS[selectedRatio];
    const raw = ratio.raw;
    const fields = [
      { id: 'high', role: 'high', label: '1st' },
      { id: 'secondary', role: 'secondary', label: '2nd' },
      { id: 'tert1', role: 'tert1', label: '3rd' },
      { id: 'tert2', role: 'tert2', label: 'Dump' },
    ].map((f, i) => `
      <label class="trh-cf"><span>${statDot(roles[f.role])} ${f.label} · ${STAT_LABELS[roles[f.role]]}</span>
        <input id="trh-c-${f.id}" class="trh-ratio-input" type="number" inputmode="decimal" step="0.05" min="0" value="${fmtRatioNum(raw[i])}"></label>`).join('');
    const mults = Object.entries(STAT_LABELS)
      .map(([k, l]) => ({ l, pct: Math.round(((gymMults[k] || 1) - 1) * 1000) / 10 }))
      .filter(x => x.pct > 0).map(x => `${x.l.slice(0, 3)} +${x.pct}%`).join(' · ') || 'none';
    const keeps = buildKeepsSpecialGyms(selectedRatio, roles);
    const dumpSummary = isStatDumped(roles.tert2, selectedRatio, roles) || ratio.multipliers.tert2 < 0.5
      ? ` · ${STAT_LABELS[roles.tert2]} dump` : '';

    const inner = `
      <div class="trh-lbl">Ratio</div>
      <div class="trh-ctl" id="trh-ratio-buttons">
        ${Object.entries(RATIOS).map(([k, r]) =>
          `<button class="trh-btn ${selectedRatio === k ? 'active' : ''}" data-trh-ratio="${k}">${r.short}</button>`).join('')}
      </div>
      <div class="trh-cgrid">${fields}</div>
      <div class="trh-sub" id="trh-c-sum" style="padding-top:6px">${ratioSummaryText(raw, roles)}</div>
      <div class="trh-sub">Change any number and it becomes your Custom ratio.</div>
      <div class="trh-ctl" id="trh-save-row"${selectedRatio === 'custom' ? '' : ' hidden'}>
        <button class="trh-btn active" id="trh-save-custom">Save custom ratio</button>
      </div>

      <div class="trh-lbl">Highest stat</div>
      <div class="trh-ctl">
        ${Object.entries(STAT_LABELS).map(([k, l]) =>
          `<button class="trh-btn ${highStat === k ? 'active' : ''}" data-trh-high="${k}">${l}</button>`).join('')}
      </div>

      <div class="trh-lbl">Dump stat${ratio.forcedDump ? ` <span class="trh-dim">· ${ratio.short} recommends ${STAT_LABELS[ratio.forcedDump]}</span>` : ''}</div>
      <div class="trh-ctl">
        ${Object.entries(STAT_LABELS).filter(([k]) => k !== highStat).map(([k, l]) =>
          `<button class="trh-btn ${roles.tert2 === k ? 'active' : ''}" data-trh-defdump="${k}">${l}</button>`).join('')}
      </div>

      <div class="trh-lbl">Gym gain multipliers</div>
      <div class="trh-row"><span class="trh-row-l">From your API key</span><span class="trh-row-r">${mults}</span></div>
      <div class="trh-row"><span class="trh-row-l">Special-gym protection</span><span class="trh-row-r ${keeps ? '' : 'trh-warntext'}">${keeps ? 'On' : 'Off for this ratio'}</span></div>
      <div class="trh-sub" style="padding-top:4px">${gymMultsFetchedAt ? 'Updated ' + escapeHtml(new Date(gymMultsFetchedAt).toLocaleString()) : 'Not fetched yet. Set a key with perks access.'}</div>
      ${gymMultsError ? `<div class="trh-sub trh-warntext" style="padding-top:4px">Could not refresh: ${escapeHtml(gymMultsError)}${gymMultsFetchedAt ? '. Using the last values that arrived.' : '. Using 1.0 for every stat.'}</div>` : ''}
      <div class="trh-ctl">
        <button class="trh-btn" id="trh-set-apikey">Set API key</button>
        <button class="trh-btn" id="trh-refresh-mults">Refresh now</button>
      </div>`;
    return section('settings', 'Settings', `${ratio.short} · ${STAT_LABELS[highStat]} high${dumpSummary}`, inner);
  }

  // "Targets: Defense 80%, Speed 60%, Dexterity 60% of Strength." from four raw ratio numbers.
  function ratioSummaryText(raw, roles) {
    const v = raw.map(n => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : NaN));
    if (v.some(Number.isNaN)) return 'Use numbers of 0 or more.';
    if (!(v[0] > 0)) return 'The 1st number must be above 0.';
    if (v.slice(1).some(x => x > v[0])) return 'The 1st number must be the largest.';
    const pct = (x) => Math.round(x / v[0] * 100) + '%';
    return `Ratio ${v.map(fmtRatioNum).join(' : ')}. Targets: ${STAT_LABELS[roles.secondary]} ${pct(v[1])}, ` +
      `${STAT_LABELS[roles.tert1]} ${pct(v[2])}, ${STAT_LABELS[roles.tert2]} ${pct(v[3])} of ${STAT_LABELS[roles.high]}.`;
  }

  function renderHowItWorks() {
    const inner = `<div class="trh-prose">
      <h4>Train next</h4>
      <p>Picks the stat with the best yield right now (gym dots × your gym-gain perks) and rides it until it reaches its ratio cap. When every stat is capped it raises your highest stat 8% to open more room. A stat that falls below 92% of its cap is caught up first.</p>
      <p>Each click on the button does one step: switch gym, set reps, or train. Keep clicking until trained. Reps are always 999 (Torn trains as many as your energy allows), and a stat already at its gym limit is not trained.</p>
      <h4>Headroom</h4>
      <p>How far each stat can grow before you lose a special gym. It is read straight from your stats (highest stat ÷ 1.25 minus each other stat).</p>
      <h4>Why ratios</h4>
      <p>Specialist gyms give better gains per energy but require a stat ratio to unlock and keep. George's gym is about 7.3 dots for 10 energy, special gyms about 7.5 for 25, elite gyms about 8.0 for 50.</p>
      <p><b>Baldr's ratio, 1.25 : 1 : 0.75 : 0.75.</b> Balanced. Unlocks an elite gym for your highest stat and a special gym for your 2nd. Works for any stat pairing.</p>
      <p><b>Hank's ratio, 1.25 : 1 : 1 : ~0.</b> Three stats trained hard, one kept as low as possible. Faster total gains, but your highest stat should be Defense or Dexterity, and it is hard to switch away from later.</p>
      <h4>The four stats</h4>
      <p><b>Strength</b> is how hard you hit. <b>Speed</b> is how often you hit. <b>Defense</b> reduces damage taken. <b>Dexterity</b> is how often you dodge.</p>
    </div>`;
    return section('how', 'How it works', 'Ratios, gym dots, headroom', inner);
  }

  function isTornDark() {
    return !!(document.body && document.body.classList.contains('dark-mode'));
  }

  // Main render
  function render(stats) {
    const roles   = getRoles(highStat);
    const targets = computeTargets(stats, selectedRatio, highStat);
    return `
      <div id="trh-root" class="${isTornDark() ? 'trh-dark' : ''}">
        <div id="trh-header">
          <div id="trh-title">StatForge</div>
          <div class="trh-ctx">${RATIOS[selectedRatio].short} · ${STAT_LABELS[highStat]} high</div>
        </div>
        <div id="trh-body">
          ${renderAnswer(stats, targets, roles)}
          ${renderKeyStats(stats, targets, roles)}
          ${renderHeadroom(stats, roles)}
          ${renderStats(stats, targets, roles)}
          ${renderHistorySection(stats, targets, roles)}
          ${renderSettingsSection(roles)}
          ${renderHowItWorks()}
        </div>
      </div>`;
  }

  // Inject
  function injectPanel() {
    const old = document.getElementById('trh-wrapper');
    if (old) old.remove();

    const stats = readStatsFromPage();
    recordHistory(stats);

    if (!document.getElementById('trh-style')) {
      const style = document.createElement('style');
      style.id = 'trh-style';
      style.textContent = CSS;
      (document.head || document.documentElement || document.body).appendChild(style);
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'trh-wrapper';
    wrapper.innerHTML = render(stats);

    const host = [
      document.querySelector('.gym-content'),
      document.querySelector('.content-title'),
      document.querySelector('#gym-root'),
      document.querySelector('.profile-wrapper'),
      document.querySelector('.stats-info'),
      document.querySelector('#react-root'),
      document.querySelector('main'),
      document.querySelector('#mainContainer'),
      document.body,
    ].find(el => el !== null) || document.documentElement;

    host.insertBefore(wrapper, host.firstChild);
    attachEvents(wrapper, stats);
  }

  function attachEvents(wrapper, stats) {
    wrapper.addEventListener('click', (e) => {
      const btn = e.target.closest('button, [data-trh-ratio], [data-trh-high], [data-trh-defdump]');
      if (!btn) return;

      if (btn.dataset.trhRatio) { selectedRatio = btn.dataset.trhRatio; store.set('trh_ratio', selectedRatio); injectPanel(); return; }
      if (btn.dataset.trhHigh)  { highStat = btn.dataset.trhHigh; store.set('trh_high', highStat); headroomBaseHigh = null; failSafeStat = null; injectPanel(); return; }
      if (btn.dataset.trhDefdump) { defensiveDump = btn.dataset.trhDefdump; store.set('trh_def_dump', defensiveDump); injectPanel(); return; }
      if (btn.id === 'trh-history-all') { showAllHistory = !showAllHistory; injectPanel(); return; }

      const id = btn.id;

      if (id === 'trh-train-now') {
        const stat = btn.dataset.trhStat;
        if (!stat) return;
        // Drop spam clicks while Torn's UI is mid-transition. The async step
        // runner waits for the expected post-click DOM state before clearing
        // the lock — so clicking faster than Torn can render simply pauses
        // until the previous step completes.
        if (trainStepInFlight) return;
        trainStepInFlight = true;
        executeTrainStepAsync(stat, stats).then((res) => {
          trainStepInFlight = false;
          if (document.getElementById('trh-train-now') !== btn) return;
          if (res.ok) {
            btn.textContent = res.labelAfter;
          } else {
            const msg = {
              'confirm-not-found': 'Confirm button not found',
              'tile-not-found': 'Gym tile not visible',
              'train-not-found': 'Train button not found',
              'counter-not-found': 'Rep counter not found',
              'counter-disabled': 'Counter is disabled at this gym',
            }[res.reason] || 'Not ready - try again';
            const original = btn.textContent;
            btn.textContent = msg;
            setTimeout(() => {
              if (document.getElementById('trh-train-now') === btn) btn.textContent = original;
            }, 1500);
          }
        }).catch(() => { trainStepInFlight = false; });
        return;
      }

      if (id === 'trh-save-custom') {
        // The user types the ratio as they know it (1.25 : 1 : 0.75 : 0.75);
        // targets are relative to the 1st stat, so normalise to it.
        const raw = readRatioInputs();
        if (!raw) {
          const sum = document.getElementById('trh-c-sum');
          if (sum) sum.textContent = ratioSummaryText(ratioInputValues(), getRoles(highStat));
          return;
        }
        customRaw = raw;
        customMults = { high: 1.00, secondary: raw[1] / raw[0], tert1: raw[2] / raw[0], tert2: raw[3] / raw[0] };
        store.set('trh_custom_raw', customRaw);
        store.set('trh_custom', customMults);
        selectedRatio = 'custom';
        store.set('trh_ratio', 'custom');
        injectPanel();
        return;
      }

      if (id === 'trh-set-apikey') {
        promptApiKey();
        return;
      }

      if (id === 'trh-refresh-mults') {
        fetchGymMults();
        return;
      }

      if (id === 'trh-clear-history') {
        let confirmed;
        try { confirmed = confirm('Clear all stat history?'); } catch(e) { confirmed = true; }
        if (confirmed) {
          history = [];
          store.set('trh_history', []);
          injectPanel();
        }
        return;
      }

      if (id === 'trh-copy-export') {
        const text = document.getElementById('trh-export-text')?.textContent || '';
        const tryClipboard = () => {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
          }
          return Promise.reject('clipboard API not available');
        };
        const fallbackCopy = () => {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          let copied = false;
          try { copied = document.execCommand('copy'); } catch(e) {}
          document.body.removeChild(ta);
          return copied;
        };

        Promise.resolve()
          .then(() => tryClipboard())
          .catch(() => {
            if (!fallbackCopy()) throw new Error('copy failed');
          })
          .then(() => {
            btn.textContent = 'Copied!';
          })
          .catch(() => {
            btn.textContent = 'Manual copy below';
            const pre = document.getElementById('trh-export-text');
            if (pre) pre.hidden = false;
          })
          .finally(() => {
            setTimeout(() => { btn.textContent = 'Copy snapshot'; }, 2000);
          });
        return;
      }

    });

    // Typing in a ratio field turns it into the Custom ratio (saved on click,
    // so the panel isn't re-rendered under the user's cursor).
    wrapper.addEventListener('input', (e) => {
      if (!e.target.classList || !e.target.classList.contains('trh-ratio-input')) return;
      const sum = document.getElementById('trh-c-sum');
      if (sum) sum.textContent = ratioSummaryText(ratioInputValues(), getRoles(highStat));
      wrapper.querySelectorAll('#trh-ratio-buttons [data-trh-ratio]').forEach(b =>
        b.classList.toggle('active', b.dataset.trhRatio === 'custom'));
      const row = document.getElementById('trh-save-row');
      if (row) row.hidden = false;
    });

    // <details> toggle doesn't bubble, so listen in the capture phase.
    wrapper.addEventListener('toggle', (e) => {
      const sec = e.target && e.target.dataset && e.target.dataset.trhSec;
      if (!sec) return;
      if (e.target.open) openSections[sec] = true; else delete openSections[sec];
      store.set('trh_open', openSections);
    }, true);
  }

  function ratioInputValues() {
    return ['high', 'secondary', 'tert1', 'tert2'].map(f => {
      const el = document.getElementById('trh-c-' + f);
      return el ? parseInputNumber(el.value, NaN) : NaN;
    });
  }

  // The four ratio fields, or null unless 1st > 0 and every other value is
  // between 0 and the 1st.
  function readRatioInputs() {
    const v = ratioInputValues();
    if (v.some(n => !Number.isFinite(n) || n < 0)) return null;
    if (!(v[0] > 0) || v.slice(1).some(n => n > v[0])) return null;
    return v;
  }

  // Init

  // Follow Torn's own light/dark switch live (it toggles body.dark-mode).
  function syncTheme() {
    const root = document.getElementById('trh-root');
    if (root) root.classList.toggle('trh-dark', isTornDark());
  }
  if (document.body) new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // Active-viewing gate per Torn rule clarification 2026-05-13: scripts may
  // only read from / interact with pages the user is actively viewing
  // (foreground tab + focused window). Background tabs and unfocused
  // windows must be inert.
  function isActivelyViewed() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  function isGymPage() {
    return location.pathname === '/gym.php' || location.href.includes('gym.php');
  }

  function removePanel() {
    const el = document.getElementById('trh-wrapper');
    if (el) el.remove();
  }

  function waitAndInject(attempts = 0) {
    if (!isGymPage()) { removePanel(); return; }
    if (!isActivelyViewed()) return;

    const domReady = document.querySelector('.gym-content, .content-title, #gym-root, .stats-info, main');
    if (!domReady && attempts < 40) {
      return setTimeout(() => waitAndInject(attempts + 1), 300);
    }

    const stats = readStatsFromPage();
    const statsFound = Object.values(stats).some(v => v !== null);

    if (!statsFound && attempts < 60) {
      return setTimeout(() => waitAndInject(attempts + 1), 500);
    }

    injectPanel();
    setTimeout(backgroundStatWatch, 600);
  }

  function backgroundStatWatch() {
    if (!isGymPage() || !isActivelyViewed() || !document.getElementById('trh-wrapper')) return;
    const warningVisible = document.querySelector('#trh-wrapper .trh-missing');
    if (!warningVisible) return;
    const stats = readStatsFromPage();
    if (Object.values(stats).some(v => v !== null)) {
      injectPanel();
    } else {
      setTimeout(backgroundStatWatch, 500);
    }
  }

  // Watch the energy bar - it drops every time you train, so we use it
  // to detect when a train completes and refresh the panel automatically
  let trainObserver = null;
  let refreshDebounce = null;
  let lastEnergyValue = null;
  let observerPaused = false;

  function getDisplayedEnergy() {
    // Torn's energy bar class name has a random suffix so we match on the partial
    const selectors = [
      '[class*="bar-value"]',
      '[class*="energy"] [class*="bar-value"]',
      '[class*="energy"] [class*="value"]',
    ];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const m = el.textContent.replace(/,/g, '').match(/(\d+)\s*\/\s*\d+/);
          if (m) {
            const v = parseInt(m[1]);
            if (!isNaN(v) && v >= 0 && v <= 1000) return v;
          }
        }
      } catch(e) {}
    }
    return null;
  }

  function syncEnergyBaseline() {
    if (!isActivelyViewed()) return;
    const e = getDisplayedEnergy();
    if (e !== null) lastEnergyValue = e;
  }

  function startTrainObserver() {
    if (trainObserver) return;
    syncEnergyBaseline();

    trainObserver = new MutationObserver(() => {
      if (!isGymPage() || !isActivelyViewed() || observerPaused) return;
      const currentEnergy = getDisplayedEnergy();
      if (currentEnergy === null) return;

      if (lastEnergyValue !== null && currentEnergy < lastEnergyValue) {
        lastEnergyValue = currentEnergy;
        clearTimeout(refreshDebounce);
        refreshDebounce = setTimeout(() => {
          if (!isGymPage() || !document.getElementById('trh-wrapper')) return;
          observerPaused = true;
          injectPanel();
          setTimeout(() => { syncEnergyBaseline(); observerPaused = false; }, 500);
        }, 800);
      } else {
        lastEnergyValue = currentEnergy;
      }
    });

    trainObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // Watch for page navigation and show/hide the panel accordingly
  let lastUrl = location.href;
  new MutationObserver(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (isGymPage()) {
        setTimeout(() => waitAndInject(), 800);
        startTrainObserver();
      } else {
        removePanel();
        if (trainObserver) { trainObserver.disconnect(); trainObserver = null; }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  if (isGymPage()) {
    waitAndInject();
    startTrainObserver();
  }

  // ---- API key + gym-gain perks (Torn-API driven) ----
  // Reads the player's gym-gain perks from api.torn.com only — never scrapes
  // the page — to weight training gains by real multipliers. Runs only while
  // the tab is actively viewed (per Torn rules), on load and when a key is
  // (re)entered; perks change rarely (Steadfast is monthly), so no polling.
  let apiKey = store.get('trh_api_key', '');

  function promptApiKey() {
    const v = window.prompt(
      'Enter your Torn API key (needs "perks" access). Stored locally in your browser only.',
      apiKey || '');
    if (v === null) return; // cancelled
    apiKey = v.trim();
    store.set('trh_api_key', apiKey);
    fetchGymMults();
  }

  // Re-render the gym panel, if it is the thing currently on screen. Used after
  // a multiplier fetch settles either way — success changes the numbers, failure
  // changes the status line, and both need to reach the user.
  function refreshGymPanelIfVisible() {
    if (typeof isGymPage === 'function' && isGymPage()
        && document.getElementById('trh-wrapper')) {
      injectPanel();
    }
  }

  // Fetch the player's gym-gain perks and cache the per-stat multipliers.
  //
  // Every failure path sets gymMultsError. Swallowing them (the previous
  // behaviour) meant a revoked key, a key without the perks selection, or Torn
  // being down all looked identical to success: the rep plan silently kept
  // weighting stats by whatever multipliers were last cached — or by 1.0 if none
  // ever were — and the panel showed a stale "Last updated" date as if current.
  function fetchGymMults() {
    if (!apiKey || !isActivelyViewed()) return;
    fetch('https://api.torn.com/user/?selections=perks&key=' +
          encodeURIComponent(apiKey) + '&comment=StatForge')
      .then(r => {
        // A non-2xx never rejects on its own, and an error page is not JSON —
        // check the status before asking for a body.
        if (!r.ok) throw new Error('HTTP ' + r.status + ' from the Torn API');
        return r.json();
      })
      .then(data => {
        if (!data) throw new Error('Empty response from the Torn API');
        // Torn reports failures in the body with a 200, so this is the branch
        // that catches a dead key (2), a paused key (18) or a key lacking the
        // access level for `perks` (16). Quote Torn's own wording — it is more
        // specific than anything this script could infer.
        if (data.error) {
          throw new Error('Torn API error ' + data.error.code + ': ' + data.error.error);
        }
        gymMults = parseGymMultsFromPerks(data);
        gymMultsFetchedAt = Date.now();
        gymMultsError = null;
        store.set('trh_gym_mults', gymMults);
        store.set('trh_gym_mults_at', gymMultsFetchedAt);
        // Refresh the gym panel so the rep plan reflects the new multipliers.
        refreshGymPanelIfVisible();
      })
      .catch(err => {
        let msg = (err && err.message) ? err.message : String(err);
        // The key rides in the query string, and some engines quote the whole
        // failing URL back in the error text. This message is rendered into the
        // panel, so redact the key rather than putting it on screen where a
        // screenshot would leak it.
        if (apiKey) msg = msg.split(apiKey).join('[key]');
        gymMultsError = msg;
        refreshGymPanelIfVisible();
      });
  }

  function initPerks() {
    if (!document.body) { setTimeout(initPerks, 300); return; }
    fetchGymMults();
  }
  initPerks();

  function resumeIfActive() {
    if (!isActivelyViewed() || !isGymPage()) return;
    syncEnergyBaseline();
    if (!document.getElementById('trh-wrapper')) waitAndInject();
  }
  document.addEventListener('visibilitychange', resumeIfActive);
  window.addEventListener('focus', resumeIfActive);

})();
