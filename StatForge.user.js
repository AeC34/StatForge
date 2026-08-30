// ==UserScript==
// @name         StatForge
// @namespace    torn-ratio-helper
// @version      1.18.4
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
  let theme          = store.get('trh_theme', 'dark');
  let collapseRepPlan = store.get('trh_collapse_repplan', true);
  let collapseStats   = store.get('trh_collapse_stats', true);
  let activeTab      = 'overview';

  // Ratio definitions
  const RATIOS = {
    baldr: {
      label: "Baldr's Ratio",
      short: "Baldr's",
      desc:  "High : 80% : 60% : 60%",
      multipliers: { high: 1.00, secondary: 0.80, tert1: 0.60, tert2: 0.60 },
    },
    hank: {
      label: "Hank's Ratio",
      short: "Hank's",
      desc:  "High : 80% : 80% : ~0%",
      multipliers: { high: 1.00, secondary: 0.80, tert1: 0.80, tert2: 0.00 },
    },
    aec3: {
      label: "Aec3 Ratio",
      short: "Aec3",
      desc:  "High : 78% : 78% : 14%",
      forcedDump: 'dex',
      multipliers: { high: 1.00, secondary: 0.7838, tert1: 0.7838, tert2: 0.1351 },
    },
    custom: {
      label: "Custom Ratio",
      short: "Custom",
      desc:  "Your own multipliers",
      get multipliers() { return customMults; },
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
  const STAT_COLORS  = { str: '#f97316', spd: '#22d3ee', def: '#a78bfa', dex: '#4ade80' };

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

  // CSS
  const CSS = `
    #trh-root * { box-sizing: border-box; }
    #trh-root {
      font-family: Arial, sans-serif;
      background: #191919;
      border: 1px solid #000;
      border-top: 3px solid #74c0fc;
      border-radius: 4px;
      padding: 0;
      margin: 14px 0;
      max-width: 600px;
      box-shadow: 0 0 20px rgba(255,204,0,0.06), 0 4px 16px rgba(0,0,0,0.7);
      color: #dddddd;
      overflow: visible;
    }
    #trh-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      background: #111;
      border-bottom: 1px solid #000;
      border-radius: 4px 4px 0 0;
      overflow: hidden;
    }
    #trh-title { font-size: 13px; font-weight: 700; color: #74c0fc; letter-spacing: 2px; text-transform: uppercase; }
    #trh-tabs { display: flex; gap: 1px; background: #111; border-bottom: 1px solid #000; padding-left: 10px; overflow-x: auto; scrollbar-width: none; }
    #trh-tabs::-webkit-scrollbar { display: none; }
    .trh-tab {
      flex: 0 0 auto; padding: 8px 14px; font-size: 11px; font-family: Arial, sans-serif;
      text-align: center; cursor: pointer; color: #888; background: #191919;
      border: none; text-transform: uppercase; letter-spacing: 1px;
      transition: all 0.15s; border-bottom: 2px solid transparent; white-space: nowrap;
    }
    .trh-tab:hover { color: #ddd; background: #222; }
    .trh-tab.active { color: #74c0fc; border-bottom: 2px solid #74c0fc; background: #222; }
    #trh-body { padding: 14px; }
    .trh-section { margin-bottom: 14px; }
    .trh-label { font-size: 10px; color: #777; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px; }
    .trh-stat-row { margin-bottom: 10px; }
    .trh-stat-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .trh-stat-name { font-size: 12px; font-weight: 700; letter-spacing: 1px; }
    .trh-stat-nums { font-size: 11px; color: #888; }
    .trh-stat-nums span { color: #ddd; }
    .trh-bar-bg { height: 6px; background: #2a2a2a; border-radius: 3px; overflow: hidden; }
    .trh-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
    .trh-stat-status { font-size: 10px; margin-top: 3px; }
    .trh-grade { font-size: 28px; font-weight: 900; line-height: 1; font-family: Arial, sans-serif; }
    .trh-score-row { display: flex; align-items: center; gap: 14px; }
    .trh-score-detail { font-size: 11px; color: #888; }
    .trh-score-detail strong { color: #ddd; }
    .trh-rec-box {
      background: #222; border: 1px solid #333; border-left: 3px solid #74c0fc;
      border-radius: 4px; padding: 10px 12px; font-size: 12px;
    }
    .trh-rec-box .trh-rec-stat { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
    .trh-ctrl-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .trh-btn {
      background: #2a2a2a; border: 1px solid #444; color: #ddd;
      border-radius: 3px; padding: 5px 10px; font-size: 11px; cursor: pointer;
      font-family: Arial, sans-serif; letter-spacing: 1px;
      transition: all 0.15s; text-transform: uppercase; white-space: nowrap;
    }
    .trh-btn:hover { background: #333; border-color: #74c0fc; color: #74c0fc; }
    .trh-btn.active { background: #1a2840; border-color: #74c0fc; color: #74c0fc; }
    @media (max-width: 480px) {
      .trh-ctrl-row { flex-direction: column; align-items: stretch; }
      .trh-btn { text-align: center; width: 100%; }
      .trh-custom-grid { grid-template-columns: 1fr; }
    }
    .trh-select {
      background: #2a2a2a; border: 1px solid #444; color: #ddd;
      border-radius: 3px; padding: 5px 8px; font-size: 11px; cursor: pointer;
      font-family: Arial, sans-serif;
    }
    .trh-history-row { display: flex; gap: 6px; align-items: center; font-size: 11px; padding: 5px 0; border-bottom: 1px solid #2a2a2a; }
    .trh-history-date { color: #777; width: 60px; flex-shrink: 0; }
    .trh-history-stat { flex: 1; text-align: right; }
    .trh-history-delta { font-size: 10px; }
    .trh-slot-row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; background: #222; border-radius: 4px; margin-bottom: 4px; font-size: 12px; }
    .trh-slot-label { color: #777; width: 110px; flex-shrink: 0; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
    .trh-slot-mult { color: #888; font-size: 11px; }
    .trh-custom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .trh-custom-field { display: flex; flex-direction: column; gap: 3px; }
    .trh-custom-field label { font-size: 10px; color: #777; letter-spacing: 1px; text-transform: uppercase; }
    .trh-custom-field input {
      background: #2a2a2a; border: 1px solid #444; color: #dddddd;
      border-radius: 3px; padding: 6px 8px; font-size: 12px; width: 100%;
      font-family: Arial, sans-serif;
    }
    .trh-custom-field input:focus { outline: none; border-color: #74c0fc; }
    .trh-tbs { font-size: 22px; font-weight: 700; color: #74c0fc; letter-spacing: -1px; }
    .trh-tbs-label { font-size: 10px; color: #777; letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; }
    .trh-divider { border: none; border-top: 1px solid #2a2a2a; margin: 12px 0; }
    .trh-warn { font-size: 11px; color: #facc15; padding: 6px 10px; background: #2a1e00; border-radius: 3px; margin-bottom: 10px; border: 1px solid #4a3800; }
    .trh-no-history { font-size: 12px; color: #777; text-align: center; padding: 20px; }
    .trh-drift-alert {
      font-size: 11px; color: #fb923c; padding: 6px 10px;
      background: #2a1600; border-radius: 3px; margin-bottom: 10px;
      border: 1px solid #4a2800;
    }
    .trh-export-box {
      background: #222; border: 1px solid #333; border-radius: 3px;
      padding: 10px; font-size: 11px; color: #aaa; font-family: Arial, sans-serif;
      white-space: pre; overflow-x: auto; margin-top: 8px; line-height: 1.6;
    }
    #trh-root.trh-light {
      background: #cccccc; border-color: #bbb; border-top-color: #74c0fc;
      box-shadow: 0 0 20px rgba(116,192,252,0.06), 0 2px 10px rgba(0,0,0,0.12); color: #333333;
    }
    #trh-root.trh-light #trh-header { background: #b6b6b6; border-bottom-color: #999; }
    #trh-root.trh-light #trh-title { color: #74c0fc; }
    #trh-root.trh-light #trh-tabs { background: #b6b6b6; border-bottom-color: #999; }
    #trh-root.trh-light .trh-tab { color: #666; background: #cccccc; }
    #trh-root.trh-light .trh-tab:hover { color: #333; background: #d5d5d5; }
    #trh-root.trh-light .trh-tab.active { color: #74c0fc; border-bottom-color: #74c0fc; background: #d6ecfe; }
    #trh-root.trh-light .trh-label { color: #666; }
    #trh-root.trh-light .trh-divider { border-top-color: #999; }
    #trh-root.trh-light .trh-btn { background: #d5d5d5; border-color: #999; color: #333; }
    #trh-root.trh-light .trh-btn:hover { background: #c5c5c5; border-color: #74c0fc; color: #0066a8; }
    #trh-root.trh-light .trh-btn.active { background: #d6ecfe; border-color: #74c0fc; color: #0066a8; }
    #trh-root.trh-light .trh-bar-bg { background: #a0a0a0; }
    #trh-root.trh-light .trh-rec-box { background: #dddddd; border-color: #999; }
    #trh-root.trh-light .trh-score-detail { color: #666; }
    #trh-root.trh-light .trh-score-detail strong { color: #333333; }
    #trh-root.trh-light .trh-stat-nums { color: #666; }
    #trh-root.trh-light .trh-stat-nums span { color: #333333; }
    #trh-root.trh-light .trh-export-box { background: #dddddd; border-color: #999; color: #555; }
    #trh-root.trh-light .trh-tbs { color: #74c0fc; }
    #trh-root.trh-light .trh-no-history { color: #666; }
    #trh-root.trh-light .trh-slot-row { background: #dddddd; }
    #trh-root.trh-light .trh-slot-label { color: #666; }
    #trh-root.trh-light .trh-slot-mult { color: #555; }
    #trh-root.trh-light .trh-warn { background: #fff8e1; color: #7a5c00; border-color: #e6d28a; }
    #trh-root.trh-light .trh-drift-alert { background: #fff2e0; color: #8a4a00; border-color: #e6b87a; }
    #trh-root.trh-light .trh-history-date { color: #888; }
    #trh-root.trh-light .trh-history-row { border-bottom-color: #ddd; }
    #trh-root.trh-light .trh-custom-field input {
      background: #fff; border-color: #999; color: #333333;
    }
    #trh-root.trh-light .trh-custom-field input:focus { border-color: #74c0fc; }
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

  // Render tabs

  function renderOverview(stats, targets, roles, ratio) {
    const rec = recommendStat(stats, roles, targets);

    const grade = overallGrade(stats, targets, roles, selectedRatio);
    const tbs = Object.values(stats).reduce((a, v) => a + (v || 0), 0);
    const allFound = Object.values(stats).every(v => v !== null);
    const driftWarnings = getDriftWarnings(stats, targets, roles);
    const gradeColor = grade.score >= 90 ? '#4ade80' : grade.score >= 75 ? '#facc15' : '#f87171';

    const statRows = Object.entries(STAT_LABELS).map(([key, label]) => {
      const actual  = stats[key] || 0;
      const target  = targets[key] || 0;
      const isDump  = isStatDumped(key, selectedRatio, roles);
      const isHigh  = roles.high === key;
      const is2nd   = roles.secondary === key;
      const is3rd   = roles.tert1 === key;
      const status  = getStatus(actual, target, isDump);
      const pct     = isDump ? 0 : (target > 0 ? Math.min((actual / target) * 100, 115) : 0);
      const diff    = Math.round(target - actual);
      const diffStr = isDump ? '<span style="color:#888">minimize</span>'
                    : diff > 0 ? `<span style="color:#f87171">+${fmtNum(diff)} needed</span>`
                    : diff < 0 ? `<span style="color:#fb923c">${fmtNum(Math.abs(diff))} over</span>`
                    : `<span style="color:#4ade80">perfect</span>`;

      const roleBadge = isHigh ? '<span style="font-size:9px;color:#74c0fc;letter-spacing:1px;margin-left:4px">1ST</span>'
                      : is2nd  ? '<span style="font-size:9px;color:#ddd;letter-spacing:1px;margin-left:4px">2ND</span>'
                      : is3rd  ? '<span style="font-size:9px;color:#888;letter-spacing:1px;margin-left:4px">3RD</span>'
                      :          '<span style="font-size:9px;color:#f87171;letter-spacing:1px;margin-left:4px">DUMP</span>';

      return `
        <div class="trh-stat-row">
          <div class="trh-stat-top">
            <div class="trh-stat-name" style="color:${STAT_COLORS[key]}">
              ${label}${roleBadge}
            </div>
            <div class="trh-stat-nums">
              <span>${fmtNum(actual)}</span> / ${fmtNum(Math.round(target))}
              &nbsp;<span style="color:${status.color}">${status.grade}</span>
            </div>
          </div>
          <div class="trh-bar-bg">
            <div class="trh-bar-fill" style="width:${Math.min(pct, 100)}%;background:${status.color};${pct > 105 ? 'box-shadow:0 0 6px '+status.color : ''}"></div>
          </div>
          <div class="trh-stat-status" style="color:${status.color}">${status.emoji} ${status.label} - ${diffStr}</div>
        </div>`;
    }).join('');

    const lastEntry = history.length >= 2 ? history[history.length - 2] : null;
    const statKeys = Object.keys(STAT_LABELS);
    const tbsDelta = lastEntry ? tbs - statKeys.reduce((a, k) => a + (lastEntry[k] || 0), 0) : null;

    return `
      ${!allFound ? '<div class="trh-warn">Warning: Some stats could not be read from this page. Try refreshing.</div>' : ''}
      ${driftWarnings.map(w => `<div class="trh-drift-alert">Drift: <strong>${STAT_LABELS[w.key]}</strong> was ${Math.round(w.prevPct*100)}% of target, now ${Math.round(w.currPct*100)}%. Consider rebalancing.</div>`).join('')}

      <div class="trh-section">
        <div style="display:flex;gap:16px;align-items:flex-start;justify-content:space-between">
          <div>
            <div class="trh-label">Ratio Health</div>
            <div class="trh-score-row">
              <div class="trh-grade" style="color:${gradeColor}">${grade.letter}</div>
              <div class="trh-score-detail">
                <div><strong>${grade.score}%</strong> in ratio</div>
                <div style="margin-top:2px">${RATIOS[selectedRatio].label}</div>
              </div>
            </div>
          </div>
          <div style="text-align:right">
            <div class="trh-label">Total Battle Stats</div>
            <div class="trh-tbs">${fmtNum(tbs)}</div>
            ${tbsDelta !== null ? `<div class="trh-tbs-label" style="color:${tbsDelta>=0?'#4ade80':'#f87171'}">${tbsDelta>=0?'+':''}${fmtNum(tbsDelta)} since last visit</div>` : '<div class="trh-tbs-label">TBS</div>'}
          </div>
        </div>
      </div>

      <hr class="trh-divider">

      ${rec ? (() => {
        const need      = Math.round(targets[rec] - (stats[rec] || 0));
        const needText  = need > 0
          ? `Need +${fmtNum(need)}`
          : need < 0
            ? `${fmtNum(Math.abs(need))} over target`
            : `On target`;
        const bestGym   = findBestGymForStat(rec);
        const activeId  = getActiveGymId();
        const suboptimal = bestGym && bestGym.id !== activeId;
        const gymHint   = bestGym
          ? (suboptimal
              ? `<div style="font-size:10px;color:#facc15;margin-top:6px">Best gym: ${escapeHtml(gymName(bestGym.id))} (${bestGym.dots} dots) - click to switch</div>`
              : `<div style="font-size:10px;color:#4ade80;margin-top:6px">Active gym ${escapeHtml(gymName(activeId))} is already best (${bestGym.dots} dots)</div>`)
          : `<div style="font-size:10px;color:#888;margin-top:6px">Gym info not detected</div>`;
        const btnLabel = nextTrainLabel(rec, stats);
        return `
      <div class="trh-section">
        <div class="trh-label">Train Next</div>
        <div class="trh-rec-box">
          <div class="trh-rec-stat" style="color:${STAT_COLORS[rec]}">${STAT_LABELS[rec]}</div>
          <div style="font-size:11px;color:#888">
            Currently at ${fmtNum(stats[rec])} - Target ${fmtNum(Math.round(targets[rec]))} - ${needText}
          </div>
          <div style="font-size:10px;color:#a78bfa;margin-top:2px">
            ${recReason === 'headroom'
              ? 'High stat — opening headroom so you can keep training your best stat'
              : recReason === 'raise'
                ? 'High stat — every other stat is at its ratio cap; raising the bar'
                : recReason === 'failsafe'
                  ? 'Catch-up — below 80% of its ratio cap, topping it back up'
                  : 'Best yield now' + ((gymMults[rec] || 1) > 1.001 ? ' (' + STAT_LABELS[rec] + ' +' + Math.round(((gymMults[rec] || 1) - 1) * 100) + '% gym gains)' : '') + ', riding it as long as possible'}
          </div>
          ${gymHint}
          <button class="trh-btn" id="trh-train-now" data-trh-stat="${rec}" style="margin-top:10px;width:100%">
            ${btnLabel}
          </button>
          <div style="font-size:9px;color:#888;margin-top:4px;text-align:center">
            Each click = 1 action. Keep clicking until trained.
          </div>
        </div>
      </div>
      <hr class="trh-divider">`;
      })() : ''}

      ${(() => {
        const energy = readPageEnergy();
        const roles = getRoles(highStat);
        const room = computeAccessHeadroom(stats, selectedRatio, highStat, roles);
        const energyLine = energy
          ? `Energy ${fmtNum(energy.current)}/${fmtNum(energy.max)}`
          : 'Energy not detected on page';
        const rows = Object.entries(STAT_LABELS).map(([k, l]) => {
          const best = findBestGymForStat(k);
          const gymSuffix = best ? ` <span style="color:#888;font-size:10px">@ ${escapeHtml(gymName(best.id))}</span>` : '';
          const h = room[k];
          let txt, col = '#ddd';
          if (k === highStat || h === Infinity) { txt = 'no limit'; }
          else if (h <= 0) { txt = 'at limit'; col = '#f87171'; }
          // amber when within 0.5% of the stat's value of its limit (getting close)
          else { txt = fmtShort(h) + ' to limit'; if (h < (stats[k] || 0) * 0.005) col = '#facc15'; }
          return `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px">
            <span style="color:${STAT_COLORS[k]}">${l}${gymSuffix}</span>
            <span style="color:${col};font-weight:700">${txt}</span>
          </div>`;
        }).join('');
        return `
      <div class="trh-section">
        <div class="trh-label trh-collapsible" data-trh-collapse="repplan" style="cursor:pointer;user-select:none">
          <span style="display:inline-block;width:12px;text-align:center">${collapseRepPlan ? '▶' : '▼'}</span> Headroom to gym limit
        </div>
        <div${collapseRepPlan ? ' style="display:none"' : ''}>
          <div class="trh-rec-box">
            <div style="font-size:11px;color:#888;margin-bottom:6px">${energyLine}</div>
            ${rows}
            <div style="font-size:10px;color:#888;margin-top:8px;text-align:center">
              Headroom is read straight from your stats (${STAT_LABELS[highStat]}/1.25 − each other stat). Train Next fills 999 (all your energy); a stat already at its limit isn't trained so you keep your special gyms.
            </div>
          </div>
        </div>
      </div>
      <hr class="trh-divider">`;
      })()}

      <div class="trh-section">
        <div class="trh-label trh-collapsible" data-trh-collapse="stats" style="cursor:pointer;user-select:none">
          <span style="display:inline-block;width:12px;text-align:center">${collapseStats ? '▶' : '▼'}</span> Stats
        </div>
        <div${collapseStats ? ' style="display:none"' : ''}>
          ${statRows}
        </div>
      </div>`;
  }

  function renderHistory() {
    if (history.length === 0) {
      return `<div class="trh-no-history">No history yet.<br>Stats are recorded each time you visit this page.<br>Check back after training!</div>`;
    }
    const sorted = [...history].reverse().slice(0, 15);
    const headerRow = `
      <div class="trh-history-row" style="font-size:10px;color:#777;text-transform:uppercase;letter-spacing:1px">
        <div class="trh-history-date">Date</div>
        ${Object.entries(STAT_LABELS).map(([k, label])=>`<div class="trh-history-stat" style="color:${STAT_COLORS[k]}">${label}</div>`).join('')}
        <div class="trh-history-stat">TBS</div>
      </div>`;
    const rows = sorted.map((entry, i) => {
      const prev = sorted[i + 1];
      const tbs = Object.keys(STAT_LABELS).reduce((a, k) => a + (entry[k] || 0), 0);
      const prevTbs = prev ? Object.keys(STAT_LABELS).reduce((a, k) => a + (prev[k] || 0), 0) : null;
      const tbsDelta = prevTbs !== null ? tbs - prevTbs : null;
      return `
        <div class="trh-history-row">
          <div class="trh-history-date">${fmtDate(entry.ts)}</div>
          ${Object.keys(STAT_LABELS).map(k => {
            const delta = prev ? (entry[k]||0) - (prev[k]||0) : null;
            return `<div class="trh-history-stat" style="color:${STAT_COLORS[k]}">
              ${fmtShort(entry[k])}
              ${delta !== null && delta !== 0 ? `<div class="trh-history-delta" style="color:${delta>0?'#4ade80':'#f87171'}">${delta>0?'+':''}${fmtShort(delta)}</div>` : ''}
            </div>`;
          }).join('')}
          <div class="trh-history-stat" style="color:#74c0fc">
            ${fmtShort(tbs)}
            ${tbsDelta !== null && tbsDelta !== 0 ? `<div class="trh-history-delta" style="color:${tbsDelta>0?'#4ade80':'#f87171'}">${tbsDelta>0?'+':''}${fmtShort(tbsDelta)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="trh-section">
        <div class="trh-label">Stat History (last ${sorted.length} snapshots)</div>
        ${headerRow}${rows}
      </div>
      <div style="text-align:right;margin-top:8px">
        <button class="trh-btn" id="trh-clear-history">Clear History</button>
      </div>`;
  }

  function renderExport(stats, targets, roles) {
    const exportText = buildExportText(stats, targets, roles);

    return `
      <div class="trh-section">
        <div class="trh-label">Export Snapshot</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">
          Copy a plain-text summary of your current ratio health and target stats.
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button class="trh-btn" id="trh-copy-export">Copy to Clipboard</button>
        </div>
        <pre id="trh-export-text" class="trh-export-box">${escapeHtml(exportText)}</pre>
      </div>`;
  }

  function renderSettings() {
    const roles = getRoles(highStat);
    const ratio = RATIOS[selectedRatio];

    const slotOrder = [
      { role: 'high',      label: '1st - highest',    mult: 1.00 },
      { role: 'secondary', label: '2nd',               mult: ratio.multipliers.secondary },
      { role: 'tert1',     label: '3rd',               mult: ratio.multipliers.tert1 },
      { role: 'tert2',     label: '4th - dump/lowest', mult: ratio.multipliers.tert2 },
    ];

    const mappingRows = slotOrder.map(({ role, label, mult }) => {
      const statKey = roles[role];
      const isDump  = mult === 0;
      return `
        <div class="trh-slot-row">
          <span class="trh-slot-label">${label}</span>
          <span style="flex:1;color:${STAT_COLORS[statKey]};font-weight:700">${STAT_LABELS[statKey]}</span>
          <span class="trh-slot-mult" style="color:${isDump ? '#f87171' : ''}">${isDump ? 'dump (x0)' : 'x' + mult.toFixed(2)}</span>
        </div>`;
    }).join('');

    return `
      <div class="trh-section">
        <div class="trh-label">Active Ratio</div>
        <div class="trh-ctrl-row">
          ${Object.entries(RATIOS).map(([k, r]) =>
            `<button class="trh-btn ${selectedRatio === k ? 'active' : ''}" data-trh-ratio="${k}">${r.short}</button>`
          ).join('')}
        </div>
      </div>
      <div class="trh-section">
        <div class="trh-label">Your Highest Stat</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">
          Pick whichever stat you train the most. The 2nd, 3rd and 4th slots are assigned automatically. Use the Custom Ratio section below if you want different multipliers.
        </div>
        <div class="trh-ctrl-row">
          ${Object.entries(STAT_LABELS).map(([k, l]) =>
            `<button class="trh-btn ${highStat === k ? 'active' : ''}" data-trh-high="${k}">${l}</button>`
          ).join('')}
        </div>
      </div>
      <div class="trh-section">
        <div class="trh-label">Dump Stat</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">
          Pick which stat should sit in the dump/lowest slot (4th). The remaining two auto-fill the 2nd and 3rd slots.${ratio.forcedDump ? ` <strong style="color:${STAT_COLORS[ratio.forcedDump]}">${STAT_LABELS[ratio.forcedDump]}</strong> is the recommended dump for ${ratio.label}.` : ''}
        </div>
        <div class="trh-ctrl-row">
          ${Object.entries(STAT_LABELS)
            .filter(([k]) => k !== highStat)
            .map(([k, l]) => `<button class="trh-btn ${roles.tert2 === k ? 'active' : ''}" data-trh-defdump="${k}">Dump ${l}</button>`)
            .join('')}
        </div>
      </div>
      <div class="trh-section">
        <div class="trh-label">Current Stat Order for ${ratio.label}</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">
          The multiplier (x) shows what fraction of your 1st stat each one is targeted at.
        </div>
        ${mappingRows}
      </div>
      <hr class="trh-divider">
      <div class="trh-section">
        <div class="trh-label">Display</div>
        <div class="trh-ctrl-row">
          <button class="trh-btn ${theme==='dark'?'active':''}" data-trh-theme="dark">Dark</button>
          <button class="trh-btn ${theme==='light'?'active':''}" data-trh-theme="light">Light</button>
        </div>
      </div>
      <hr class="trh-divider">
      <div class="trh-section">
        <div class="trh-label">Ratio Multipliers</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">
          Showing values for <strong>${ratio.label}</strong>. Each number is a multiplier relative to your 1st stat (0.80 = train to 80% of highest). Edit and save to store your own Custom ratio.
        </div>
        <div class="trh-custom-grid">
          <div class="trh-custom-field">
            <label style="color:${STAT_COLORS[roles.high]}">1st - ${STAT_LABELS[roles.high]} (always 1.0)</label>
            <input type="number" value="1.00" disabled style="opacity:0.4">
          </div>
          <div class="trh-custom-field">
            <label style="color:${STAT_COLORS[roles.secondary]}">2nd - ${STAT_LABELS[roles.secondary]}</label>
            <input id="trh-c-secondary" type="number" step="0.01" min="0" max="1" value="${ratio.multipliers.secondary}">
          </div>
          <div class="trh-custom-field">
            <label style="color:${STAT_COLORS[roles.tert1]}">3rd - ${STAT_LABELS[roles.tert1]}</label>
            <input id="trh-c-tert1" type="number" step="0.01" min="0" max="1" value="${ratio.multipliers.tert1}">
          </div>
          <div class="trh-custom-field">
            <label style="color:${STAT_COLORS[roles.tert2]}">4th / Dump - ${STAT_LABELS[roles.tert2]}</label>
            <input id="trh-c-tert2" type="number" step="0.01" min="0" max="1" value="${ratio.multipliers.tert2}">
          </div>
        </div>
        <div style="margin-top:8px">
          <button class="trh-btn" id="trh-save-custom">Save as Custom Ratio</button>
        </div>
      </div>
      <hr class="trh-divider">
      <div class="trh-section">
        <div class="trh-label">Gym Gain Multipliers (Steadfast + perks)</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px">
          Read from the Torn API (<code>user?selections=perks</code>) using your saved key — Steadfast, education, property and book gym-gain perks, combined the way Torn stacks them. The rep plan weights each stat's gains by these. Updated on load and when you refresh.
        </div>
        <div class="trh-ctrl-row" style="flex-wrap:wrap">
          ${Object.entries(STAT_LABELS).map(([k, l]) => {
            const pct = Math.round(((gymMults[k] || 1) - 1) * 1000) / 10;
            return `<span class="trh-slot-mult" style="color:${STAT_COLORS[k]};margin-right:10px">${l}: +${pct}%</span>`;
          }).join('')}
        </div>
        <div style="font-size:11px;color:${buildKeepsSpecialGyms(selectedRatio, roles) ? '#4ade80' : '#facc15'};margin-top:8px">
          ${buildKeepsSpecialGyms(selectedRatio, roles)
            ? `Special-gym access protection: <strong>ON</strong> for ${STAT_LABELS[highStat]}-high (keeps the x1.25 access ratio safe).`
            : `Special-gym access protection: <strong>OFF</strong> — this ratio targets a secondary stat above 80% of your high stat, which can't keep the special gyms.`}
        </div>
        <div style="font-size:10px;color:#666;margin-top:4px">
          ${gymMultsFetchedAt ? 'Last updated: ' + new Date(gymMultsFetchedAt).toLocaleString() : 'Not fetched yet — set a key and refresh.'}
        </div>
        ${gymMultsError ? `<div class="trh-warn" style="margin-top:6px;margin-bottom:0">
          Could not refresh the multipliers: ${escapeHtml(gymMultsError)}${gymMultsFetchedAt ? ' — the values above are the last ones that arrived, so the rep plan may be weighting the wrong stat.' : ' — the rep plan is running on 1.0 for every stat.'}
        </div>` : ''}
        <div class="trh-ctrl-row" style="margin-top:8px">
          <button class="trh-btn" id="trh-set-apikey">Set API key</button>
          <button class="trh-btn" id="trh-refresh-mults">Refresh now</button>
        </div>
      </div>`;
  }

  // Info tab
  function renderInfo() {
    return `
      <div class="trh-section">
        <div class="trh-label">Why not just train all stats equally?</div>
        <div style="font-size:12px;color:#ddd;line-height:1.7">
          Torn has <strong style="color:#e2e8f0">specialist gyms</strong> that give significantly better gains than regular gyms - but they have <strong style="color:#e2e8f0">stat ratio requirements</strong> to unlock and keep access. Baldr's and Hank's ratios are the two most popular ways to structure your stats so you can use those better gyms on as many stats as possible.
        </div>
      </div>

      <hr class="trh-divider">

      <div class="trh-section">
        <div class="trh-label">Gym Dots - Why They Matter</div>
        <div style="font-size:12px;color:#ddd;line-height:1.7;margin-bottom:8px">
          Gym dots are a multiplier on your stat gains per energy spent. Higher dots = more gains per train. The values below are approximate and may vary by gym.
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:11px">
          <div style="background:#222;border:1px solid #444;border-radius:4px;padding:8px;text-align:center">
            <div style="color:#888;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">George's Gym</div>
            <div style="color:#facc15;font-size:18px;font-weight:700">~7.3</div>
            <div style="color:#888;font-size:10px">dots - 10e/train</div>
            <div style="color:#888;font-size:10px;margin-top:4px">No requirements</div>
          </div>
          <div style="background:#222;border:1px solid #444;border-radius:4px;padding:8px;text-align:center">
            <div style="color:#888;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Special Gyms</div>
            <div style="color:#fb923c;font-size:18px;font-weight:700">~7.5</div>
            <div style="color:#888;font-size:10px">dots - 25e/train</div>
            <div style="color:#888;font-size:10px;margin-top:4px">Ratio required</div>
          </div>
          <div style="background:#222;border:1px solid #444;border-radius:4px;padding:8px;text-align:center">
            <div style="color:#888;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Elite Gyms</div>
            <div style="color:#4ade80;font-size:18px;font-weight:700">~8.0</div>
            <div style="color:#888;font-size:10px">dots - 50e/train</div>
            <div style="color:#888;font-size:10px;margin-top:4px">Strict ratio req.</div>
          </div>
        </div>
      </div>

      <hr class="trh-divider">

      <div class="trh-section">
        <div class="trh-label">Baldr's Ratio - 1.25 : 1 : 0.75 : 0.75</div>
        <div style="font-size:12px;color:#ddd;line-height:1.7;margin-bottom:8px">
          A <strong style="color:#e2e8f0">balanced specialist build</strong>. Your high stat leads, secondary sits at 80% of it, and your two lower stats sit at 75% (about 60% relative to high). Your lowest stat is still around 22% of your total - a much more even spread.
        </div>
        <div style="font-size:12px;color:#ddd;line-height:1.7;margin-bottom:8px">
          With Baldr's you unlock <strong style="color:#e2e8f0">two specialist gyms</strong>: one elite (8.0 dots) for your high stat, and one special (7.5 dots) for your secondary. Your two lower stats train at George's.
        </div>
        <div style="background:#0a2010;border:1px solid #1a4020;border-left:3px solid #4ade80;border-radius:4px;padding:8px 10px;font-size:11px;color:#86efac">
          Best for: Any stat pairing - works equally well for offensive (Str/Spd) or defensive (Def/Dex) high stat builds. Good all-around starting point for most players.
        </div>
      </div>

      <hr class="trh-divider">

      <div class="trh-section">
        <div class="trh-label">Hank's Ratio - 1.25 : 1 : 1 : ~0</div>
        <div style="font-size:12px;color:#ddd;line-height:1.7;margin-bottom:8px">
          An <strong style="color:#e2e8f0">aggressive efficiency build</strong>. Three stats are trained hard while one (the dump stat) is kept as low as possible. This unlocks <strong style="color:#e2e8f0">two specialist gyms for three stats</strong> simultaneously, giving faster overall gains.
        </div>
        <div style="font-size:12px;color:#ddd;line-height:1.7;margin-bottom:8px">
          <strong style="color:#e2e8f0">Important:</strong> For Hank's, your high stat almost has to be Def or Dex - <em style="color:#64748b">not Str or Spd</em>. If you dump Speed, you'll miss most attacks. If you dump Strength, you'll hit often but deal little to no damage. Either way you lose fights.
        </div>
        <div style="background:#200a0a;border:1px solid #402020;border-left:3px solid #f87171;border-radius:4px;padding:8px 10px;font-size:11px;color:#fca5a5">
          Best for: Def or Dex high-stat builds in mid-to-late game. More total gains over time, but very restrictive - your dump stat must stay extremely low. Hard to switch away from later.
        </div>
      </div>

      <hr class="trh-divider">

      <div class="trh-section">
        <div class="trh-label">Stats Explained</div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:12px">
          <div style="display:flex;gap:10px;align-items:flex-start;padding:6px;background:#222;border-radius:4px">
            <div><strong style="color:#f97316">Strength</strong> <span style="color:#888;font-size:10px">OFFENSIVE</span><br><span style="color:#64748b">How hard you hit. More Str = more damage per successful strike. Useless if your Speed is too low to land hits.</span></div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;padding:6px;background:#222;border-radius:4px">
            <div><strong style="color:#22d3ee">Speed</strong> <span style="color:#888;font-size:10px">OFFENSIVE</span><br><span style="color:#64748b">How often you hit. More Spd = higher hit chance each round. Str and Spd work together - you need both to deal reliable damage.</span></div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;padding:6px;background:#222;border-radius:4px">
            <div><strong style="color:#a78bfa">Defense</strong> <span style="color:#888;font-size:10px">DEFENSIVE</span><br><span style="color:#64748b">Reduces damage you take when hit. Works independently from Dexterity. High Def = you survive longer in fights.</span></div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;padding:6px;background:#222;border-radius:4px">
            <div><strong style="color:#4ade80">Dexterity</strong> <span style="color:#888;font-size:10px">DEFENSIVE</span><br><span style="color:#64748b">How often you dodge enemy attacks. More Dex = enemy hits less often. Also works independently from Defense.</span></div>
          </div>
        </div>
      </div>`;
  }

  // Main render
  function render(stats) {
    const roles   = getRoles(highStat);
    const targets = computeTargets(stats, selectedRatio, highStat);

    let tabContent = '';
    if (activeTab === 'overview')        tabContent = renderOverview(stats, targets, roles, selectedRatio);
    else if (activeTab === 'history')    tabContent = renderHistory();
    else if (activeTab === 'export')     tabContent = renderExport(stats, targets, roles);
    else if (activeTab === 'settings')   tabContent = renderSettings();
    else if (activeTab === 'info')       tabContent = renderInfo();

    const tabs = [
      { id: 'overview',  label: 'Overview' },
      { id: 'history',   label: 'History' },
      { id: 'export',    label: 'Export' },
      { id: 'settings',  label: 'Settings' },
      { id: 'info',      label: 'Info' },
    ];

    return `
      <div id="trh-root" class="${theme === 'light' ? 'trh-light' : ''}">
        <div id="trh-header">
          <div id="trh-title">StatForge</div>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="font-size:10px;color:#777;letter-spacing:1px">
              ${RATIOS[selectedRatio].short.toUpperCase()} - ${STAT_LABELS[highStat].toUpperCase()} HIGH
            </div>
          </div>
        </div>
        <div id="trh-tabs">
          ${tabs.map(t => `<button class="trh-tab ${activeTab === t.id ? 'active' : ''}" data-trh-tab="${t.id}">${t.label}</button>`).join('')}
        </div>
        <div id="trh-body">
          ${tabContent}
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
      const btn = e.target.closest('button, [data-trh-tab], [data-trh-ratio], [data-trh-high], [data-trh-theme], [data-trh-defdump], [data-trh-collapse]');
      if (!btn) return;

      if (btn.dataset.trhTab)   { activeTab = btn.dataset.trhTab; injectPanel(); return; }
      if (btn.dataset.trhRatio) { selectedRatio = btn.dataset.trhRatio; store.set('trh_ratio', selectedRatio); injectPanel(); return; }
      if (btn.dataset.trhHigh)  { highStat = btn.dataset.trhHigh; store.set('trh_high', highStat); headroomBaseHigh = null; failSafeStat = null; injectPanel(); return; }
      if (btn.dataset.trhTheme) { theme = btn.dataset.trhTheme; store.set('trh_theme', theme); injectPanel(); return; }
      if (btn.dataset.trhDefdump) { defensiveDump = btn.dataset.trhDefdump; store.set('trh_def_dump', defensiveDump); injectPanel(); return; }
      if (btn.dataset.trhCollapse) {
        const key = btn.dataset.trhCollapse;
        if (key === 'repplan') { collapseRepPlan = !collapseRepPlan; store.set('trh_collapse_repplan', collapseRepPlan); }
        else if (key === 'stats') { collapseStats = !collapseStats; store.set('trh_collapse_stats', collapseStats); }
        injectPanel();
        return;
      }

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
        customMults = {
          high:      1.00,
          secondary: readNumberInput('trh-c-secondary', 0.80),
          tert1:     readNumberInput('trh-c-tert1', 0.60),
          tert2:     readNumberInput('trh-c-tert2', 0.60),
        };
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
          })
          .finally(() => {
            setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 2000);
          });
        return;
      }

    });
  }

  // Init

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
    const warningVisible = document.querySelector('#trh-wrapper .trh-warn');
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
