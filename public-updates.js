// Update selected / Update all controls with snapshot-bound confirmation.
// The access token lives in page memory only — never storage, never URLs.
(() => {
  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  if (!grid) return;
  const updStatus = $("updStatus");
  const updSelected = $("updSelected");
  const updAll = $("updAll");
  const updCancel = $("updCancel");
  const dlg = $("confirmDialog");
  const confirmSummary = $("confirmSummary");
  const confirmItems = $("confirmItems");
  const tokenInput = $("updToken");
  let activeJobId = null;
  let pollTimer = null;
  let cachedCollection = null;

  const api = {
    status: () => fetch("/api/status").then((r) => r.json()),
    snapshot: () => fetch("/api/snapshot").then((r) => r.json()),
    post: (path, payload, token) => fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    }),
    update: (payload, token) => fetch("/api/update", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    }),
  };

  function selectedTags() {
    return [...grid.querySelectorAll(".pick:checked")].map((c) => c.dataset.tag);
  }

  function refreshButtons() {
    updSelected.disabled = selectedTags().length === 0 || activeJobId !== null;
    updAll.disabled = activeJobId !== null;
  }

  function setBadge(card, status, title) {
    const badge = card.querySelector(".status-badge");
    if (!badge) return;
    const cls = { current: "ok", stale: "warn", missing: "bad", failed: "bad", unknown: "muted" }[status] ?? "muted";
    badge.className = `status-badge ${cls}`;
    badge.textContent = status;
    badge.title = title ?? "";
  }

  async function paintStatuses() {
    try {
      cachedCollection = await api.status();
      for (const item of cachedCollection.items) {
        const card = grid.querySelector(`.card[data-tag="${CSS.escape(item.item.id)}"]`);
        if (!card) continue;
        card.querySelector(".pick").disabled = !item.can_update || activeJobId !== null;
        setBadge(card, item.status, item.reason?.message ?? "");
      }
    } catch { /* read surface best-effort */ }
    refreshButtons();
  }

  function openConfirm(scope, tags) {
    if (!cachedCollection) return;
    const byId = Object.fromEntries(cachedCollection.items.map((i) => [i.item.id, i]));
    const items = scope === "all"
      ? Object.values(byId)
      : tags.map((t) => byId[t]).filter(Boolean);
    confirmSummary.textContent =
      `${scope === "all" ? "All managed graphs" : "Selected graphs"} — ${items.length} item(s) will refresh.`;
    confirmItems.innerHTML = "";
    for (const it of items) {
      const li = document.createElement("li");
      const why = it.reason?.message ? ` — ${it.reason.message}` : "";
      li.textContent = `${it.item.label} (${it.status})${why}`;
      confirmItems.appendChild(li);
    }
    dlg.returnValue = "";
    dlg.showModal();
  }

  async function startJob(scope, tags) {
    const token = tokenInput.value.trim() || sessionStorageToken.get();
    if (!token) { updStatus.textContent = "token required"; return; }
    sessionStorageToken.set(token);
    tokenInput.value = "";
    try {
      const snap = await api.snapshot();
      const res = await api.update({
        operation: "update",
        scope,
        items: tags,
        snapshot: snap.snapshot,
        confirmed: true,
      }, token);
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        activeJobId = body.job_id;
        updCancel.hidden = false;
        updStatus.textContent = `job ${body.job_id.slice(0, 8)} started`;
        pollTimer = setInterval(pollJob, 900);
        paintStatuses();
      } else if (res.status === 409 && body.snapshot) {
        updStatus.textContent = "snapshot stale — review and retry";
        paintStatuses();
      } else {
        updStatus.textContent = body.error ?? `rejected (${res.status})`;
      }
    } catch (e) {
      updStatus.textContent = "update failed to start";
    }
    refreshButtons();
  }

  async function pollJob() {
    if (!activeJobId) return;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}`);
      if (!res.ok) return;
      const job = await res.json();
      updStatus.textContent =
        `${job.state} ${job.progress.succeeded}/${job.progress.total}`;
      if (!["queued", "running"].includes(job.state)) {
        clearInterval(pollTimer);
        pollTimer = null;
        activeJobId = null;
        updCancel.hidden = true;
        paintStatuses();
      }
    } catch { /* transient */ }
  }

  const sessionStorageToken = {
    // Memory-only per contract: back onto a module variable, not storage.
    _v: null,
    get: () => sessionStorageToken._v,
    set: (v) => { sessionStorageToken._v = v; },
  };

  updSelected.addEventListener("click", () => openConfirm("selected", selectedTags()));
  updAll.addEventListener("click", () => openConfirm("all", []));
  updCancel.addEventListener("click", async () => {
    if (!activeJobId) return;
    const token = sessionStorageToken.get();
    try {
      await api.post(`/api/jobs/${encodeURIComponent(activeJobId)}/cancel`, {}, token ?? "");
    } catch { /* already gone */ }
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "confirm") {
      startJob(confirmItems.dataset.scope ?? dlg.dataset.scope ?? "selected",
        JSON.parse(dlg.dataset.tags ?? "[]"));
    }
  });

  // Stash scope/tags on the dialog at open time (simplest data path through <form method=dialog>).
  const origOpenConfirm = openConfirm;
  openConfirm = function (scope, tags) {
    dlg.dataset.scope = scope;
    dlg.dataset.tags = JSON.stringify(tags);
    origOpenConfirm(scope, tags);
  };

  grid.addEventListener("change", (e) => {
    if (e.target.classList.contains("pick")) refreshButtons();
  });
  paintStatuses();
})();
