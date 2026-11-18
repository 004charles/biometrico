// Estado do Terminal de Digital
let employees = [];
let isScanning = false;

document.addEventListener("DOMContentLoaded", () => {
  initClock();
  fetchEmployees();
});

// Hora oficial: sincronizada com o servidor (não depende do relógio do tablet)
let serverOffsetMs = 0;
let serverTimeZone = "Africa/Luanda";

async function syncServerTime() {
  try {
    const t0 = Date.now();
    const res = await fetch("/api/time", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const t1 = Date.now();
    serverOffsetMs = data.epoch_ms - Math.round((t0 + t1) / 2);
    serverTimeZone = data.timezone || serverTimeZone;
  } catch (e) {
    console.warn("Não foi possível sincronizar a hora com o servidor:", e);
  }
}

// Relógio do Terminal
function initClock() {
  const clockEl = document.getElementById("totem-clock");
  const dateEl = document.getElementById("totem-date");

  syncServerTime();
  setInterval(syncServerTime, 5 * 60 * 1000);

  function update() {
    const now = new Date(Date.now() + serverOffsetMs);
    if (clockEl) {
      clockEl.innerText = now.toLocaleTimeString("pt-PT", { hour12: false, timeZone: serverTimeZone });
    }
    if (dateEl) {
      dateEl.innerText = now.toLocaleDateString("pt-PT", {
        timeZone: serverTimeZone,
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric"
      });
    }
  }

  update();
  setInterval(update, 1000);
}

// Carregar Lista de Colaboradores
async function fetchEmployees() {
  try {
    const res = await fetch("/api/employees");
    if (!res.ok) return;
    employees = await res.json();

    const select = document.getElementById("employee-select");
    if (!select) return;

    if (employees.length === 0) {
      select.innerHTML = `<option value="">Nenhum colaborador cadastrado (cadastre no painel)</option>`;
      return;
    }

    select.innerHTML = `<option value="">-- Toque para selecionar o seu nome --</option>` +
      employees.map(e => `<option value="${e.code}">${e.name} (${e.code} - ${e.department})</option>`).join("");
  } catch (err) {
    console.error("Erro ao carregar colaboradores:", err);
  }
}

// Ação de Picar o Dedo (Scanner Biométrico)
async function triggerFingerprintScan() {
  if (isScanning) return;

  const empCode = document.getElementById("employee-select").value;
  if (!empCode) {
    alert("Por favor, selecione o colaborador na lista.");
    return;
  }

  const recordType = document.querySelector('input[name="punch_type"]:checked').value;
  const fingerCircle = document.getElementById("finger-circle");
  const fingerIcon = document.getElementById("finger-icon");
  const fingerHint = document.getElementById("finger-hint");
  const btnPunch = document.getElementById("btn-punch");

  isScanning = true;
  btnPunch.disabled = true;

  // Animação de leitura da digital (Luz azul/verde do scanner)
  fingerCircle.className = "relative h-44 w-44 rounded-full bg-slate-950 border-4 border-cyan-400 flex flex-col items-center justify-center shadow-2xl shadow-cyan-500/50 scale-105 transition-all duration-300";
  fingerIcon.className = "fa-solid fa-fingerprint text-6xl text-cyan-400 animate-pulse";
  fingerHint.innerText = "Lendo Digital...";
  fingerHint.className = "text-[11px] font-bold text-cyan-400 uppercase tracking-widest mt-2";

  // Simula o tempo de leitura do sensor físico óptico (400ms)
  await new Promise(r => setTimeout(r, 400));

  const form = new FormData();
  form.append("employee_code", empCode);
  form.append("record_type", recordType);
  form.append("fingerprint_verified", "true");
  form.append("device_info", "Tablet Fixo (Leitor Biométrico)");

  try {
    const res = await fetch("/api/attendance/punch", {
      method: "POST",
      body: form
    });
    const data = await res.json();

    if (data.success) {
      // Sucesso na leitura da digital
      playSuccessChime();
      fingerCircle.className = "relative h-44 w-44 rounded-full bg-emerald-950/60 border-4 border-emerald-400 flex flex-col items-center justify-center shadow-2xl shadow-emerald-500/60 scale-105 transition-all duration-300";
      fingerIcon.className = "fa-solid fa-check text-6xl text-emerald-400";
      fingerHint.innerText = "Digital Aprovada!";
      fingerHint.className = "text-[11px] font-bold text-emerald-400 uppercase tracking-widest mt-2";

      const typeLabel = recordType === "CHECK_IN" ? "Entrada" : "Saída";
      showFeedbackModal({
        type: typeLabel.toUpperCase(),
        badgeClass: recordType === "CHECK_IN" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-teal-500/20 text-teal-300 border border-teal-500/30",
        iconClass: "bg-emerald-500/20 text-emerald-400 border-2 border-emerald-500",
        icon: "fa-solid fa-fingerprint",
        name: data.employee_name,
        dept: "Biometria Digital Confirmada",
        time: data.timestamp,
        msg: `Presença de ${typeLabel} confirmada com sucesso!`
      });

      speakText(`Olá ${data.employee_name.split(" ")[0]}, ${typeLabel} registrada com sucesso.`);
    } else {
      // Falha
      playBeep(260, 0.3);
      fingerCircle.className = "relative h-44 w-44 rounded-full bg-rose-950/60 border-4 border-rose-500 flex flex-col items-center justify-center shadow-2xl shadow-rose-500/60 scale-105 transition-all duration-300";
      fingerIcon.className = "fa-solid fa-xmark text-6xl text-rose-400";
      fingerHint.innerText = "Falha no Dedo";
      fingerHint.className = "text-[11px] font-bold text-rose-400 uppercase tracking-widest mt-2";
      alert(data.message || "Falha na validação da digital.");
    }

  } catch (err) {
    console.error("Erro:", err);
    alert("Falha na conexão com o servidor de ponto.");
  } finally {
    // Retorna ao estado inicial após 3 segundos para o próximo colaborador
    setTimeout(() => {
      closeFeedbackModal();
      fingerCircle.className = "relative h-44 w-44 rounded-full bg-slate-950 border-4 border-emerald-500/60 flex flex-col items-center justify-center shadow-2xl shadow-emerald-500/20 group-hover:border-emerald-400 transition-all duration-300";
      fingerIcon.className = "fa-solid fa-fingerprint text-6xl text-emerald-400";
      fingerHint.innerText = "Toque o Dedo";
      fingerHint.className = "text-[11px] font-bold text-emerald-400/80 uppercase tracking-widest mt-2";
      btnPunch.disabled = false;
      isScanning = false;
    }, 3000);
  }
}

// Modal de Feedback
function showFeedbackModal(info) {
  const modal = document.getElementById("feedback-modal");
  const iconContainer = document.getElementById("feedback-icon");
  const badge = document.getElementById("feedback-badge");

  iconContainer.className = `h-20 w-20 rounded-full mx-auto flex items-center justify-center text-4xl shadow-xl ${info.iconClass}`;
  iconContainer.innerHTML = `<i class="${info.icon}"></i>`;

  badge.className = `px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${info.badgeClass}`;
  badge.innerText = info.type;

  document.getElementById("feedback-name").innerText = info.name;
  document.getElementById("feedback-dept").innerText = info.dept;
  document.getElementById("feedback-time").innerText = info.time;
  document.getElementById("feedback-msg").innerText = info.msg;

  modal.classList.remove("hidden");
}

function closeFeedbackModal() {
  const modal = document.getElementById("feedback-modal");
  if (modal) modal.classList.add("hidden");
}

// Sons Sintetizados via Web Audio API
function playBeep(freq = 440, duration = 0.2) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {
    console.warn("Audio bloqueado:", e);
  }
}

function playSuccessChime() {
  playBeep(523.25, 0.12);
  setTimeout(() => playBeep(659.25, 0.25), 120);
}

// Síntese de Voz (Saudação em Português)
function speakText(text) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'pt-BR';
    utter.rate = 1.05;
    window.speechSynthesis.speak(utter);
  }
}

// Tela Cheia
function toggleFullscreen() {
  const icon = document.getElementById("fs-icon");
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => console.log(err));
    if (icon) icon.className = "fa-solid fa-compress text-base";
  } else {
    document.exitFullscreen().catch(err => console.log(err));
    if (icon) icon.className = "fa-solid fa-expand text-base";
  }
}
