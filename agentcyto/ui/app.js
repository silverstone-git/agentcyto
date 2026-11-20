/* agentcyto static UI — no build step, no secrets, no provider URLs. */
(() => {
  'use strict';

  const S = {
    sessions: [], sessionId: null, mode: 'heavy', role: 'chat', model: '',
    controller: null, activeJob: null, lastRequest: null, attempt: null,
    assistantEl: null, seq: {}, statusTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, options = {}) {
    const res = await fetch(`api/${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (_) { /* keep */ }
      throw new Error(detail);
    }
    return res.json();
  }

  function addMessage(role, text, model) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = role === 'assistant' && model ? `answered by ${model}` : role;
    const body = document.createElement('div');
    body.textContent = text;
    el.append(meta, body);
    $('messages').appendChild(el);
    $('messages').scrollTop = $('messages').scrollHeight;
    return { el, body, meta };
  }

  function setStatus(text) {
    const box = $('job-status');
    box.hidden = !text;
    box.textContent = text || '';
  }

  function updateWorkspaceBadge() {
    const badge = $('workspace-badge');
    badge.hidden = S.role !== 'agent' || !S.sessionId;
    badge.textContent = S.role === 'agent'
      ? `workspace: ${S.sessionId} (files live here)` : '';
  }

  async function loadSessions() {
    S.sessions = await api('sessions');
    const list = $('session-list');
    list.innerHTML = '';
    for (const s of S.sessions) {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === S.sessionId ? ' active' : '');
      item.textContent = s.name || s.id.slice(0, 12);
      item.title = `${s.name || '(untitled)'} · ${s.id}`;
      item.onclick = () => selectSession(s.id);
      list.appendChild(item);
    }
  }

  async function selectSession(id) {
    S.sessionId = id;
    const full = await api(`sessions/${id}`);
    $('messages').innerHTML = '';
    for (const m of full.messages) addMessage(m.role, m.content, m.model);
    updateWorkspaceBadge();
    await loadSessions();
    const active = full.jobs.find((j) => ['queued', 'running', 'partial'].includes(j.status));
    if (active) resumeJob(active.id, S.seq[active.id] || 0);
  }

  async function loadModes() {
    const cfg = await api('modes');
    const modeSel = $('mode');
    modeSel.innerHTML = '';
    for (const [key, value] of Object.entries(cfg.modes || {})) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = value.label || key;
      modeSel.appendChild(opt);
    }
    modeSel.value = S.mode in (cfg.modes || {}) ? S.mode : (cfg.default_mode || 'heavy');
    S.mode = modeSel.value;

    const modelSel = $('model');
    modelSel.innerHTML = '<option value="">auto (mode default)</option>';
    const allowed = S.role === 'agent' ? cfg.agent_models : cfg.chat_models;
    for (const name of allowed || []) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSel.appendChild(opt);
    }
    modelSel.value = '';
    S.model = '';

    $('mode-info').innerHTML = Object.entries(cfg.modes || {}).map(([key, v]) =>
      `<div><b>${key}</b> → chat ${v.chat} / agent ${v.agent}<br>${v.description || ''}</div>`
    ).join('');
    return cfg;
  }

  async function send(event) {
    event.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    const body = { message: text, mode: S.mode, role: S.role };
    if (S.sessionId) body.session_id = S.sessionId;
    if (S.model) body.model = S.model;
    S.lastRequest = { ...body };
    $('input').value = '';
    addMessage('user', text);
    setStatus('queued…');
    $('stop').hidden = false;
    try {
      const job = await api('chat', { method: 'POST', body: JSON.stringify(body) });
      S.sessionId = job.session_id;
      updateWorkspaceBadge();
      await loadSessions();
      S.seq[job.job_id] = 0;
      resumeJob(job.job_id, 0);
    } catch (err) {
      setStatus(`error: ${err.message}`);
      $('stop').hidden = true;
    }
  }

  function parseBlock(block, jobId) {
    let event = 'message';
    let data = '';
    let id = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
    }
    if (id) {
      S.seq[jobId] = Number(id);
      localStorage.setItem(`agentcyto.seq.${jobId}`, id);
    }
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch (_) { return; }

    if (event === 'delta') {
      if (S.attempt !== payload.attempt) {
        S.attempt = payload.attempt;
        if (S.assistantEl) {
          S.assistantEl.body.textContent = '';
          S.assistantEl.meta.textContent = 'answered by …';
        } else {
          S.assistantEl = addMessage('assistant', '', '');
        }
      }
      if (!S.assistantEl) S.assistantEl = addMessage('assistant', '', '');
      S.assistantEl.body.textContent += payload.text || '';
      $('messages').scrollTop = $('messages').scrollHeight;
      setStatus('streaming…');
    } else if (event === 'status') {
      setStatus(payload.detail === 'retrying'
        ? `partial — retrying (attempt ${payload.attempt})`
        : payload.status || '');
    } else if (event === 'done') {
      if (S.assistantEl && !S.assistantEl.body.textContent) {
        S.assistantEl.body.textContent = payload.text || '';
      }
      if (S.assistantEl) S.assistantEl.meta.textContent = `answered by ${payload.model || 'unknown'}`;
      setStatus('');
      $('stop').hidden = true;
    } else if (event === 'job_error') {
      setStatus(`blocked: ${payload.error || 'unknown error'}`);
      $('stop').hidden = true;
    }
  }

  async function resumeJob(jobId, after) {
    if (S.controller) S.controller.abort();
    const saved = Number(localStorage.getItem(`agentcyto.seq.${jobId}`) || 0);
    let cursor = Math.max(Number(after) || 0, saved);
    S.activeJob = jobId;
    S.attempt = null;
    S.assistantEl = null;
    const controller = new AbortController();
    S.controller = controller;
    $('stop').hidden = false;

    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`api/stream?job_id=${encodeURIComponent(jobId)}&after=${cursor}`,
          { signal: controller.signal });
        if (!res.ok) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            parseBlock(block, jobId);
            cursor = Math.max(cursor, S.seq[jobId] || 0);
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
      }
      let job;
      try { job = await api(`jobs/${jobId}`); } catch (_) { return; }
      if (['done', 'blocked', 'cancelled'].includes(job.status)) {
        setStatus(job.status === 'blocked' ? `blocked: ${job.error || ''}` : '');
        $('stop').hidden = true;
        $('retry').hidden = false;
        await loadSessions();
        return;
      }
      await sleep(1000);
    }
  }

  async function stop() {
    if (S.controller) S.controller.abort();
    if (S.activeJob) {
      try { await api(`jobs/${S.activeJob}/cancel`, { method: 'POST' }); } catch (_) { /* gone */ }
    }
    setStatus('stopped');
    $('stop').hidden = true;
    $('retry').hidden = false;
  }

  async function statusTick() {
    try {
      const [health, usage] = await Promise.all([api('health'), api('usage')]);
      $('health').innerHTML = `<div>status <b>${health.status}</b></div><div>gateway <b>${health.gateway}</b></div>`;
      const pct = usage.budget_usd ? Math.min(100, usage.spent_usd / usage.budget_usd * 100) : 0;
      $('usage').innerHTML = `<div>spent <b>$${usage.spent_usd.toFixed(4)}</b></div>` +
        `<div>budget <b>$${usage.budget_usd.toFixed(2)}</b></div>`;
      $('usage-bar').style.width = `${pct}%`;
    } catch (_) { /* leave last known values */ }
  }

  function wire() {
    $('tab-chat').onclick = () => {
      $('view-chat').hidden = false; $('view-status').hidden = true;
      $('tab-chat').classList.add('active'); $('tab-status').classList.remove('active');
    };
    $('tab-status').onclick = () => {
      $('view-chat').hidden = true; $('view-status').hidden = false;
      $('tab-status').classList.add('active'); $('tab-chat').classList.remove('active');
      statusTick();
    };
    $('new-session').onclick = async () => {
      const s = await api('sessions', { method: 'POST', body: JSON.stringify({ name: '' }) });
      await loadSessions();
      await selectSession(s.id);
    };
    $('rename-session').onclick = async () => {
      if (!S.sessionId) return;
      const s = S.sessions.find((x) => x.id === S.sessionId);
      const name = prompt('Session name', s?.name || '');
      if (name === null) return;
      await api(`sessions/${S.sessionId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      await loadSessions();
    };
    $('clear-session').onclick = async () => {
      if (!S.sessionId || !confirm('Clear this session and its files?')) return;
      await api(`sessions/${S.sessionId}`, { method: 'DELETE' });
      S.sessionId = null;
      await loadSessions();
      $('messages').innerHTML = '<div class="empty">Start a conversation.</div>';
      updateWorkspaceBadge();
    };
    $('mode').onchange = (e) => { S.mode = e.target.value; };
    $('role').onchange = async (e) => {
      S.role = e.target.value;
      await loadModes();
      updateWorkspaceBadge();
    };
    $('model').onchange = (e) => { S.model = e.target.value; };
    $('composer').onsubmit = send;
    $('stop').onclick = stop;
    $('retry').onclick = async () => {
      if (!S.lastRequest) return;
      $('retry').hidden = true;
      const fake = { preventDefault() {}, target: null };
      const body = { ...S.lastRequest };
      $('input').value = body.message;
      S.lastRequest = body;
      await send(fake);
    };
    $('input').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
    };
  }

  async function init() {
    wire();
    try {
      await loadModes();
      await loadSessions();
      if (S.sessions.length) await selectSession(S.sessions[0].id);
      const jobParam = new URLSearchParams(location.search).get('job');
      if (jobParam) resumeJob(jobParam, Number(localStorage.getItem(`agentcyto.seq.${jobParam}`) || 0));
    } catch (err) {
      setStatus(`startup error: ${err.message}`);
    }
    statusTick();
    S.statusTimer = setInterval(statusTick, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
