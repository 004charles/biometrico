// Estado do Painel Administrativo
let employees = [];
let autoRefreshTimer = null;

// Estado da aba "Registos de Ponto"
let selectedDate = null;      // AAAA-MM-DD (dia em visualização)
let followToday = true;       // se estiver em "hoje", acompanha a mudança de dia à meia-noite
let currentView = "punches";  // punches | summary | absent
let liveData = { punches: [], summary: [], absent: [] };

document.addEventListener("DOMContentLoaded", async () => {
  await syncServerTime();
  updateLiveClock();
  setInterval(updateLiveClock, 1000);

  selectedDate = serverToday();
  setView("punches", false);
  refreshData();

  // Atualização em tempo real a cada 4 segundos (só quando se está a ver o dia de hoje)
  autoRefreshTimer = setInterval(() => {
    const liveTab = document.getElementById("tab-live");
    if (!liveTab || liveTab.classList.contains("hidden")) return;
    const today = serverToday();
    if (followToday && selectedDate !== today) {
      selectedDate = today;   // passou da meia-noite
    }
    if (selectedDate === today) {
      loadLiveData();
      fetchStats();
    }
  }, 4000);
});

// Hora oficial: sincronizada com o servidor (não depende do relógio do computador)
let serverOffsetMs = 0;
let serverTimeZone = "Africa/Luanda";

