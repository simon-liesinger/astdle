/* ASTdle — daily AST multiple-choice practice. All state lives in localStorage. */
(() => {
  'use strict';
  const SALT = '6a4805ac1d23fbd076887d53ead10fb1';   // must match tools/build.mjs
  const LAUNCH = Date.UTC(2026, 10, 8) / 864e5;       // ASTdle #1 = 8 Nov 2026
  const ORDER_SEED = 0xA57D1E;                        // fixes the daily sequence
  const LOOKAHEAD = 30;                               // practice never shows the next 30 dailies
  const K = { code: 'astdle.code', daily: 'astdle.daily', seen: 'astdle.seen', cur: 'astdle.practiceCurrent', lap: 'astdle.lap', timer: 'astdle.timer' };
  const TIME_LIMIT = 100;                             // seconds per question, as on the real test

  const $ = s => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- crypto ----------
  const enc = new TextEncoder();
  let KEY = null;
  async function deriveKey(code) {
    const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(SALT), iterations: 150000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function open(buf, key) {
    const b = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12));
  }
  let BLOB = null;
  async function fetchBlob() {
    if (!BLOB) { const r = await fetch('q.bin', { cache: 'no-cache' }); if (!r.ok) throw new Error('fetch'); BLOB = await r.arrayBuffer(); }
    return BLOB;
  }
  async function unlock(code) {
    code = (code || '').trim();
    if (!code) return null;
    const key = await deriveKey(code);
    try { const plain = await open(await fetchBlob(), key); KEY = key; return JSON.parse(new TextDecoder().decode(plain)); }
    catch (e) { if (e && e.message === 'fetch') throw e; return null; }
  }
  const figCache = new Map();
  function figURL(name) {
    if (!figCache.has(name)) {
      figCache.set(name, fetch(name).then(r => r.arrayBuffer()).then(b => open(b, KEY))
        .then(p => URL.createObjectURL(new Blob([p], { type: 'image/jpeg' }))));
    }
    return figCache.get(name);
  }

  // ---------- data / scheduling ----------
  let DATA, QBY = {}, UBY = {}, ORDER = [];
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function buildOrder() {
    const ids = DATA.questions.map(q => q.id).sort();
    const rnd = mulberry32(ORDER_SEED);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    ORDER = ids;
  }
  function todayIdx() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; }
  const dailyNum = () => todayIdx() - LAUNCH + 1;
  function dailyFor(n) { const N = ORDER.length; return ORDER[(((n - 1) % N) + N) % N]; }
  function upcomingDailies() { const s = new Set(); const n = dailyNum(); for (let i = 0; i <= LOOKAHEAD; i++) s.add(dailyFor(n + i)); return s; }

  function pickPractice(excludeId) {
    const seen = store.get(K.seen, {});
    const block = upcomingDailies();
    let lap = store.get(K.lap, 0);
    const fresh = () => ORDER.filter(id => !block.has(id) && id !== excludeId && !(seen[id] && (seen[id].lap || 0) >= lap));
    let pool = fresh();
    if (!pool.length) {           // seen everything: start a new lap (still skipping upcoming dailies)
      store.set(K.lap, ++lap);
      toast('You’ve done every question! Starting a fresh lap.');
      pool = fresh();
    }
    if (!pool.length) pool = ORDER.filter(id => id !== excludeId && id !== dailyFor(dailyNum()));   // tiny question sets only
    if (!pool.length) pool = ORDER;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function markSeen(id, correct, secs) {
    const seen = store.get(K.seen, {});
    seen[id] = { c: correct ? 1 : 0, t: todayIdx(), lap: store.get(K.lap, 0), s: secs };
    store.set(K.seen, seen);
  }

  // ---------- timer ----------
  let tick = null, tStart = 0, tId = null;
  const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  function paintTimer(elapsed, done) {
    const e = $('#timer'); e.hidden = false;
    const left = TIME_LIMIT - elapsed;
    e.textContent = left >= 0 ? fmt(left) : '+' + fmt(-left);
    e.classList.toggle('over', left < 0);
    e.classList.toggle('low', left >= 0 && left <= 20);
    e.classList.toggle('done', !!done);
    e.setAttribute('aria-label', left >= 0 ? `${left} seconds left` : `${-left} seconds over time`);
  }
  function startTimer(id) {
    clearInterval(tick);
    const saved = store.get(K.timer, {});               // start times per unanswered question: survives reloads and tab switches
    const m = saved && typeof saved === 'object' && !saved.id ? saved : {};
    tId = id; tStart = m[id] || Date.now(); m[id] = tStart;
    store.set(K.timer, m);
    const upd = () => paintTimer(Math.min(5999, Math.floor((Date.now() - tStart) / 1000)), false);
    upd(); tick = setInterval(upd, 250);
  }
  function stopTimer() {
    clearInterval(tick); tick = null;
    const secs = Math.max(0, Math.floor((Date.now() - tStart) / 1000));
    const m = store.get(K.timer, {}); if (m && tId) { delete m[tId]; store.set(K.timer, m); }
    paintTimer(Math.min(5999, secs), true);
    return secs;
  }
  function frozenTimer(secs) {
    clearInterval(tick); tick = null;
    if (secs == null) { $('#timer').hidden = true; return; }
    paintTimer(secs, true);
  }

  // ---------- rendering ----------
  const md = s => marked.parse(lineNums(s || ''), { breaks: false, gfm: true });
  const mdInline = s => marked.parseInline(s || '', { gfm: true });
  function lineNums(s) { return s.replace(/ \[(\d{1,3})\](?= |$)/gm, '<sup class="ln">$1</sup>'); }

  let mode = 'daily';
  function render() {
    $('#tabDaily').classList.toggle('active', mode === 'daily');
    $('#tabPractice').classList.toggle('active', mode === 'practice');
    $('#dailyNum').textContent = '#' + dailyNum();
    updateStreak();
    if (mode === 'daily') {
      const n = dailyNum();
      const rec = store.get(K.daily, {})[n];
      showQuestion(dailyFor(n), { kind: 'daily', n, answered: rec ? rec.a : null, secs: rec ? rec.s : null });
    } else {
      let cur = store.get(K.cur, null);
      if (!cur || !QBY[cur.id] || upcomingDailies().has(cur.id) && !cur.a) { cur = { id: pickPractice() }; store.set(K.cur, cur); }
      showQuestion(cur.id, { kind: 'practice', answered: cur.a || null, secs: cur.s });
    }
  }

  function showQuestion(id, ctx) {
    const q = QBY[id], u = UBY[q.unit];
    const w = $('#qwrap'); w.innerHTML = '';
    const hasStim = (u.stimulus && u.stimulus.trim()) || u.figures.length || u.intro;

    if (hasStim) {
      const c = el('div', 'card');
      c.append(el('div', 'meta', `<span>AST ${u.year} · ${esc(u.title)}</span>`));
      if (u.intro) c.append(el('div', 'intro', md(u.intro)));
      if (u.stimulus) c.append(el('div', 'stimulus', md(u.stimulus)));
      if (u.figures.length) c.append(figs(u.figures));
      w.append(c);
    }
    const qc = el('div', 'card'); qc.id = 'qcard';
    if (!hasStim) qc.append(el('div', 'meta', `<span>AST ${u.year}</span>`));
    const stem = el('div', 'stem', md(q.stem)); qc.append(stem);
    if (q.figures.length) qc.append(figs(q.figures));
    const opts = el('div', 'opts');
    for (const L of ['A', 'B', 'C', 'D']) {
      const b = el('button', 'opt', `<span class="L">${L}</span><span class="T">${mdInline(q.options[L])}</span>`);
      b.dataset.l = L;
      b.onclick = () => answer(q, ctx, L);
      opts.append(b);
    }
    qc.append(opts);
    w.append(qc);
    if (ctx.answered) { frozenTimer(ctx.secs); reveal(q, ctx, ctx.answered, false, ctx.secs); }
    else { startTimer(q.id); if (hasStim) window.scrollTo({ top: 0 }); }
    // prefetch figures for the next practice question
  }

  function figs(list) {
    const box = el('div', 'figs');
    for (const name of list) {
      const img = document.createElement('img'); img.alt = 'Figure'; img.decoding = 'async';
      figURL(name).then(u => { img.src = u; }).catch(() => { img.alt = 'Figure failed to load'; });
      img.onclick = () => { const z = $('#zoom'); z.querySelector('img').src = img.src; z.hidden = false; };
      box.append(img);
    }
    box.append(el('div', 'fig-hint', 'Tap a figure to enlarge'));
    return box;
  }

  function answer(q, ctx, L) {
    const correct = L === q.answer;
    if (ctx.kind === 'daily' && store.get(K.daily, {})[ctx.n]) return;
    const secs = stopTimer();
    if (ctx.kind === 'daily') {
      const d = store.get(K.daily, {});
      d[ctx.n] = { id: q.id, a: L, c: correct ? 1 : 0, s: secs }; store.set(K.daily, d);
    } else {
      store.set(K.cur, { id: q.id, a: L, s: secs });
    }
    markSeen(q.id, correct, secs);
    if (navigator.vibrate) try { navigator.vibrate(correct ? 30 : [40, 60, 40]); } catch {}
    reveal(q, ctx, L, true, secs);
    updateStreak();
  }

  function reveal(q, ctx, L, fresh, secs) {
    const correct = L === q.answer;
    document.querySelectorAll('.opt').forEach(b => {
      b.disabled = true;
      if (b.dataset.l === q.answer) b.classList.add('correct');
      else if (b.dataset.l === L) b.classList.add('wrong');
    });
    const qc = $('#qcard');
    const ex = el('div', 'card explain' + (fresh ? ' reveal' : ''));
    ex.append(el('div', 'verdict ' + (correct ? 'ok' : 'bad'), correct ? 'Correct!' : `Not quite — the answer is ${q.answer}`));
    if (secs != null) {
      const over = secs > TIME_LIMIT;
      ex.append(el('div', 'time-note' + (over ? ' over' : ''),
        `⏱ ${fmt(secs)}` + (over ? ` — ${fmt(secs - TIME_LIMIT)} over the 1:40 budget` : ` — within the 1:40 budget`)));
    }
    if (q.explain) ex.append(el('div', '', md(q.explain)));
    qc.after(ex);

    const act = el('div', 'card');
    if (ctx.kind === 'daily') {
      act.append(el('p', 'done-note', `That’s today’s ASTdle done. Next one at midnight.`));
      const row = el('div', 'actions');
      row.append(btn('Share', 'secondary', () => share(ctx.n, correct, secs)));
      row.append(btn('Keep practising →', 'primary', () => { mode = 'practice'; render(); window.scrollTo({ top: 0 }); }));
      act.append(row);
    } else {
      const row = el('div', 'actions');
      row.append(btn('Next question →', 'primary', () => { store.set(K.cur, { id: pickPractice(q.id) }); render(); window.scrollTo({ top: 0 }); }));
      act.append(row);
    }
    ex.after(act);
    if (fresh) setTimeout(() => ex.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  }

  // ---------- streaks / stats / share ----------
  function streaks() {
    const d = store.get(K.daily, {}); const n = dailyNum();
    let cur = 0, i = d[n] ? n : n - 1;           // today not yet played doesn't break the streak
    while (d[i]) { cur++; i--; }
    let best = 0, run = 0; const keys = Object.keys(d).map(Number).sort((a, b) => a - b);
    for (let k = 0; k < keys.length; k++) { run = (k && keys[k] === keys[k - 1] + 1) ? run + 1 : 1; best = Math.max(best, run); }
    let cc = 0; i = d[n] ? n : n - 1; while (d[i] && d[i].c) { cc++; i--; }
    return { cur, best, cc, played: keys.length, right: keys.filter(k => d[k].c).length };
  }
  function updateStreak() {
    const s = streaks(); const e = $('#streak');
    e.hidden = !s.cur; e.textContent = `🔥 ${s.cur}`; e.title = `${s.cur}-day streak`;
  }
  function share(n, correct, secs) {
    const s = streaks();
    const t = secs == null ? '' : ` ⏱ ${fmt(secs)}${secs > TIME_LIMIT ? ' 🐢' : ''}`;
    const text = `ASTdle #${n} ${correct ? '✅' : '❌'}${t}\n🔥 ${s.cur} day streak` + (s.cc > 1 ? ` · ${s.cc} right in a row` : '');
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'));
  }
  function showStats() {
    const s = streaks(); const seen = store.get(K.seen, {});
    const vals = Object.values(seen); const right = vals.filter(v => v.c).length;
    const pct = vals.length ? Math.round(100 * right / vals.length) : 0;
    const timed = vals.filter(v => typeof v.s === 'number');
    const avg = timed.length ? Math.round(timed.reduce((a, v) => a + v.s, 0) / timed.length) : null;
    $('#statsBody').innerHTML = `
      <div class="statgrid">
        <div><b>${s.played}</b><span>Dailies played</span></div>
        <div><b>${s.cur}</b><span>Current streak</span></div>
        <div><b>${s.best}</b><span>Best streak</span></div>
        <div><b>${vals.length}</b><span>Questions answered</span></div>
        <div><b>${pct}%</b><span>Correct</span></div>
        <div><b>${avg == null ? '–' : fmt(avg)}</b><span>Avg time (target 1:40)</span></div>
      </div>`;
    $('#stats').showModal();
  }

  // ---------- helpers ----------
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function btn(t, cls, fn) { const b = el('button', cls, esc(t)); b.onclick = fn; return b; }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  let tt; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2200); }
  function screen(id) { for (const s of ['gate', 'loading', 'play']) $('#' + s).hidden = s !== id; }

  // ---------- boot ----------
  async function start(data) {
    DATA = data;
    for (const q of DATA.questions) QBY[q.id] = q;
    for (const u of DATA.units) UBY[u.id] = u;
    buildOrder();
    screen('play');
    render();
  }

  async function boot() {
    $('#tabDaily').onclick = () => { mode = 'daily'; render(); };
    $('#tabPractice').onclick = () => { mode = 'practice'; render(); };
    $('#statsBtn').onclick = () => DATA && showStats();
    $('#statsClose').onclick = () => $('#stats').close();
    $('#zoom').onclick = e => { if (e.target.tagName !== 'IMG') $('#zoom').hidden = true; };
    $('#zoom').querySelector('img').onclick = () => {};
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#zoom').hidden = true; });
    document.addEventListener('visibilitychange', () => {   // roll over to the new daily if left open past midnight
      if (!document.hidden && DATA && $('#dailyNum').textContent !== '#' + dailyNum()) render();
    });

    // code from QR link (?k=...) or a previous visit
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('k');
    if (fromUrl) { url.searchParams.delete('k'); history.replaceState(null, '', url.pathname + url.search + url.hash); }
    const candidates = [fromUrl, store.get(K.code, null)].filter(Boolean);
    try {
      for (const c of candidates) {
        const data = await unlock(c);
        if (data) { store.set(K.code, c.trim()); return start(data); }
      }
    } catch { screen('gate'); $('#gateMsg').textContent = 'Couldn’t load questions — check your connection and reload.'; return; }
    if (candidates.length) store.del(K.code);
    screen('gate');
    $('#gateForm').onsubmit = async e => {
      e.preventDefault();
      const c = $('#codeInput').value;
      $('#gateMsg').textContent = '';
      const b = e.submitter || $('#gateForm button'); b.disabled = true;
      try {
        const data = await unlock(c);
        if (data) { store.set(K.code, c.trim()); start(data); }
        else $('#gateMsg').textContent = 'That code didn’t work. Check it and try again.';
      } catch { $('#gateMsg').textContent = 'Couldn’t load questions — check your connection.'; }
      b.disabled = false;
    };
  }
  boot();
})();
