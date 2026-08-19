// Graphify Viewer — picker behavior (sort/filter/calendar/theme/3D cards).
// Folded from the accepted prototype/picker artifact; runs against the
// server-rendered card grid, REPOS carries {tag,nodes,edges,added,ARTLINKS}.

const state = { sort: "nodes", dir: 1, q: "", from: null, to: null };
const ARTIFACTS = ["graph", "tree", "report"];

function render() {
  const q = state.q.toLowerCase();
  const inRange = r => !state.from || !state.to || (r.added >= state.from && r.added <= state.to);
  const rows = REPOS.filter(r =>
    (!q || r.tag.toLowerCase().includes(q) || (r.path ?? "").toLowerCase().includes(q)) && inRange(r));
  const cmp = {
    nodes: (a, b) => a.nodes - b.nodes || a.tag.localeCompare(b.tag),
    alpha: (a, b) => a.tag.localeCompare(b.tag),
    recency: (a, b) => a.added.localeCompare(b.added) || a.tag.localeCompare(b.tag),
  }[state.sort];
  rows.sort((a, b) => cmp(a, b) * state.dir);

  const grid = document.getElementById("grid");
  grid.classList.remove("has-sel");
  grid.innerHTML = rows.length ? rows.map((r, i) => {
    const links = (r.ARTLINKS ?? ARTIFACTS).map(a => `<a href="/g/${encodeURIComponent(r.tag)}/${a}">${a}</a>`).join("");
    const pct = Math.max(2, Math.round(r.nodes / MAX * 100));
    return `
    <div class="card" tabindex="0" data-tag="${r.tag}"
         style="--zbase:${(i % 4) * 3}px; --fdur:${6 + (i % 3) * 1.3}s; --fdel:${(i * .37) % 4}s; --famp:${6 + (i % 5) * 2.2}px">
      <div class="tag">${r.tag}</div>
      <div class="count${r.nodes < 1000 ? " small" : ""}">${r.nodes.toLocaleString("en")}
        <small>nodes · <span class="edges">${r.edges.toLocaleString("en")} edges</span></small></div>
      <div class="meta"><span class="path">${r.path}</span> · <span class="added">${r.added}</span></div>
      <div class="bar ${r.nodes > 1000 ? "warm" : r.nodes > 100 ? "" : "cool"}"><i style="width:${pct}%"></i></div>
      <div class="art-links">${links}</div>
    </div>`;
  }).join("") : `<div class="empty">no graphs match the current filters</div>`;
  grid.querySelectorAll(".card").forEach(card => wire(card));
}

function wire(card) {
  const MAXTILT = 6;
  card.addEventListener("pointermove", e => {
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    card.style.setProperty("--ry", ((px - .5) * 2 * MAXTILT).toFixed(2) + "deg");
    card.style.setProperty("--rx", ((.5 - py) * 2 * MAXTILT).toFixed(2) + "deg");
    card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
    card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
  });
  card.addEventListener("pointerleave", () => {
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
  });
  card.addEventListener("click", e => {
    if (e.target.closest("a")) return;
    const grid = document.getElementById("grid");
    const wasSel = card.classList.contains("selected");
    grid.querySelectorAll(".card.selected").forEach(c => c.classList.remove("selected"));
    grid.classList.add("has-sel");
    if (wasSel) return;
    card.classList.add("selected");
    card.classList.remove("shaking"); void card.offsetWidth;
    card.classList.add("shaking");
  });
}

document.addEventListener("click", e => {
  if (e.target.closest(".card") || e.target.closest(".controls")) return;
  document.getElementById("grid").classList.remove("has-sel");
  document.querySelectorAll(".card.selected").forEach(c => c.classList.remove("selected"));
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.getElementById("grid").classList.remove("has-sel");
    document.querySelectorAll(".card.selected").forEach(c => c.classList.remove("selected"));
    closeCal();
  }
});

/* calendar */
const calPop = document.getElementById("calPop");
const calBtn = document.getElementById("calBtn");
let calMonth = null, pickAnchor = null;