async function syncServerTime() {
  try {
    const t0 = Date.now();
    const res = await fetch("/api/time", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const t1 = Date.now();
    // Compensa metade do tempo de ida e volta da rede
    serverOffsetMs = data.epoch_ms - Math.round((t0 + t1) / 2);
    serverTimeZone = data.timezone || serverTimeZone;
  } catch (e) {
    console.warn("Não foi possível sincronizar a hora com o servidor:", e);
  }
}
setInterval(syncServerTime, 5 * 60 * 1000);

function serverNow() {
  return new Date(Date.now() + serverOffsetMs);
}

// Data de hoje (AAAA-MM-DD) no fuso da empresa
function serverToday() {
  return serverNow().toLocaleDateString("en-CA", { timeZone: serverTimeZone });
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 2026-11-18 -> "quarta-feira, 18/11/2026"
function formatDayLong(isoDate) {
  const d = new Date(isoDate + "T12:00:00Z");
  const weekday = d.toLocaleDateString("pt-PT", { weekday: "long", timeZone: "UTC" });
  return `${weekday}, ${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

function formatDayShort(isoDate) {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

function formatMinutes(min) {
  if (!min) return "0h00";
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

// Relógio do Header
function updateLiveClock() {
  const timeStr = serverNow().toLocaleTimeString("pt-PT", { hour12: false, timeZone: serverTimeZone });
  const clockEl = document.getElementById("live-clock");
  if (clockEl) clockEl.innerText = timeStr;
}

// Alternar Abas do Painel
function switchTab(tabId) {
  const tabs = ["tab-live", "tab-employees"];
  tabs.forEach(t => {
    const el = document.getElementById(t);
    const btn = document.getElementById("btn-" + t);
    if (!el || !btn) return;

    if (t === tabId) {
      el.classList.remove("hidden");
      btn.classList.add("active");
      btn.classList.replace("border-transparent", "border-emerald-600");
      btn.classList.replace("text-slate-500", "text-emerald-600");
      btn.classList.add("font-bold");
    } else {
      el.classList.add("hidden");
      btn.classList.remove("active");
      btn.classList.replace("border-emerald-600", "border-transparent");
      btn.classList.replace("text-emerald-600", "text-slate-500");
      btn.classList.remove("font-bold");
    }
  });

  if (tabId === "tab-employees") {
    fetchEmployees();
  }
}

// Atualizar Todos os Dados
async function refreshData() {
  const icon = document.getElementById("refresh-icon");
  if (icon) icon.classList.add("fa-spin");

  updateDateControls();
  await Promise.all([fetchStats(), loadLiveData(), fetchEmployees()]);

  if (icon) icon.classList.remove("fa-spin");
}

// ---------------------------------------------------------------- filtro de dia

function setSelectedDate(value) {
  const today = serverToday();
  if (!value) value = today;
  if (value > today) value = today;  // não há registos no futuro
  selectedDate = value;
  followToday = value === today;
  liveData = { punches: [], summary: [], absent: [] };
  renderLiveView(true);
  updateDateControls();
  fetchStats();
  loadLiveData();
}

function shiftDay(days) {
  setSelectedDate(addDays(selectedDate, days));
}

function goToday() {
  setSelectedDate(serverToday());
}

function updateDateControls() {
  const today = serverToday();
  const isToday = selectedDate === today;
  const input = document.getElementById("filter-date");
  if (input) {
    input.value = selectedDate;
    input.max = today;
  }
  const next = document.getElementById("btn-next-day");
  if (next) next.disabled = isToday;
  const todayBtn = document.getElementById("btn-today");
  if (todayBtn) todayBtn.classList.toggle("hidden", isToday);

  const title = document.getElementById("live-title");
  if (title) title.innerText = isToday ? "Registos de hoje" : `Registos de ${formatDayShort(selectedDate)}`;
  const badge = document.getElementById("live-badge");
  if (badge) badge.classList.toggle("hidden", !isToday);
  const subtitle = document.getElementById("live-subtitle");
  if (subtitle) {
    subtitle.innerText = isToday
      ? "Entradas e saídas de hoje, atualizadas automaticamente."
      : `Histórico de ${formatDayLong(selectedDate)}.`;
  }
  const kpiDay = document.getElementById("kpi-day");
  if (kpiDay) kpiDay.innerText = isToday ? "hoje" : formatDayShort(selectedDate);

  // Botão "Fechar Dia" só faz sentido para hoje
  const closeBtn = document.getElementById("btn-close-day");
  if (closeBtn) closeBtn.classList.toggle("hidden", !isToday);
}

function setView(view, render = true) {
  currentView = view;
  document.querySelectorAll(".view-btn").forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("bg-white", active);
    btn.classList.toggle("shadow-sm", active);
    btn.classList.toggle("text-slate-900", active);
    btn.classList.toggle("text-slate-500", !active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (render) renderLiveView();
}

// Buscar Estatísticas do dia selecionado (Presentes, Sem registo, Atrasados, Minutos de Atraso)
async function fetchStats() {
  const day = selectedDate;
  try {
    const res = await fetch(`/api/dashboard/stats?date=${encodeURIComponent(day)}`);
    if (!res.ok || day !== selectedDate) return;
    const data = await res.json();

    document.getElementById("stat-present").innerText = data.present_today;
    document.getElementById("stat-absent").innerText = data.absent_today;
    document.getElementById("stat-late").innerText = data.late_today;
    document.getElementById("stat-delay-minutes").innerText = `${data.total_delay_minutes} min`;
    renderSyncBanner(data);
  } catch (err) {
    console.error("Erro ao buscar estatísticas:", err);
  }
}

// Escapar texto antes de o pôr em HTML
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Aviso de batidas por enviar ao Humancore (com o botão "Reenviar agora")
let resendInProgress = false;

function renderSyncBanner(data) {
  const banner = document.getElementById("sync-banner");
  if (!banner) return;
  const pending = data.sync_pending || 0;
  const errors = data.sync_errors || 0;
  if (pending + errors === 0) {
    banner.classList.add("hidden");
    return;
  }
  const isError = errors > 0;
  banner.className = `rounded-2xl border px-4 py-3 text-sm flex flex-col sm:flex-row sm:items-center gap-3 ${
    isError ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-amber-50 border-amber-200 text-amber-800"
  }`;
  const parts = [];
  if (pending) parts.push(`${pending} à espera de envio`);
  if (errors) parts.push(`${errors} recusada(s) pelo Humancore`);
  banner.innerHTML = `
    <div class="flex items-start gap-3 flex-1 min-w-0">
      <i class="fa-solid ${isError ? "fa-triangle-exclamation" : "fa-clock"} mt-0.5"></i>
      <div class="min-w-0">
        <p class="font-bold">Batidas ainda não chegaram ao Humancore: ${parts.join(" • ")}</p>
        <p class="text-xs mt-0.5 break-words">O sistema tenta reenviar automaticamente. ${
          data.sync_last_error ? "Último erro: " + escapeHtml(data.sync_last_error) : ""
        }</p>
      </div>
    </div>
    <button onclick="syncAttendanceToHumancore()" id="btn-sync-attendance" ${resendInProgress ? "disabled" : ""}
      class="shrink-0 self-start sm:self-center bg-white hover:bg-slate-50 border ${isError ? "border-rose-300 text-rose-700" : "border-amber-300 text-amber-800"} font-bold px-3.5 py-2 rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition disabled:opacity-60">
      <i class="fa-solid fa-cloud-arrow-up ${resendInProgress ? "fa-spin" : ""}" id="icon-sync-att"></i>
      <span>${resendInProgress ? "A reenviar..." : "Reenviar agora"}</span>
    </button>`;
}

function syncBadge(r) {
  const tip = r.sync_error ? ` title="${escapeHtml(r.sync_error)} (tentativas: ${r.sync_attempts})"` : "";
  if (r.sync_status === "SENT") {
    return `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><i class="fa-solid fa-check mr-1"></i>Enviada</span>`;
  }
  if (r.sync_status === "ERROR") {
    return `<span${tip} class="cursor-help px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200"><i class="fa-solid fa-xmark mr-1"></i>Erro</span>`;
  }
  return `<span${tip} class="cursor-help px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200"><i class="fa-regular fa-clock mr-1"></i>Pendente</span>`;
}

// ---------------------------------------------------------------- dados do dia

async function loadLiveData() {
  const day = selectedDate;
  const q = `date=${encodeURIComponent(day)}`;
  try {
    const [pRes, sRes, aRes] = await Promise.all([
      fetch(`/api/attendance/records?${q}`),
      fetch(`/api/attendance/daily-summary?${q}`),
      fetch(`/api/attendance/absent?${q}`),
    ]);
    if (!pRes.ok || !sRes.ok || !aRes.ok) return;
    const [punches, summary, absent] = await Promise.all([pRes.json(), sRes.json(), aRes.json()]);
    if (day !== selectedDate) return;  // o utilizador mudou de dia entretanto
    liveData = { punches, summary: summary.rows, absent };
    renderLiveView();
  } catch (err) {
    console.error("Erro ao buscar registos de ponto:", err);
  }
}

function matchesSearch(item) {
  const term = (document.getElementById("filter-search")?.value || "").trim().toLowerCase();
  if (!term) return true;
  return [item.employee_name, item.employee_code, item.department]
    .some(v => String(v || "").toLowerCase().includes(term));
}

const LIVE_HEADERS = {
  punches: ["Colaborador", "Hora", "Tipo", "Pontualidade", "Atraso", "Dispositivo", "Status", "Humancore"],
  summary: ["Colaborador", "Previsto", "Entrada", "Saída", "Horas trabalhadas", "Atraso", "Batidas", "Situação"],
  absent: ["Colaborador", "Cargo", "Horário previsto", "Digital", "Situação"],
};

function renderLiveView(loading = false) {
  const thead = document.getElementById("live-thead");
  const tbody = document.getElementById("attendance-tbody");
  if (!thead || !tbody) return;

  const cols = LIVE_HEADERS[currentView];
  thead.innerHTML = `<tr>${cols.map(c => `<th class="py-3.5 px-5">${c}</th>`).join("")}</tr>`;

  setCount("count-punches", liveData.punches.length);
  setCount("count-summary", liveData.summary.length);
  setCount("count-absent", liveData.absent.length);

  if (loading) {
    tbody.innerHTML = emptyRow(cols.length, "fa-spinner fa-spin text-emerald-600", "A carregar...", "");
    return;
  }

  const isToday = selectedDate === serverToday();
  const searching = (document.getElementById("filter-search")?.value || "").trim() !== "";

  if (currentView === "punches") {
    const rows = liveData.punches.filter(matchesSearch);
    tbody.innerHTML = rows.length ? rows.map(renderPunchRow).join("")
      : searching ? emptyRow(cols.length, "fa-magnifying-glass", "Nenhum resultado para a pesquisa.", "")
      : emptyRow(cols.length, "fa-fingerprint",
          isToday ? "Nenhum ponto registado hoje ainda." : `Nenhum ponto registado em ${formatDayShort(selectedDate)}.`,
          isToday ? "Quando alguém picar o ponto no aplicativo, o registo aparece aqui na hora." : "");
  } else if (currentView === "summary") {
    const rows = liveData.summary.filter(matchesSearch);
    tbody.innerHTML = rows.length ? rows.map(renderSummaryRow).join("")
      : emptyRow(cols.length, searching ? "fa-magnifying-glass" : "fa-clipboard-list",
          searching ? "Nenhum resultado para a pesquisa." : "Sem presenças neste dia.", "");
  } else {
    const rows = liveData.absent.filter(matchesSearch);
    tbody.innerHTML = rows.length ? rows.map(renderAbsentRow).join("")
      : emptyRow(cols.length, searching ? "fa-magnifying-glass" : "fa-circle-check",
          searching ? "Nenhum resultado para a pesquisa." : "Todos os colaboradores registaram presença.", "");
  }
}

function setCount(id, n) {
  const el = document.getElementById(id);
  if (el) el.innerText = `(${n})`;
}

function emptyRow(colspan, icon, title, text) {
  return `
    <tr>
      <td colspan="${colspan}" class="py-12 text-center text-slate-400">
        <i class="fa-solid ${icon} text-3xl mb-3 block text-slate-300"></i>
        <p class="font-bold text-slate-700">${title}</p>
        ${text ? `<p class="text-xs text-slate-500 mt-1">${text}</p>` : ""}
      </td>
    </tr>`;
}

function employeeCell(r) {
  return `
    <td class="py-3.5 px-5">
      <div class="font-bold text-slate-900">${escapeHtml(r.employee_name)}</div>
      <div class="text-xs text-slate-500">${escapeHtml(r.employee_code)} • ${escapeHtml(r.department)}</div>
    </td>`;
}

function badge(cls, icon, text) {
  return `<span class="px-2.5 py-0.5 rounded text-[11px] font-bold border ${cls}">${icon ? `<i class="fa-solid ${icon} mr-1"></i>` : ""}${text}</span>`;
}

function renderPunchRow(r) {
  const isCheckIn = r.type === "CHECK_IN";
  const typeBadge = isCheckIn
    ? badge("bg-emerald-50 text-emerald-700 border-emerald-200", "fa-arrow-right-to-bracket", "Entrada")
    : badge("bg-teal-50 text-teal-700 border-teal-200", "fa-arrow-right-from-bracket", "Saída");
  const pontualidade = !isCheckIn
    ? `<span class="text-slate-400 text-xs">—</span>`
    : r.is_late
      ? badge("bg-amber-50 text-amber-700 border-amber-200", "fa-clock-rotate-left", "Atrasado")
      : badge("bg-emerald-50 text-emerald-700 border-emerald-200", "fa-check", "No horário");
  const atraso = r.is_late
    ? `<span class="font-bold text-amber-700 text-xs">${r.delay_minutes} min</span>`
    : `<span class="text-slate-400 text-xs">0 min</span>`;
  const status = r.status === "APPROVED"
    ? `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Aprovado</span>`
    : `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">Recusado</span>`;

  return `
    <tr class="hover:bg-slate-50 transition border-b border-slate-100">
      ${employeeCell(r)}
      <td class="py-3.5 px-5 font-mono text-sm text-slate-800 font-bold">${escapeHtml(r.timestamp.slice(11, 19))}</td>
      <td class="py-3.5 px-5">${typeBadge}</td>
      <td class="py-3.5 px-5">${pontualidade}</td>
      <td class="py-3.5 px-5">${atraso}</td>
      <td class="py-3.5 px-5 text-xs text-slate-700 font-medium">${escapeHtml(r.device_info || "App Mobile")}</td>
      <td class="py-3.5 px-5">${status}</td>
      <td class="py-3.5 px-5">${syncBadge(r)}</td>
    </tr>`;
}

const SITUATION_STYLE = {
  "Presente": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Atrasado": "bg-amber-50 text-amber-700 border-amber-200",
  "Sem saída": "bg-rose-50 text-rose-700 border-rose-200",
  "Só saída": "bg-rose-50 text-rose-700 border-rose-200",
};

function renderSummaryRow(r) {
  const isToday = selectedDate === serverToday();
  // Hoje, "Sem saída" significa apenas que a pessoa ainda está no local
  const situation = (isToday && r.situation === "Sem saída")
    ? (r.is_late ? "Atrasado" : "No local")
    : r.situation;
  const style = SITUATION_STYLE[situation] || "bg-sky-50 text-sky-700 border-sky-200";
  const worked = r.worked_minutes ? formatMinutes(r.worked_minutes) : "—";
  return `
    <tr class="hover:bg-slate-50 transition border-b border-slate-100">
      ${employeeCell(r)}
      <td class="py-3.5 px-5 font-mono text-xs text-slate-500">${escapeHtml(r.expected_start)}</td>
      <td class="py-3.5 px-5 font-mono text-sm font-bold text-slate-800">${escapeHtml(r.first_in || "—")}</td>
      <td class="py-3.5 px-5 font-mono text-sm font-bold text-slate-800">${escapeHtml(r.last_out || "—")}</td>
      <td class="py-3.5 px-5 text-sm font-semibold text-slate-700">${worked}</td>
      <td class="py-3.5 px-5">${r.delay_minutes ? `<span class="font-bold text-amber-700 text-xs">${r.delay_minutes} min</span>` : `<span class="text-slate-400 text-xs">—</span>`}</td>
      <td class="py-3.5 px-5 text-xs text-slate-600">${r.punches}</td>
      <td class="py-3.5 px-5">${badge(style, "", escapeHtml(situation))}</td>
    </tr>`;
}

function renderAbsentRow(r) {
  const finger = r.has_fingerprint
    ? badge("bg-emerald-50 text-emerald-700 border-emerald-200", "fa-fingerprint", "Cadastrada")
    : badge("bg-slate-50 text-slate-500 border-slate-200", "fa-fingerprint", "Pendente");
  return `
    <tr class="hover:bg-slate-50 transition border-b border-slate-100">
      ${employeeCell(r)}
      <td class="py-3.5 px-5 text-xs text-slate-700">${escapeHtml(r.role)}</td>
      <td class="py-3.5 px-5 font-mono text-xs text-slate-600">${escapeHtml(r.expected_start)}</td>
      <td class="py-3.5 px-5">${finger}</td>
      <td class="py-3.5 px-5">${badge("bg-rose-50 text-rose-700 border-rose-200", "", "Sem registo")}</td>
    </tr>`;
}

// Buscar Lista de Colaboradores
async function fetchEmployees() {
  try {
    const res = await fetch("/api/employees");
    if (!res.ok) return;
    employees = await res.json();
    renderEmployees(employees);
  } catch (err) {
    console.error("Erro ao buscar funcionários:", err);
  }
}

// Renderizar Quadro de Colaboradores
function renderEmployees(emps) {
  const container = document.getElementById("employees-cards-container");
  if (!container) return;

  if (emps.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-400 bg-white rounded-2xl border border-dashed border-slate-300">
        <i class="fa-solid fa-users text-4xl mb-3 block text-slate-300"></i>
        <p class="font-bold text-slate-700">Nenhum colaborador cadastrado</p>
        <p class="text-xs text-slate-500 mt-1">Cadastre os colaboradores para que possam bater ponto.</p>
        <button onclick="openEmployeeModal()" class="mt-4 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition shadow-sm">
          + Cadastrar Primeiro Colaborador
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = emps.map(emp => {
    const fingerBadge = emp.has_fingerprint
      ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><i class="fa-solid fa-fingerprint mr-1"></i>Digital Cadastrada</span>`
      : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200"><i class="fa-solid fa-fingerprint mr-1"></i>Digital Pendente</span>`;

    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-5 flex items-center justify-between shadow-sm hover:border-slate-300 transition">
        <div class="flex items-center space-x-3.5 min-w-0">
          <div class="h-12 w-12 rounded-xl ${emp.has_fingerprint ? 'bg-emerald-50 border-emerald-200 text-emerald-600' : 'bg-slate-50 border-slate-200 text-slate-400'} border flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-fingerprint text-xl"></i>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h4 class="text-sm font-bold text-slate-900 truncate">${escapeHtml(emp.name)}</h4>
              ${fingerBadge}
            </div>
            <p class="text-xs text-slate-500 mt-0.5">${escapeHtml(emp.role)} • ${escapeHtml(emp.department)}</p>
            <div class="flex items-center gap-2 mt-1.5">
              <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-100 text-slate-700 border border-slate-200">PIN: ${escapeHtml(emp.biometric_code || emp.code)}</span>
              <span class="text-[11px] text-slate-600 font-medium">Entrada: ${escapeHtml(emp.work_start_time)}</span>
            </div>
          </div>
        </div>
        <button onclick="deleteEmployee(${Number(emp.id)})" class="text-slate-400 hover:text-rose-600 p-2 rounded-lg transition" title="Excluir Colaborador">
          <i class="fa-regular fa-trash-can text-base"></i>
        </button>
      </div>
    `;
  }).join("");
}

// Sincronizar com Humancore HRMS
async function syncHumancore() {
  const btn = document.getElementById("btn-sync-humancore");
  const icon = document.getElementById("humancore-icon");
  if (btn) btn.disabled = true;
  if (icon) icon.classList.add("fa-spin");

  try {
    const res = await fetch("/api/humancore/sync", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      alert(data.message || "Colaboradores sincronizados com sucesso do Humancore!");
      refreshData();
      switchTab("tab-employees");
    } else {
      alert("Erro ao sincronizar: " + (data.detail || "Erro no servidor"));
    }
  } catch (e) {
    alert("Falha de conexão ao comunicar com o Humancore.");
  } finally {
    if (btn) btn.disabled = false;
    if (icon) icon.classList.remove("fa-spin");
  }
}

// Excluir Colaborador
async function deleteEmployee(id) {
  const emp = employees.find(e => e.id === id);
  const name = emp ? emp.name : `#${id}`;
  if (!confirm(`Deseja realmente remover o colaborador "${name}" do sistema?\n\nATENÇÃO: todo o histórico de ponto deste colaborador também será apagado.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/employees/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      refreshData();
    } else {
      alert("Erro ao excluir: " + (data.detail || "Erro desconhecido"));
    }
  } catch (e) {
    alert("Falha na conexão com o servidor.");
  }
}

// Modais
function openEmployeeModal() {
  document.getElementById("modal-employee").classList.remove("hidden");
}

function closeEmployeeModal() {
  document.getElementById("modal-employee").classList.add("hidden");
  document.getElementById("create-employee-form").reset();
}

// Submeter Cadastro de Colaborador
async function submitCreateEmployee(e) {
  e.preventDefault();
  const submitBtn = document.getElementById("btn-submit-employee");
  submitBtn.disabled = true;
  submitBtn.innerText = "Cadastrando...";

  const form = new FormData();
  form.append("code", document.getElementById("emp-code").value.trim());
  form.append("name", document.getElementById("emp-name").value.trim());
  form.append("department", document.getElementById("emp-dept").value.trim());
  form.append("role", document.getElementById("emp-role").value.trim());
  form.append("work_start_time", document.getElementById("emp-start-time").value.trim() || "08:00");
  form.append("tolerance_minutes", document.getElementById("emp-tolerance").value.trim() || "10");

  try {
    const res = await fetch("/api/employees", {
      method: "POST",
      body: form
    });
    const result = await res.json();
    if (!res.ok) {
      alert("Erro ao cadastrar: " + (result.detail || "Erro no processamento"));
      return;
    }
    closeEmployeeModal();
    refreshData();
    switchTab("tab-employees");
  } catch (err) {
    console.error("Erro:", err);
    alert("Falha de conexão com o servidor.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = "Salvar Colaborador";
  }
}

// Enviar Presenças em Lote para o Humancore
async function syncAttendanceToHumancore() {
  if (resendInProgress) return;
  resendInProgress = true;
  const btn = document.getElementById("btn-sync-attendance");
  const icon = document.getElementById("icon-sync-att");
  if (btn) btn.disabled = true;
  if (icon) icon.classList.add("fa-spin");

  try {
    const res = await fetch("/api/humancore/sync-attendance", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      alert(data.message || "Presenças enviadas ao Humancore.");
      refreshData();
    } else {
      alert("Erro ao enviar presenças: " + (data.detail || "Erro no servidor"));
    }
  } catch (e) {
    alert("Falha de conexão com o servidor.");
  } finally {
    resendInProgress = false;
    fetchStats();
  }
}

// Fecho Diário de Ausências (Lançar Faltas no Humancore)
async function closeDayHumancore() {
  if (!confirm("Deseja realizar o Fecho do Dia no Humancore? Funcionários sem ponto nem férias receberão falta automaticamente no sistema.")) {
    return;
  }

  const btn = document.getElementById("btn-close-day");
  if (btn) btn.disabled = true;

  try {
    let res = await fetch("/api/humancore/close-day", { method: "POST" });
    let data = await res.json();
    if (res.status === 409) {
      const proceed = confirm(
        (data.detail || "Há batidas de hoje por enviar ao Humancore.") +
        "\n\nDeseja fechar o dia MESMO ASSIM?"
      );
      if (!proceed) {
        refreshData();
        return;
      }
      res = await fetch("/api/humancore/close-day?force=true", { method: "POST" });
      data = await res.json();
    }
    if (res.ok) {
      alert(data.message || "Fecho diário concluído com sucesso!");
      refreshData();
    } else {
      alert("Erro no fecho diário: " + (data.detail || "Erro no servidor"));
    }
  } catch (e) {
    alert("Falha de conexão com o servidor.");
  } finally {
    if (btn) btn.disabled = false;
  }
}


// ---------------------------------------------------------------- exportação

function openExportModal() {
  const day = selectedDate || serverToday();
  document.getElementById("export-day").value = day;
  document.getElementById("export-month").value = day.slice(0, 7);
  document.getElementById("export-from").value = day.slice(0, 8) + "01";
  document.getElementById("export-to").value = day;
  ["export-day", "export-from", "export-to"].forEach(id => document.getElementById(id).max = serverToday());
  document.getElementById("export-month").max = serverToday().slice(0, 7);
  updateExportForm();
  document.getElementById("modal-export").classList.remove("hidden");
}

function closeExportModal() {
  document.getElementById("modal-export").classList.add("hidden");
}

function exportQuery() {
  const period = document.querySelector('input[name="export-period"]:checked').value;
  if (period === "day") {
    const d = document.getElementById("export-day").value;
    return d ? { query: `date=${d}` } : { error: "Escolha o dia." };
  }
  if (period === "month") {
    const m = document.getElementById("export-month").value;
    return m ? { query: `month=${m}` } : { error: "Escolha o mês." };
  }
  const from = document.getElementById("export-from").value;
  const to = document.getElementById("export-to").value;
  if (!from || !to) return { error: "Escolha a data inicial e a data final." };
  if (to < from) return { error: "A data final é anterior à data inicial." };
  return { query: `date_from=${from}&date_to=${to}` };
}

function updateExportForm() {
  const { error } = exportQuery();
  const el = document.getElementById("export-error");
  el.innerText = error || "";
  el.classList.toggle("hidden", !error);
}

function doExport(format) {
  const { query, error } = exportQuery();
  if (error) {
    updateExportForm();
    return;
  }
  // Download direto (o servidor envia o ficheiro como anexo)
  window.location.href = `/api/attendance/export/${format}?${query}`;
}
