(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const SAVE_KEY = 'jeopardy-save-v1';
  const ROOM_KEY = 'jeopardy-room-v1';
  const PID_KEY = 'jeopardy-pid-v1';
  const PEER_PREFIX = 'jpdy-board-';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n);
  const blank = (v) => ({ value: v, q: '', a: '', qImg: '', aImg: '', used: false });

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  function show(id) {
    ['landing', 'host', 'player'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
    mode = id;
  }
  let mode = 'landing';

  /* ======================= LANDING ======================= */
  // The room code is derived from this page's URL, so everyone who opens the
  // same GitHub Pages link lands in the same game with no code to type.
  function autoCode() {
    const s = location.host + location.pathname.replace(/index\.html$/, '').replace(/\/+$/, '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'g' + h.toString(36);
  }
  const savedName = localStorage.getItem('jeopardy-name');
  if (savedName) $('#joinName').value = savedName;

  $('#btnHost').onclick = startHost;
  $('#btnJoin').onclick = () => {
    const name = $('#joinName').value.trim();
    if (!name) return ($('#joinMsg').textContent = 'Please enter your name.');
    localStorage.setItem('jeopardy-name', name);
    startPlayer(name, autoCode());
  };
  $('#joinName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });

  /* ======================= HOST ======================= */
  let state, peer, roomCode;
  const conns = {}; // playerId -> connection
  let editing = null;
  let audioCtx;

  function defaultBoard() {
    const vals = [200, 400, 600, 800, 1000];
    const board = { cats: [1, 2, 3, 4, 5].map((i) => ({ name: 'Category ' + i, clues: vals.map(blank) })) };
    board.cats[0].clues[0].q = 'This planet is known as the Red Planet.';
    board.cats[0].clues[0].a = 'What is Mars?';
    return board;
  }

  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (s && s.board && Array.isArray(s.board.cats) && s.board.cats.length) return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ board: state.board, players: state.players }));
    } catch (e) {
      toast('Auto-save failed (images too large?). Use Export to keep a backup.');
    }
  }

  function randCode() {
    const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += ch[Math.floor(Math.random() * ch.length)];
    return s;
  }

  function startHost() {
    if (typeof Peer === 'undefined') { toast('Could not load PeerJS. Check your internet connection.'); }
    show('host');
    const saved = loadSaved();
    state = {
      board: saved ? saved.board : defaultBoard(),
      players: saved ? (saved.players || []).map((p) => ({ id: p.id, name: p.name, score: p.score || 0 })) : [],
      current: null,
      buzz: { open: false, openedAt: 0, list: [] },
    };
    openPeer(autoCode(), 0);
    renderHost();
  }

  function setStatus(t) { $('#connStatus').textContent = t; }

  function openPeer(code, tries) {
    setStatus('Connecting…');
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
    peer = new Peer(PEER_PREFIX + code);
    peer.on('open', () => {
      roomCode = code;
      localStorage.setItem(ROOM_KEY, code);
      $('#roomCode').textContent = code;
      setStatus('● Online');
    });
    peer.on('connection', (conn) => {
      conn.on('data', (d) => onHostData(conn, d));
      conn.on('close', () => onConnClose(conn));
      conn.on('error', () => onConnClose(conn));
    });
    peer.on('disconnected', () => { setStatus('Reconnecting…'); try { peer.reconnect(); } catch (e) { /* ignore */ } });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // old session for the same code is still registered; wait, then fall back to a new code
        // Either another host tab is open, or the previous session is still clearing.
        setStatus('Waiting… (is the host open in another tab?)');
        setTimeout(() => openPeer(code, tries + 1), 3000);
      } else {
        setStatus('Connection problem: ' + err.type);
      }
    });
  }

  function onHostData(conn, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'join') {
      const name = String(d.name || '').trim().slice(0, 20) || 'Player';
      let p = state.players.find((x) => x.id === d.pid);
      if (!p) p = state.players.find((x) => x.name.toLowerCase() === name.toLowerCase() && !conns[x.id]);
      if (!p) {
        p = { id: String(d.pid || 'p' + Math.random().toString(36).slice(2, 10)), name, score: 0 };
        state.players.push(p);
      }
      conn.pid = p.id;
      conns[p.id] = conn;
      conn.send({ t: 'joined', pid: p.id, name: p.name });
      save();
      renderHost();
      sync();
    } else if (d.t === 'buzz') {
      if (conn.pid) handleBuzz(conn.pid);
    }
  }

  function onConnClose(conn) {
    if (conn.pid && conns[conn.pid] === conn) delete conns[conn.pid];
    renderHost();
    sync();
  }

  function handleBuzz(pid) {
    const p = state.players.find((x) => x.id === pid);
    const b = state.buzz;
    if (!p || !b.open || !state.current) return;
    if (b.list.some((e) => e.pid === pid)) return;
    b.list.push({ pid, name: p.name, t: Math.round(performance.now() - b.openedAt), result: '' });
    beep();
    renderHost();
    sync();
  }

  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.12;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.15);
    } catch (e) { /* ignore */ }
  }

  function currentClue() {
    const c = state.current;
    return c ? state.board.cats[c.c].clues[c.r] : null;
  }

  // What contestants are allowed to see
  function publicState() {
    const cur = state.current;
    let clue = null;
    if (cur) {
      const cl = state.board.cats[cur.c].clues[cur.r];
      clue = {
        cat: state.board.cats[cur.c].name,
        value: cl.value,
        qShown: cur.qShown,
        aShown: cur.aShown,
        q: cur.qShown ? cl.q : '',
        qImg: cur.qShown ? cl.qImg : '',
        a: cur.aShown ? cl.a : '',
        aImg: cur.aShown ? cl.aImg : '',
      };
    }
    return {
      cats: state.board.cats.map((c) => ({ name: c.name, clues: c.clues.map((x) => ({ value: x.value, used: x.used })) })),
      players: state.players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
      clue,
      buzz: { open: state.buzz.open, list: state.buzz.list.map((e) => ({ pid: e.pid, name: e.name, result: e.result })) },
    };
  }

  function sync() {
    const msg = { t: 'state', s: publicState() };
    Object.values(conns).forEach((c) => { try { if (c.open) c.send(msg); } catch (e) { /* ignore */ } });
  }

  function commit() { save(); renderHost(); sync(); }

  /* ---- host rendering ---- */
  function renderHost() {
    renderHostBoard();
    renderHostClue();
    renderBuzzList();
    renderPlayers();
    $('#editTools').classList.toggle('hidden', !$('#editToggle').checked);
  }

  function renderHostBoard() {
    const b = state.board;
    const edit = $('#editToggle').checked;
    const el = $('#hostBoard');
    el.style.gridTemplateColumns = `repeat(${b.cats.length}, minmax(0, 1fr))`;
    let h = '';
    b.cats.forEach((c, ci) => {
      h += edit
        ? `<input class="catHead catInput" data-ci="${ci}" value="${esc(c.name)}">`
        : `<div class="catHead">${esc(c.name)}</div>`;
    });
    const rows = b.cats[0].clues.length;
    for (let r = 0; r < rows; r++) {
      b.cats.forEach((c, ci) => {
        const cl = c.clues[r];
        const cur = state.current && state.current.c === ci && state.current.r === r;
        const empty = edit && !cl.q && !cl.qImg;
        h += `<button class="tile ${cl.used ? 'used' : ''} ${cur ? 'current' : ''} ${empty ? 'empty' : ''}" data-c="${ci}" data-r="${r}">${cl.used && !edit ? '' : fmt(cl.value)}</button>`;
      });
    }
    el.innerHTML = h;
  }

  function setImg(el, src) {
    if (src) { el.src = src; el.classList.remove('hidden'); } else { el.removeAttribute('src'); el.classList.add('hidden'); }
  }

  function renderHostClue() {
    const cur = state.current;
    $('#hostClueEmpty').classList.toggle('hidden', !!cur);
    $('#hostClueBody').classList.toggle('hidden', !cur);
    if (!cur) return;
    const cl = currentClue();
    $('#hcMeta').textContent = `${state.board.cats[cur.c].name} — ${fmt(cl.value)}`;
    $('#hcQ').textContent = cl.q || '(no question text)';
    $('#hcA').textContent = cl.a || '(no answer text)';
    setImg($('#hcQImg'), cl.qImg);
    setImg($('#hcAImg'), cl.aImg);
    $('#btnShowQ').textContent = cur.qShown ? 'Hide question' : 'Show question';
    $('#btnShowA').textContent = cur.aShown ? 'Hide answer' : 'Reveal answer';
    $('#btnBuzz').textContent = state.buzz.open ? 'Lock buzzers' : 'Open buzzers';
    $('#btnShowQ').classList.toggle('primary', !cur.qShown);
  }

  function renderBuzzList() {
    const list = state.buzz.list;
    const answeringIdx = list.findIndex((e) => !e.result);
    const el = $('#buzzList');
    if (!list.length) {
      el.innerHTML = `<li class="muted">${state.buzz.open ? 'Buzzers open — waiting…' : 'No buzzes yet.'}</li>`;
      return;
    }
    el.innerHTML = list.map((e, i) => `
      <li class="${i === answeringIdx ? 'first' : ''} ${e.result}">
        <span>${i + 1}.</span>
        <span class="nm">${esc(e.name)}</span>
        <span class="ms">+${e.t} ms</span>
        ${e.result ? '' : `<button data-act="right" data-pid="${esc(e.pid)}" title="Correct: add points">✓</button><button data-act="wrong" data-pid="${esc(e.pid)}" title="Wrong: subtract points">✗</button>`}
      </li>`).join('');
  }

  function renderPlayers() {
    const el = $('#playerList');
    if (!state.players.length) { el.innerHTML = '<p class="muted small">No contestants yet.</p>'; return; }
    el.innerHTML = state.players.map((p) => `
      <div class="prow">
        <span class="dot ${conns[p.id] ? 'on' : ''}" title="${conns[p.id] ? 'connected' : 'not connected'}"></span>
        <span class="pn">${esc(p.name)}</span>
        <button data-act="minus" data-pid="${esc(p.id)}">−</button>
        <input type="number" data-act="score" data-pid="${esc(p.id)}" value="${p.score}" step="100">
        <button data-act="plus" data-pid="${esc(p.id)}">+</button>
        <button data-act="remove" data-pid="${esc(p.id)}" title="Remove contestant">×</button>
      </div>`).join('');
  }

  /* ---- host actions ---- */
  const amount = () => Number($('#amount').value) || 0;

  function adjust(pid, delta) {
    const p = state.players.find((x) => x.id === pid);
    if (p) p.score += delta;
  }

  function selectClue(c, r) {
    state.current = { c, r, qShown: false, aShown: false };
    state.buzz = { open: false, openedAt: 0, list: [] };
    $('#amount').value = state.board.cats[c].clues[r].value;
    commit();
  }

  function closeClue(markUsed) {
    const cl = currentClue();
    if (cl && markUsed) cl.used = true;
    state.current = null;
    state.buzz = { open: false, openedAt: 0, list: [] };
    commit();
  }

  $('#hostBoard').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const c = +t.dataset.c, r = +t.dataset.r;
    const cl = state.board.cats[c].clues[r];
    if ($('#editToggle').checked) return openEditor(c, r);
    if (cl.used) {
      if (confirm('This clue was already used. Reopen it?')) { cl.used = false; commit(); }
      return;
    }
    selectClue(c, r);
  });

  $('#hostBoard').addEventListener('input', (e) => {
    const i = e.target.closest('.catInput');
    if (!i) return;
    state.board.cats[+i.dataset.ci].name = i.value;
    save();
    sync();
  });

  $('#btnShowQ').onclick = () => { state.current.qShown = !state.current.qShown; commit(); };
  $('#btnShowA').onclick = () => {
    state.current.aShown = !state.current.aShown;
    if (state.current.aShown) state.buzz.open = false;
    commit();
  };
  $('#btnBuzz').onclick = () => {
    state.buzz.open = !state.buzz.open;
    if (state.buzz.open) state.buzz.openedAt = performance.now();
    commit();
  };
  $('#btnReopen').onclick = () => {
    state.buzz.list = state.buzz.list.filter((e) => e.result); // keep people already judged
    state.buzz.open = true;
    state.buzz.openedAt = performance.now();
    commit();
  };
  $('#btnClearBuzz').onclick = () => { state.buzz.list = []; commit(); };
  $('#btnDone').onclick = () => closeClue(true);
  $('#btnBack').onclick = () => closeClue(false);

  $('#buzzList').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const entry = state.buzz.list.find((x) => x.pid === b.dataset.pid);
    if (!entry) return;
    const amt = amount();
    if (b.dataset.act === 'right') {
      adjust(entry.pid, amt);
      entry.result = 'right';
      state.buzz.open = false;
    } else {
      adjust(entry.pid, -amt);
      entry.result = 'wrong';
    }
    commit();
  });

  $('#playerList').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const pid = b.dataset.pid;
    if (b.dataset.act === 'plus') adjust(pid, amount());
    else if (b.dataset.act === 'minus') adjust(pid, -amount());
    else if (b.dataset.act === 'remove') {
      const p = state.players.find((x) => x.id === pid);
      if (!confirm(`Remove ${p ? p.name : 'this contestant'}?`)) return;
      if (conns[pid]) { try { conns[pid].send({ t: 'kicked' }); conns[pid].close(); } catch (er) { /* ignore */ } delete conns[pid]; }
      state.players = state.players.filter((x) => x.id !== pid);
      state.buzz.list = state.buzz.list.filter((x) => x.pid !== pid);
    }
    commit();
  });
  $('#playerList').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'score') return;
    const p = state.players.find((x) => x.id === e.target.dataset.pid);
    if (p) { p.score = Number(e.target.value) || 0; commit(); }
  });

  $('#addPlayerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#newPlayer').value.trim();
    if (!name) return;
    state.players.push({ id: 'p' + Math.random().toString(36).slice(2, 10), name: name.slice(0, 20), score: 0 });
    $('#newPlayer').value = '';
    commit();
  });

  $('#copyLink').onclick = async () => {
    const url = location.origin + location.pathname;
    try { await navigator.clipboard.writeText(url); toast('Join link copied!'); } catch (e) { prompt('Copy this link:', url); }
  };

  $('#editToggle').onchange = renderHost;
  $('#resetUsed').onclick = () => {
    if (!confirm('Mark all tiles as unused?')) return;
    state.board.cats.forEach((c) => c.clues.forEach((x) => (x.used = false)));
    commit();
  };

  /* ---- board structure editing ---- */
  $('#addCat').onclick = () => {
    const first = state.board.cats[0];
    state.board.cats.push({ name: 'New category', clues: first.clues.map((x) => blank(x.value)) });
    commit();
  };
  $('#delCat').onclick = () => {
    if (state.board.cats.length <= 1) return toast('You need at least one category.');
    if (!confirm('Remove the last category and its clues?')) return;
    state.board.cats.pop();
    if (state.current && state.current.c >= state.board.cats.length) state.current = null;
    commit();
  };
  $('#addRow').onclick = () => {
    const last = state.board.cats[0].clues;
    const v = (last.length ? last[last.length - 1].value : 0) + 200;
    state.board.cats.forEach((c) => c.clues.push(blank(v)));
    commit();
  };
  $('#delRow').onclick = () => {
    if (state.board.cats[0].clues.length <= 1) return toast('You need at least one row.');
    if (!confirm('Remove the last row of clues?')) return;
    state.board.cats.forEach((c) => c.clues.pop());
    if (state.current && state.current.r >= state.board.cats[0].clues.length) state.current = null;
    commit();
  };

  /* ---- export / import ---- */
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ board: state.board }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jeopardy-board.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const board = data.board || data;
      if (!board.cats || !board.cats.length || !board.cats.every((c) => Array.isArray(c.clues))) throw new Error('bad');
      const rows = board.cats[0].clues.length;
      board.cats.forEach((c) => {
        c.name = String(c.name || '');
        c.clues = c.clues.slice(0, rows).map((x) => ({ value: Number(x.value) || 0, q: x.q || '', a: x.a || '', qImg: x.qImg || '', aImg: x.aImg || '', used: !!x.used }));
        while (c.clues.length < rows) c.clues.push(blank(200));
      });
      state.board = board;
      state.current = null;
      state.buzz = { open: false, openedAt: 0, list: [] };
      commit();
      toast('Board imported.');
    } catch (err) {
      toast('That file is not a valid board.');
    }
  };

  /* ---- clue editor dialog ---- */
  function resizeImage(file, max = 700) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = reject;
      fr.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.round(img.width * k), h = Math.round(img.height * k);
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.75));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function refreshPreviews() {
    setImg($('#edQPrev'), editing.qImg);
    setImg($('#edAPrev'), editing.aImg);
    $('#edQRemove').classList.toggle('hidden', !editing.qImg);
    $('#edARemove').classList.toggle('hidden', !editing.aImg);
  }

  function openEditor(c, r) {
    const cl = state.board.cats[c].clues[r];
    editing = { c, r, qImg: cl.qImg, aImg: cl.aImg };
    $('#edTitle').textContent = `Edit: ${state.board.cats[c].name || 'Category'} (row ${r + 1})`;
    $('#edValue').value = cl.value;
    $('#edQ').value = cl.q;
    $('#edA').value = cl.a;
    $('#edQFile').value = '';
    $('#edAFile').value = '';
    refreshPreviews();
    $('#editDialog').showModal();
  }

  async function pickImage(inputId, key) {
    const f = $(inputId).files[0];
    if (!f) return;
    try { editing[key] = await resizeImage(f); refreshPreviews(); } catch (e) { toast('Could not read that image.'); }
  }
  $('#edQFile').onchange = () => pickImage('#edQFile', 'qImg');
  $('#edAFile').onchange = () => pickImage('#edAFile', 'aImg');
  $('#edQRemove').onclick = () => { editing.qImg = ''; $('#edQFile').value = ''; refreshPreviews(); };
  $('#edARemove').onclick = () => { editing.aImg = ''; $('#edAFile').value = ''; refreshPreviews(); };
  $('#edCancel').onclick = () => $('#editDialog').close();
  $('#edSave').onclick = () => {
    const cl = state.board.cats[editing.c].clues[editing.r];
    cl.value = Number($('#edValue').value) || 0;
    cl.q = $('#edQ').value;
    cl.a = $('#edA').value;
    cl.qImg = editing.qImg;
    cl.aImg = editing.aImg;
    $('#editDialog').close();
    commit();
  };

  /* ======================= CONTESTANT ======================= */
  let pid, myName, hostConn, pub = null, pending = false, retryTimer = null, leaving = false, joinCode;

  function setPStatus(t) { $('#pStatus').textContent = t; }

  function startPlayer(name, code) {
    if (typeof Peer === 'undefined') return ($('#joinMsg').textContent = 'Could not load PeerJS. Check your internet connection.');
    show('player');
    leaving = false;
    myName = name;
    joinCode = code;
    pid = localStorage.getItem(PID_KEY);
    if (!pid) { pid = 'p' + Math.random().toString(36).slice(2, 10); localStorage.setItem(PID_KEY, pid); }
    pub = null;
    renderPlayer();
    connectPlayer();
  }

  function scheduleRetry() {
    if (leaving || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; if (!leaving) connectPlayer(); }, 3000);
  }

  function connectPlayer() {
    setPStatus('Connecting…');
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
    peer = new Peer();
    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + joinCode, { reliable: true });
      hostConn = conn;
      conn.on('open', () => conn.send({ t: 'join', pid, name: myName }));
      conn.on('data', onPlayerData);
      conn.on('close', () => { setPStatus('Disconnected — retrying…'); scheduleRetry(); });
      conn.on('error', () => { setPStatus('Connection error — retrying…'); scheduleRetry(); });
    });
    peer.on('error', (err) => {
      setPStatus(err.type === 'peer-unavailable' ? 'Room not found — check the code (retrying…)' : 'Connection problem — retrying…');
      scheduleRetry();
    });
  }

  function onPlayerData(d) {
    if (!d) return;
    if (d.t === 'joined') {
      pid = d.pid; myName = d.name;
      localStorage.setItem(PID_KEY, pid);
      setPStatus('● Connected');
      renderPlayer();
    } else if (d.t === 'state') {
      pub = d.s;
      pending = false;
      renderPlayer();
    } else if (d.t === 'kicked') {
      leaving = true;
      alert('The host removed you from the game.');
      leave();
    }
  }

  function leave() {
    leaving = true;
    clearTimeout(retryTimer); retryTimer = null;
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
    show('landing');
  }
  $('#pLeave').onclick = leave;

  function renderPlayer() {
    $('#pName').textContent = myName || '';
    const meP = pub && pub.players.find((p) => p.id === pid);
    $('#pScore').textContent = fmt(meP ? meP.score : 0);
    if (!pub) {
      $('#pBoard').innerHTML = '<p class="muted center" style="grid-column:1/-1">Waiting for the host…</p>';
      $('#pBoard').style.gridTemplateColumns = '1fr';
      setBuzzButton();
      return;
    }
    const clue = pub.clue;
    $('#pBoard').classList.toggle('hidden', !!clue);
    $('#pClue').classList.toggle('hidden', !clue);

    // board
    const cats = pub.cats;
    const el = $('#pBoard');
    el.style.gridTemplateColumns = `repeat(${cats.length}, minmax(0, 1fr))`;
    let h = cats.map((c) => `<div class="catHead">${esc(c.name)}</div>`).join('');
    const rows = cats[0] ? cats[0].clues.length : 0;
    for (let r = 0; r < rows; r++) {
      cats.forEach((c) => {
        const cl = c.clues[r];
        h += `<div class="tile ${cl.used ? 'used' : ''}">${cl.used ? '' : fmt(cl.value)}</div>`;
      });
    }
    el.innerHTML = h;

    // clue
    if (clue) {
      $('#pcMeta').textContent = `${clue.cat} — ${fmt(clue.value)}`;
      $('#pcQ').textContent = clue.qShown ? clue.q : 'Get ready… the host will reveal the clue.';
      setImg($('#pcQImg'), clue.qShown ? clue.qImg : '');
      $('#pcAWrap').classList.toggle('hidden', !clue.aShown);
      $('#pcA').textContent = clue.a;
      setImg($('#pcAImg'), clue.aImg);
      const list = pub.buzz.list;
      $('#pBuzzOrder').textContent = list.length ? 'Buzz order: ' + list.map((e, i) => `${i + 1}. ${e.name}${e.result === 'right' ? ' ✓' : e.result === 'wrong' ? ' ✗' : ''}`).join('   ') : '';
    }

    // scoreboard
    $('#pScores').innerHTML = [...pub.players].sort((a, b) => b.score - a.score)
      .map((p) => `<div class="sc ${p.id === pid ? 'me' : ''}"><span>${esc(p.name)}</span><b>${fmt(p.score)}</b></div>`).join('');

    setBuzzButton();
  }

  function setBuzzButton() {
    const b = $('#buzzBtn');
    const buzzed = pending || (pub && pub.buzz.list.some((e) => e.pid === pid));
    const open = pub && pub.clue && pub.buzz.open;
    b.className = '';
    if (buzzed) {
      b.textContent = 'You buzzed! ✓';
      b.classList.add('done');
      b.disabled = true;
    } else if (open) {
      b.textContent = 'BUZZ!  (Space)';
      b.classList.add('ready');
      b.disabled = false;
    } else {
      b.textContent = 'Buzzers locked';
      b.disabled = true;
    }
  }

  function buzz() {
    if (!pub || !pub.clue || !pub.buzz.open || pending) return;
    if (pub.buzz.list.some((e) => e.pid === pid)) return;
    if (!hostConn || !hostConn.open) return toast('Not connected to the host.');
    pending = true;
    hostConn.send({ t: 'buzz' });
    setBuzzButton();
  }
  $('#buzzBtn').onclick = buzz;

  document.addEventListener('keydown', (e) => {
    if (mode !== 'player' || e.code !== 'Space') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    e.preventDefault();
    if (!e.repeat) buzz();
  });
})();
