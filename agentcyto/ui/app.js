/* agentcyto static UI — no build step, no secrets, no provider URLs. */
(() => {
  'use strict';

  const ADMIN_PASSWORD = 'apple'; // soft gate for teammates; real security later

  const S = {
    sessions: [], sessionId: null, mode: 'heavy', role: 'chat', model: '',
    controller: null, activeJob: null, lastRequest: null, attempt: null,
    assistantEl: null, seq: {}, statusTimer: null,
    kb: { docs: [], attached: new Set(), selectedDoc: null },
    adminUnlocked: false,
    logOpen: true,
    startTime: null,
  };

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ------------------------------------------------------------------ API

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

  // ------------------------------------------------------------------ system log

  function log(type, text, detail) {
    const box = $('log-content');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = type === 'ok' ? '✓' : type === 'err' ? '✗' : type === 'warn' ? '⚠' : '•';
    const textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = `${now()}  ${text}`;
    entry.appendChild(icon);
    entry.appendChild(textEl);
    if (detail) {
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      entry.appendChild(d);
    }
    box.appendChild(entry);
    box.scrollTop = box.scrollHeight;
    return entry;
  }

  function logClear() { $('log-content').innerHTML = ''; }

  // ------------------------------------------------------------------ messages

  function addMessage(role, text, model, meta) {
    const container = document.createElement('div');
    container.className = 'msg-wrap';
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text;
    el.appendChild(body);
    container.appendChild(el);

    if (meta) {
      const m = document.createElement('div');
      m.className = 'msg-meta';
      const parts = [];
      if (role === 'user') {
        parts.push({ label: 'You' });
      } else {
        if (model) parts.push({ label: 'answered by', value: `<b>${model}</b>` });
        if (meta.attempt != null) parts.push({ label: 'attempt', value: meta.attempt });
        if (meta.kbCount != null) parts.push({ label: 'KB repos', value: meta.kbCount });
        if (meta.durationMs != null) parts.push({ label: 'duration', value: `${meta.durationMs}ms` });
      }
      parts.push({ label: now() });
      parts.forEach((p, i) => {
        if (i > 0) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          m.appendChild(dot);
        }
        const span = document.createElement('span');
        span.innerHTML = p.value || p.label;
        m.appendChild(span);
      }
      );
      container.appendChild(m);
    }

    $('messages').appendChild(container);
    $('messages').scrollTop = $('messages').scrollHeight;
    return { container, el, body };
  }

  function setEmpty(show) {
    const empty = $('messages').querySelector('.empty');
    if (show) {
      if (!empty) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = 'Start a conversation.';
        $('messages').appendChild(e);
      }
    } else if (empty) empty.remove();
  }

  // ------------------------------------------------------------------ sessions & modes

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
    setEmpty(full.messages.length === 0);
    for (const m of full.messages) {
      addMessage(m.role, m.content, m.model, m.meta || null);
    }
    updateControls();
    await loadSessions();
    const active = full.jobs.find((j) => ['queued', 'running', 'partial'].includes(j.status));
    if (active) resumeJob(active.id, S.seq[active.id] || 0);
    updateChatTitle();
    updateAttachedKBUI();
  }

  async function loadModes() {
    const cfg = await api('modes');
    const modeSel = $('mode');
    modeSel.innerHTML = '';
    for (const [key, value] of Object.entries(cfg.modes || {})) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = (value.label || key) + (value.description ? ` — ${value.description}` : '');
      modeSel.appendChild(opt);
    }
    modeSel.value = S.mode in (cfg.modes || {}) ? S.mode : (cfg.default_mode || 'heavy');
    S.mode = modeSel.value;

    const modelSel = $('model');
    modelSel.innerHTML = '<option value="">auto (mode default)</option>';
    const allowed = S.role === 'agent' ? (cfg.agent_models || []) : (cfg.chat_models || []);
    for (const name of allowed) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSel.appendChild(opt);
    }
    modelSel.value = '';
    S.model = '';

    $('st-modes').textContent = Object.keys(cfg.modes || {}).join(', ') || '—';
    return cfg;
  }

  function updateControls() {
    const badge = null;
    const roleSel = $('role');
    roleSel.value = S.role;
    const isAgent = S.role === 'agent';
    $('model').disabled = !isAgent;
  }

  function updateChatTitle() {
    $('chat-title').textContent = S.sessionId ? `Session ${S.sessionId.slice(0, 12)}` : 'New conversation';
  }

  // ------------------------------------------------------------------ KB attach / detach

  async function loadKBDocs() {
    try {
      S.kb.docs = await api('kb/documents');
      renderKBAttach();
    } catch (err) {
      // KB may be empty / not ingested — that's fine, just hide the panel content
      S.kb.docs = [];
      renderKBAttach();
    }
  }

  function renderKBAttach() {
    const list = $('kb-repo-list');
    const empty = $('kb-empty');
    list.innerHTML = '';
    if (!S.kb.docs || !S.kb.docs.length) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }
    list.hidden = false;
    empty.hidden = true;
    for (const d of S.kb.docs) {
      const attached = S.kb.attached.has(d.id);
      const item = document.createElement('div');
      item.className = `kb-repo-item ${attached ? 'attached' : ''}`;
      item.title = `${d.file_name} · ${d.id}`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = d.title || d.file_name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `${d.node_count || 0} nodes · ${d.equation_count || 0} eqns`;
      const toggle = document.createElement('button');
      toggle.className = 'kb-toggle';
      toggle.title = attached ? 'Detach' : 'Attach';
      toggle.onclick = (e) => { e.stopPropagation(); toggleKB(d.id); };
      item.appendChild(name);
      item.appendChild(tag);
      item.appendChild(toggle);
      item.onclick = () => toggleKB(d.id);
      list.appendChild(item);
    }
    updateAttachedKBUI();
  }

  function toggleKB(docId) {
    if (S.kb.attached.has(docId)) S.kb.attached.delete(docId);
    else S.kb.attached.add(docId);
    renderKBAttach();
    const d = S.kb.docs.find((x) => x.id === docId);
    log('info', attachedState(docId) ? 'Attached KB repo' : 'Detached KB repo', d ? (d.title || d.file_name) : docId);
  }

  function attachedState(docId) { return S.kb.attached.has(docId); }

  function updateAttachedKBUI() {
    const box = $('attached-kb');
    box.innerHTML = '';
    for (const id of S.kb.attached) {
      const d = S.kb.docs.find((x) => x.id === id);
      if (!d) continue;
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.title = d.file_name;
      chip.textContent = d.title || d.file_name;
      const detach = document.createElement('button');
      detach.className = 'detach';
      detach.title = 'Detach';
      detach.textContent = '✕';
      detach.onclick = (e) => { e.stopPropagation(); toggleKB(id); };
      chip.appendChild(detach);
      box.appendChild(chip);
    }
  }

  // ------------------------------------------------------------------ send / stream

  async function send(event) {
    event.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    S.startTime = Date.now();
    const body = {
      message: text,
      mode: S.mode,
      role: S.role,
      kb_docs: Array.from(S.kb.attached),
    };
    if (S.sessionId) body.session_id = S.sessionId;
    if (S.model) body.model = S.model;
    S.lastRequest = { ...body };
    $('input').value = '';
    textareaAutosize();
    setEmpty(false);
    addMessage('user', text);
    log('info', 'Message queued', `mode: ${S.mode} · role: ${S.role}` + (S.kb.attached.size ? ` · KB: ${S.kb.attached.size} repo(s)` : ''));
    $('stop').hidden = false;
    try {
      const job = await api('chat', { method: 'POST', body: JSON.stringify(body) });
      S.sessionId = job.session_id;
      updateControls();
      await loadSessions();
      updateChatTitle();
      S.seq[job.job_id] = 0;
      log('info', 'Job started', `job ${job.job_id.slice(0, 8)}`);
      resumeJob(job.job_id, 0);
    } catch (err) {
      log('err', 'Send failed', err.message);
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
          S.assistantEl.el.querySelector('.msg-meta')?.remove();
        } else {
          S.assistantEl = addMessage('assistant', '', '');
        }
        log('info', 'Streaming', `attempt ${payload.attempt}`);
      }
      if (!S.assistantEl) S.assistantEl = addMessage('assistant', '', '');
      S.assistantEl.body.textContent += payload.text || '';
      $('messages').scrollTop = $('messages').scrollHeight;
      log('info', 'Streaming…', (payload.text || '').slice(0, 120));
    } else if (event === 'status') {
      log('info', payload.detail === 'retrying' ? 'Partial — retrying' : payload.status || '', `attempt ${payload.attempt}`);
    } else if (event === 'done') {
      const duration = S.startTime ? Date.now() - S.startTime : null;
      if (S.assistantEl && !S.assistantEl.body.textContent) {
        S.assistantEl.body.textContent = payload.text || '';
      }
      if (S.assistantEl) {
        const meta = {
          model: payload.model || 'unknown',
          attempt: payload.attempt,
          kbCount: S.kb.attached.size,
          durationMs: duration,
        };
        const m = document.createElement('div');
        m.className = 'msg-meta';
        const parts = [
          { label: 'answered by', value: `<b>${meta.model}</b>` },
          { label: 'attempt', value: meta.attempt },
          { label: 'KB repos', value: meta.kbCount },
          { label: 'duration', value: `${meta.durationMs}ms` },
          { label: now() },
        ];
        parts.forEach((p, i) => {
          if (i > 0) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            m.appendChild(dot);
          }
          const span = document.createElement('span');
          span.innerHTML = p.value || p.label;
          m.appendChild(span);
        });
        S.assistantEl.el.appendChild(m);
      }
      log('ok', 'Complete', `answered by ${payload.model || 'unknown'}` + (duration ? ` · ${duration}ms` : ''));
      $('stop').hidden = true;
      S.assistantEl = null;
      S.attempt = null;
      S.startTime = null;
    } else if (event === 'job_error') {
      log('err', 'Job error', payload.error || 'unknown error');
      $('stop').hidden = true;
      S.assistantEl = null;
      S.attempt = null;
      S.startTime = null;
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
        log('err', 'Stream interrupted', err.message);
      }
      let job;
      try { job = await api(`jobs/${jobId}`); } catch (_) { return; }
      if (['done', 'blocked', 'cancelled'].includes(job.status)) {
        if (job.status === 'blocked') log('err', 'Blocked', job.error || '');
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
    log('warn', 'Stopped by user');
    $('stop').hidden = true;
    $('retry').hidden = false;
    S.assistantEl = null;
    S.attempt = null;
    S.startTime = null;
  }

  async function statusTick() {
    try {
      const [health, usage] = await Promise.all([api('health'), api('usage')]);
      $('st-gateway').textContent = health.gateway === 'ok' ? 'ok' : 'down';
      $('st-gateway').className = `value ${health.gateway === 'ok' ? 'ok' : 'err'}`;
      $('st-liveliness').textContent = health.status;
      const pct = usage.budget_usd ? Math.min(100, usage.spent_usd / usage.budget_usd * 100) : 0;
      $('st-spent').textContent = `$${usage.spent_usd.toFixed(4)}`;
      $('st-budget').textContent = `$${usage.budget_usd.toFixed(2)}`;
      $('st-bar').style.width = `${pct}%`;
    } catch (_) { /* leave last known values */ }
  }

  function textareaAutosize() {
    const ta = $('input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
  }

  // ------------------------------------------------------------------ admin (KB) — soft password gate

  function adminUnlock() {
    S.adminUnlocked = true;
    $('admin-gate').hidden = true;
    $('admin-content').hidden = false;
    $('admin-content').classList.add('visible');
    adminLoadStatus();
    adminLoadDocuments();
  }

  function adminLock() {
    S.adminUnlocked = false;
    $('admin-gate').hidden = false;
    $('admin-content').hidden = true;
    $('admin-content').classList.remove('visible');
    $('admin-pass').value = '';
    $('admin-hint').textContent = '';
  }

  async function adminLoadStatus() {
    try {
      const st = await api('kb/status');
      $('ad-src-files').textContent = st.source_files ?? '—';
      $('ad-doc-count').textContent = st.documents ?? '—';
      $('ad-node-count').textContent = st.total_nodes ?? '—';
      $('ad-eqn-count').textContent = st.total_equations ?? '—';
      $('ad-sym-count').textContent = st.total_symbols ?? '—';
      const latest = st.latest_ingestion;
      if (latest) {
        $('ad-latest').innerHTML = `Last: <b>${latest.status}</b> · ${latest.files_ingested ?? 0} ingested, ${latest.files_skipped ?? 0} skipped, ${latest.nodes_created ?? 0} nodes · ${new Date((latest.started_at || 0) * 1000).toLocaleString()}`;
      } else {
        $('ad-latest').textContent = 'No ingestion has run yet.';
      }
    } catch (err) {
      $('ad-status').textContent = `status error: ${err.message}`;
    }
  }

  async function adminLoadDocuments() {
    try {
      const docs = await api('kb/documents');
      const list = $('ad-doc-list');
      list.innerHTML = '';
      if (!docs.length) {
        list.innerHTML = '<div style="padding:12px 20px;color:var(--text-secondary);">No documents ingested yet.</div>';
        return;
      }
      for (const d of docs) {
        const item = document.createElement('div');
        item.className = 'admin-doc-item';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = d.title || d.file_name;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = `${d.node_count || 0} nodes · ${d.equation_count || 0} eqns · ${d.status}`;
        item.appendChild(name);
        item.appendChild(meta);
        list.appendChild(item);
      }
    } catch (err) {
      $('ad-doc-list').innerHTML = `<div style="padding:12px 20px;color:var(--danger);">error: ${err.message}</div>`;
    }
  }

  async function adminRun(endpoint, method, label) {
    $('ad-status').textContent = `${label} running…`;
    try {
      const res = await api(endpoint, { method });
      $('ad-status').innerHTML = `<span style="color:var(--success);">✓ ${label} done.</span> ${JSON.stringify(res)}`;
      await adminLoadStatus();
      await adminLoadDocuments();
      loadKBDocs(); // refresh attach panel if unlocked
    } catch (err) {
      $('ad-status').innerHTML = `<span style="color:var(--danger);">✗ ${label} failed:</span> ${err.message}`;
      throw err;
    }
  }

  async function adminSearch() {
    const q = $('ad-search-q').value.trim();
    const type = $('ad-search-type').value;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (type) params.set('type', type);
    params.set('limit', '50');
    try {
      const data = await api(`kb/search?${params.toString()}`);
      const res = $('ad-results');
      res.innerHTML = '';
      if (!data.results || !data.results.length) {
        res.innerHTML = '<div style="padding:8px 14px;color:var(--text-secondary);">No results.</div>';
        return;
      }
      for (const r of data.results) {
        const item = document.createElement('div');
        item.className = 'admin-result';
        const head = document.createElement('div');
        head.className = 'head';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = `${r.type} — ${r.title || '(untitled)'}`;
        if (r.label) {
          const lb = document.createElement('span');
          lb.style.color = 'var(--text-tertiary)';
          lb.style.fontSize = '10px';
          lb.textContent = ` [${r.label}]`;
          name.appendChild(lb);
        }
        const loc = document.createElement('div');
        loc.className = 'loc';
        loc.textContent = `${r.document_name || ''} · lines ${r.line_start}-${r.line_end}`;
        head.appendChild(name);
        head.appendChild(loc);
        item.appendChild(head);
        const preview = document.createElement('div');
        preview.className = 'preview';
        preview.textContent = (r.content || '').slice(0, 400);
        item.appendChild(preview);
        res.appendChild(item);
      }
    } catch (err) {
      $('ad-results').innerHTML = `<div style="padding:8px 14px;color:var(--danger);">error: ${err.message}</div>`;
    }
  }

  // ------------------------------------------------------------------ wiring

  function wire() {
    // nav
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.onclick = () => {
        document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.view').forEach((v) => v.hidden = true);
        const view = $(`view-${item.dataset.view}`);
        view.hidden = false;
        if (item.dataset.view === 'status') statusTick();
        if (item.dataset.view === 'chat') { loadSessions(); loadKBDocs(); }
      };
    });
    $('btn-new-chat').onclick = async () => {
      const s = await api('sessions', { method: 'POST', body: JSON.stringify({ name: '' }) });
      await loadSessions();
      await selectSession(s.id);
    };

    // chat
    $('new-session').onclick = $('btn-new-chat').onclick;
    $('role').onchange = async (e) => {
      S.role = e.target.value;
      await loadModes();
      updateControls();
    };
    $('mode').onchange = (e) => { S.mode = e.target.value; };
    $('model').onchange = (e) => { S.model = e.target.value; };

    $('composer').onsubmit = send;
    $('input').oninput = textareaAutosize;
    $('input').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
    };
    $('stop').onclick = stop;
    $('retry').onclick = async () => {
      if (!S.lastRequest) return;
      $('retry').hidden = true;
      const body = { ...S.lastRequest };
      $('input').value = body.message;
      S.lastRequest = body;
      const fake = { preventDefault() {}, target: null };
      await send(fake);
    };

    // log drawer toggle
    let logDragging = false;
    $('log-drawer-header').onclick = () => {
      S.logOpen = !S.logOpen;
      $('log-drawer').classList.toggle('collapsed', !S.logOpen);
      $('log-chevron').textContent = S.logOpen ? '▾' : '▸';
    };

    // admin
    $('admin-login').onsubmit = (e) => {
      e.preventDefault();
      if ($('admin-pass').value === ADMIN_PASSWORD) adminUnlock();
      else {
        $('admin-hint').textContent = 'Incorrect password.';
        $('admin-pass').value = '';
      }
    };
    $('ad-ingest').onclick = async () => {
      if (!confirm('Ingest all Markdown files from the knowledge base source directory?')) return;
      await adminRun('kb/ingest', 'POST', 'Ingest');
    };
    $('ad-reindex').onclick = async () => {
      if (!confirm('Rebuild the entire knowledge base from scratch? All existing KB data will be wiped.')) return;
      await adminRun('kb/reindex', 'POST', 'Rebuild');
    };
    $('ad-clear').onclick = async () => {
      if (!confirm('Delete ALL knowledge base data? This cannot be undone.')) return;
      await adminRun('kb/clear', 'DELETE', 'Clear');
    };
    $('ad-search-btn').onclick = adminSearch;
    $('ad-search-q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); adminSearch(); } };

    // initial
    statusTick();
    S.statusTimer = setInterval(statusTick, 15000);
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
      log('err', 'Startup error', err.message);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