const datesOfVisible = () => {
  const vis = REPOS.filter(r => {
    const q = state.q.toLowerCase();
    return !q || r.tag.toLowerCase().includes(q) || (r.path ?? "").toLowerCase().includes(q);
  });
  return vis.map(r => r.added).sort();
};
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function drawCal() {
  const dates = datesOfVisible();
  const minD = dates[0] || isoOf(new Date());
  const maxD = dates[dates.length - 1] || minD;
  if (!calMonth) calMonth = minD.slice(0, 7);
  const [y, m] = calMonth.split("-").map(Number);
  document.getElementById("calMonth").textContent =
    new Date(y, m - 1, 1).toLocaleDateString("en", { month: "long", year: "numeric" });

  const has = new Set(dates);
  const startPad = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();

  let html = ["M", "T", "W", "T", "F", "S", "S"].map(d => `<span class="dow">${d}</span>`).join("");
  for (let i = 0; i < startPad; i++) html += `<span></span>`;
  for (let d = 1; d <= days; d++) {
    const iso = `${calMonth}-${String(d).padStart(2, "0")}`;
    const inSpan = iso >= minD && iso <= maxD;
    const inR = state.from && state.to && iso >= state.from && iso <= state.to;
    const edge = iso === state.from || iso === state.to;
    html += `<button data-iso="${iso}" ${inSpan ? "" : "disabled"}
      class="${edge ? "range-edge" : inR ? "in-range" : ""} ${has.has(iso) ? "has-graph" : ""}">${d}</button>`;
  }
  document.getElementById("calGrid").innerHTML = html;
  document.getElementById("calGrid").querySelectorAll("button[data-iso]").forEach(b =>
    b.addEventListener("click", () => onCalPick(b.dataset.iso)));
  document.getElementById("calLbl").textContent = state.from && state.to
    ? `${state.from} → ${state.to}` : "no range — all dates";
}

function onCalPick(iso) {
  if (!pickAnchor) { pickAnchor = iso; state.from = state.to = iso; }
  else {
    state.from = Math.min(pickAnchor, iso);
    state.to = Math.max(pickAnchor, iso);
    pickAnchor = null;
  }
  calBtn.classList.add("has-range");
  drawCal(); render();
}

function openCal() {
  calPop.hidden = false; calBtn.classList.add("open"); calBtn.setAttribute("aria-expanded", "true");
  calMonth = null; pickAnchor = null; drawCal();
}
function closeCal() {
  calPop.hidden = true; calBtn.classList.remove("open"); calBtn.setAttribute("aria-expanded", "false");
}
calBtn.addEventListener("click", e => { e.stopPropagation(); calPop.hidden ? openCal() : closeCal(); });
calPop.addEventListener("click", e => e.stopPropagation());
document.getElementById("calPrev").addEventListener("click", () => {
  const [y, m] = calMonth.split("-").map(Number);
  calMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; drawCal();
});
document.getElementById("calNext").addEventListener("click", () => {
  const [y, m] = calMonth.split("-").map(Number);
  calMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; drawCal();
});
document.getElementById("calToday").addEventListener("click", () => {
  calMonth = isoOf(new Date()).slice(0, 7); pickAnchor = null; drawCal();
});
document.getElementById("calClear").addEventListener("click", () => {
  state.from = state.to = null; pickAnchor = null;
  calBtn.classList.remove("has-range"); drawCal(); render();
});

/* theme */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.getElementById("theme").textContent = t === "mocha" ? "☀ latte" : "☾ mocha";
  try { localStorage.setItem("gv-theme", t); } catch {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem("gv-theme"); } catch {}
  if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "mocha" : "latte";
  applyTheme(t);
})();
document.getElementById("theme").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "mocha" ? "latte" : "mocha"));

/* sort + search */
const segButtons = document.querySelectorAll(".seg button[data-sort]");
function syncSortUI() {
  segButtons.forEach(b => {
    b.classList.toggle("on", b.dataset.sort === state.sort);
    b.dataset.arrow = state.dir === 1 ? "↑" : "↓";
  });
}
segButtons.forEach(b => b.addEventListener("click", () => {
  if (b.dataset.sort === state.sort) state.dir *= -1;
  else { state.sort = b.dataset.sort; state.dir = 1; }
  syncSortUI(); render();
}));
document.getElementById("q").addEventListener("input", e => {
  state.q = e.target.value; render(); if (!calPop.hidden) drawCal();
});

syncSortUI();
render();
