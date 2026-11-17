// Estado do Painel Administrativo
let employees = [];
let autoRefreshTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  updateLiveClock();
  setInterval(updateLiveClock, 1000);

  refreshData();
  
  // Atualização em tempo real das presenças a cada 4 segundos
  autoRefreshTimer = setInterval(() => {
    const liveTab = document.getElementById("tab-live");
    if (liveTab && !liveTab.classList.contains("hidden")) {
      fetchAttendance();
      fetchStats();
    }
  }, 4000);
});

// Relógio do Header
function updateLiveClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("pt-BR", { hour12: false });
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

  await Promise.all([fetchStats(), fetchAttendance(), fetchEmployees()]);

  if (icon) icon.classList.remove("fa-spin");
}

// Buscar Estatísticas Principais (Presentes, Faltas, Atrasados, Minutos de Atraso)
async function fetchStats() {
  try {
    const res = await fetch("/api/dashboard/stats");
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById("stat-present").innerText = data.present_today;
    document.getElementById("stat-absent").innerText = data.absent_today;
    document.getElementById("stat-late").innerText = data.late_today;
    document.getElementById("stat-delay-minutes").innerText = `${data.total_delay_minutes} min`;
  } catch (err) {
    console.error("Erro ao buscar estatísticas:", err);
  }
}

// Buscar Presenças Registradas
async function fetchAttendance() {
  try {
    const res = await fetch("/api/attendance/records");
    if (!res.ok) return;
    const records = await res.json();
    renderAttendanceTable(records);
  } catch (err) {
    console.error("Erro ao buscar registros de ponto:", err);
  }
}

// Renderizar Tabela de Presenças
function renderAttendanceTable(records) {
  const tbody = document.getElementById("attendance-tbody");
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-12 text-center text-slate-400">
          <i class="fa-solid fa-fingerprint text-4xl mb-3 block text-slate-300"></i>
          <p class="font-bold text-slate-700">Nenhum ponto registrado hoje ainda.</p>
          <p class="text-xs text-slate-500 mt-1">Quando alguém bater ponto no aplicativo mobile, o registro aparecerá aqui na hora.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = records.map(r => {
    const isCheckIn = r.type === "CHECK_IN";
    const typeBadge = isCheckIn
      ? `<span class="px-2.5 py-0.5 rounded text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><i class="fa-solid fa-arrow-right-to-bracket mr-1"></i>Entrada</span>`
      : `<span class="px-2.5 py-0.5 rounded text-[11px] font-bold bg-teal-50 text-teal-700 border border-teal-200"><i class="fa-solid fa-arrow-right-from-bracket mr-1"></i>Saída</span>`;

    const pontualidadeBadge = r.is_late
      ? `<span class="px-2.5 py-0.5 rounded text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Atrasado</span>`
      : `<span class="px-2.5 py-0.5 rounded text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><i class="fa-solid fa-check mr-1"></i>No Horário</span>`;

    const atrasoTexto = r.is_late
      ? `<span class="font-bold text-amber-700 text-xs">${r.delay_minutes} min</span>`
      : `<span class="text-slate-400 text-xs">0 min</span>`;

    let statusBadge = "";
    if (r.status === "APPROVED") {
      statusBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Aprovado</span>`;
    } else {
      statusBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">Recusado</span>`;
    }

    return `
      <tr class="hover:bg-slate-50 transition border-b border-slate-100">
        <td class="py-3.5 px-5">
          <div class="font-bold text-slate-900">${r.employee_name}</div>
          <div class="text-xs text-slate-500">${r.employee_code} • ${r.department}</div>
        </td>
        <td class="py-3.5 px-5 font-mono text-xs text-slate-800 font-bold">${r.timestamp}</td>
        <td class="py-3.5 px-5">${typeBadge}</td>
        <td class="py-3.5 px-5">${pontualidadeBadge}</td>
        <td class="py-3.5 px-5">${atrasoTexto}</td>
        <td class="py-3.5 px-5 text-xs text-slate-700 font-medium">${r.device_info || 'App Mobile'}</td>
        <td class="py-3.5 px-5">${statusBadge}</td>
      </tr>
    `;
  }).join("");
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
              <h4 class="text-sm font-bold text-slate-900 truncate">${emp.name}</h4>
              ${fingerBadge}
            </div>
            <p class="text-xs text-slate-500 mt-0.5">${emp.role} • ${emp.department}</p>
            <div class="flex items-center gap-2 mt-1.5">
              <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-100 text-slate-700 border border-slate-200">PIN: ${emp.biometric_code || emp.code}</span>
              <span class="text-[11px] text-slate-600 font-medium">Entrada: ${emp.work_start_time}</span>
            </div>
          </div>
        </div>
        <button onclick="deleteEmployee(${emp.id}, '${emp.name}')" class="text-slate-400 hover:text-rose-600 p-2 rounded-lg transition" title="Excluir Colaborador">
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
async function deleteEmployee(id, name) {
  if (!confirm(`Deseja realmente remover o colaborador "${name}" do sistema?`)) {
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
  const btn = document.getElementById("btn-sync-attendance");
  const icon = document.getElementById("icon-sync-att");
  if (btn) btn.disabled = true;
  if (icon) icon.classList.add("fa-spin");

  try {
    const res = await fetch("/api/humancore/sync-attendance", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      alert(data.message || "Presenças enviadas com sucesso ao Humancore!");
      refreshData();
    } else {
      alert("Erro ao enviar presenças: " + (data.detail || "Erro no servidor"));
    }
  } catch (e) {
    alert("Falha de conexão com o servidor.");
  } finally {
    if (btn) btn.disabled = false;
    if (icon) icon.classList.remove("fa-spin");
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
    const res = await fetch("/api/humancore/close-day", { method: "POST" });
    const data = await res.json();
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
