const DB_NAME = "ritmo-study-planner";
const DB_VERSION = 1;
const todayISO = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const defaults = () => ({
  tasks: [], subjects: [], assessments: [], grades: [], sessions: [],
  settings: { name: "", dailyGoal: 2, weeklyGoal: 10, passingGrade: 7, focusMinutes: 25, shortBreak: 5, longBreak: 15, darkMode: false },
});
let db;
let state = defaults();
let activeProfile = null;
let activePage = "dashboard";
let selectedDate = todayISO();
let calendarMode = "month";
let calendarFilter = "all";
let timerMode = "focus";
let timerRemaining = 25 * 60;
let timerInterval = null;
let timerRunning = false;
let sessionSubject = "";
let toastTimeout;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const parseDate = value => new Date(`${value}T12:00:00`);
const dateISO = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const formatDate = (value, options = { day: "numeric", month: "short" }) => value ? new Intl.DateTimeFormat("pt-BR", options).format(parseDate(value)) : "Sem data";
const dayNames = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const subjectById = id => state.subjects.find(subject => subject.id === id);
const getDayTaskStatus = (task, date) => Boolean(task.completed?.[date]);
const dueTasks = date => state.tasks.filter(task => {
  if (task.category === "academic") return false;
  if (date < task.startDate || (task.endDate && date > task.endDate)) return false;
  if (task.recurrence === "daily") return true;
  if (task.recurrence === "weekdays") return ![0, 6].includes(parseDate(date).getDay());
  if (task.recurrence === "custom") return (task.weekdays || []).includes(parseDate(date).getDay());
  return task.startDate === date;
});
const completedTasksCount = date => dueTasks(date).filter(task => getDayTaskStatus(task, date)).length;
const sessionsForDate = date => state.sessions.filter(session => session.date === date);
const minutesStudied = (date = todayISO()) => sessionsForDate(date).reduce((sum, session) => sum + session.minutes, 0);
const weekDates = (base = parseDate(todayISO())) => {
  const monday = new Date(base);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return dateISO(date);
  });
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore("app", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Não foi possível abrir o banco de dados."));
  });
}
function readState() {
  return new Promise((resolve, reject) => {
    const store = db.transaction("app", "readonly").objectStore("app");
    const request = store.get(`profile:${activeProfile}`);
    request.onsuccess = () => {
      if (request.result) {
        resolve({ data: request.result.data, legacy: false });
        return;
      }
      if (activeProfile !== "ana") {
        resolve({ data: defaults(), legacy: false });
        return;
      }
      const legacyRequest = store.get("main");
      legacyRequest.onsuccess = () => resolve({ data: legacyRequest.result?.data || defaults(), legacy: Boolean(legacyRequest.result) });
      legacyRequest.onerror = () => reject(legacyRequest.error || new Error("Não foi possível carregar os dados anteriores."));
    };
    request.onerror = () => reject(request.error || new Error("Não foi possível carregar seus dados."));
  });
}
function persist() {
  return new Promise((resolve, reject) => {
    if (!activeProfile) {
      reject(new Error("Escolha um perfil antes de salvar."));
      return;
    }
    const transaction = db.transaction("app", "readwrite");
    const store = transaction.objectStore("app");
    store.put({ id: `profile:${activeProfile}`, data: state });
    if (activeProfile === "ana") store.delete("main");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Não foi possível salvar seus dados."));
    transaction.onabort = () => reject(transaction.error || new Error("O salvamento foi cancelado."));
  });
}
async function saveAndRender(message = "") {
  try {
    await persist();
    render();
    if (message) notify(message);
  } catch (error) {
    notify(`Erro ao salvar: ${error.message}`, 4500);
  }
}
function notify(message, duration = 2600) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), duration);
}
function pageHeading(eyebrow, title, description, action = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="subheading">${description}</p></div>${action}</div>`;
}
function taskRow(task, date, compact = false) {
  const done = getDayTaskStatus(task, date);
  const subject = subjectById(task.subjectId);
  const time = task.time ? `<span class="task-time">${escapeHTML(task.time)}</span>` : "";
  const subjectName = subject ? ` · ${escapeHTML(subject.name)}` : "";
  return `<div class="task-row" data-task-row="${escapeHTML(task.id)}"><button class="check-button ${done ? "done" : ""}" data-action="toggle-task" data-id="${escapeHTML(task.id)}" data-date="${date}" aria-label="${done ? "Reabrir" : "Concluir"} tarefa">${done ? "✓" : ""}</button><div class="task-main"><span class="task-name ${done ? "is-done" : ""}">${escapeHTML(task.title)}</span><span class="task-meta"><i class="category-dot ${task.category === "routine" ? "routine" : ""}"></i>${task.category === "routine" ? "Rotina" : "Estudo"}${subjectName}${compact ? "" : ` · ${escapeHTML(task.priority || "Normal")}`}</span></div>${time}<div class="row-actions"><button class="text-button" data-action="edit-task" data-id="${escapeHTML(task.id)}" aria-label="Editar tarefa">Editar</button></div></div>`;
}
function assessmentRow(item) {
  const subject = subjectById(item.subjectId);
  const due = parseDate(item.date);
  const statusClass = item.status === "Em andamento" ? "in-progress" : "";
  return `<div class="upcoming-item"><div class="date-tile"><strong>${due.getDate()}</strong><span>${new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(due).replace(".", "")}</span></div><div class="upcoming-info"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(subject?.name || "Sem matéria")} · ${escapeHTML(item.type)}</span></div><span class="status-pill ${statusClass}">${escapeHTML(item.status)}</span></div>`;
}
function statCard(label, value, note, icon) {
  return `<article class="card stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${note}</div></article>`;
}
function dashboardPage() {
  const today = todayISO();
  const tasks = dueTasks(today);
  const done = completedTasksCount(today);
  const studied = minutesStudied(today);
  const weekMinutes = weekDates().reduce((sum, date) => sum + minutesStudied(date), 0);
  const goal = Number(state.settings.dailyGoal) || 2;
  const percent = Math.min(100, Math.round(studied / (goal * 60) * 100));
  const upcoming = state.assessments.filter(item => item.date >= today && item.status !== "Concluído").sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const greeting = new Date().getHours() < 12 ? "Bom dia" : new Date().getHours() < 18 ? "Boa tarde" : "Boa noite";
  const firstName = state.settings.name.trim().split(/\s+/)[0] || (activeProfile === "ana" ? "Ana" : "Henrique");
  const dateHeading = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(parseDate(today)).toLocaleUpperCase("pt-BR");
  const dates = weekDates();
  const weekStrip = dates.map(date => {
    const parsed = parseDate(date);
    return `<button class="week-day ${date === selectedDate ? "selected" : ""} ${date === today ? "today" : ""}" data-action="select-date" data-date="${date}"><span>${dayNames[parsed.getDay()]}</span><strong>${parsed.getDate()}</strong></button>`;
  }).join("");
  return `${pageHeading(escapeHTML(dateHeading), `${greeting}${firstName ? `, ${escapeHTML(firstName)}` : ""} 👋`, "Um passo de cada vez. Aqui está o resumo do seu dia.", `<button class="button button-secondary" data-page="focus">◉ Iniciar foco</button>`)}
    <section class="grid stats-grid">
      ${statCard("Tarefas de hoje", `${done}<span style="font-size:13px;color:#a0a59e"> / ${tasks.length}</span>`, `${tasks.length - done} pendente${tasks.length - done === 1 ? "" : "s"}`, "✓")}
      ${statCard("Estudo hoje", `${Math.floor(studied / 60)}h ${String(studied % 60).padStart(2, "0")}m`, `${Math.floor(weekMinutes / 60)}h ${String(weekMinutes % 60).padStart(2, "0")}m nesta semana`, "◷")}
      ${statCard("Matérias ativas", state.subjects.length, "Continue avançando com a ORGANA", "▤")}
      ${statCard("Próximos compromissos", upcoming.length, upcoming.length ? "Provas e entregas por vir" : "Sua agenda está livre", "◇")}
    </section>
    <section class="grid dashboard-grid">
      <div class="stack">
        <article class="card"><div class="card-header"><h2 class="card-title">Sua semana</h2><button class="card-link" data-page="calendar">Abrir calendário →</button></div><div class="card-body"><div class="week-strip">${weekStrip}</div></div></article>
        <article class="card"><div class="card-header"><h2 class="card-title">Tarefas de hoje</h2><button class="card-link" data-action="new-task">+ Adicionar</button></div><div class="card-body"><div class="task-list">${tasks.length ? tasks.slice(0, 6).map(task => taskRow(task, today, true)).join("") : `<div class="empty-state">Dia livre. Adicione uma tarefa para começar.</div>`}</div></div></article>
      </div>
      <div class="stack">
        <article class="card goal-card"><p class="eyebrow">META DIÁRIA</p><h2>Seu tempo de estudo</h2><div class="goal-number">${Math.floor(studied / 60)}h ${String(studied % 60).padStart(2, "0")}m <span style="font-size:13px;font-weight:500;color:#d0ded2">/ ${goal}h</span></div><span class="goal-caption">${percent >= 100 ? "Meta alcançada. Excelente trabalho!" : `${percent}% da meta concluída`}</span><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div></article>
        <article class="card"><div class="card-header"><h2 class="card-title">Próximos compromissos</h2><button class="card-link" data-page="academic">Ver todos →</button></div><div class="card-body">${upcoming.length ? upcoming.map(assessmentRow).join("") : `<div class="empty-state">Nenhuma prova ou entrega próxima.</div>`}</div></article>
      </div>
    </section>`;
}
function calendarTasksFor(date) {
  const tasks = dueTasks(date).filter(task => calendarFilter === "all" || task.category === calendarFilter);
  const assessments = state.assessments.filter(item => item.date === date).map(item => ({ ...item, category: "academic", title: item.title }));
  return [...tasks.map(task => ({ ...task, eventType: "task" })), ...assessments.map(item => ({ ...item, eventType: "assessment" }))];
}
function calendarPage() {
  const anchor = parseDate(selectedDate);
  const title = calendarMode === "month"
    ? `${monthNames[anchor.getMonth()]} ${anchor.getFullYear()}`
    : calendarMode === "week"
      ? `${formatDate(weekDates(anchor)[0])} — ${formatDate(weekDates(anchor)[6])}`
      : new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(anchor);
  const controls = `<div class="calendar-controls"><button class="icon-button" data-action="calendar-prev" aria-label="Período anterior">‹</button><h2 class="calendar-title">${title}</h2><button class="icon-button" data-action="calendar-next" aria-label="Próximo período">›</button><button class="button button-secondary button-small" data-action="calendar-today">Hoje</button></div><div class="segmented">${[["month", "Mês"], ["week", "Semana"], ["day", "Dia"]].map(([value, label]) => `<button class="${calendarMode === value ? "selected" : ""}" data-action="calendar-mode" data-mode="${value}">${label}</button>`).join("")}</div>`;
  const filter = `<div class="filter-row" style="margin-bottom:13px">${[["all", "Tudo"], ["study", "Estudos"], ["routine", "Rotina"]].map(([value, label]) => `<button class="filter-chip ${calendarFilter === value ? "selected" : ""}" data-action="calendar-filter" data-filter="${value}">${label}</button>`).join("")}</div>`;
  let calendar;
  if (calendarMode === "day") {
    const items = calendarTasksFor(selectedDate).filter(item => item.eventType === "assessment" || item.category !== "academic");
    calendar = `<div class="calendar-day-list">${items.length ? items.map(item => item.eventType === "task" ? `<div class="day-task-card">${taskRow(item, selectedDate, true)}</div>` : `<div class="day-task-card"><span class="category-dot" style="background:#bd6860"></span><div class="task-main"><span class="task-name">${escapeHTML(item.title)}</span><span class="task-meta">${escapeHTML(item.type)} · ${escapeHTML(subjectById(item.subjectId)?.name || "Sem matéria")}</span></div></div>`).join("") : `<div class="card empty-state">Nenhum compromisso para ${formatDate(selectedDate)}.</div>`}</div>`;
  } else {
    const dates = calendarMode === "week" ? weekDates(anchor) : (() => {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const start = new Date(first);
      start.setDate(first.getDate() - first.getDay());
      return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        return dateISO(date);
      });
    })();
    const weeks = calendarMode === "week" ? "" : dayNames.map(day => `<div class="calendar-weekday">${day}</div>`).join("");
    const days = dates.map(date => {
      const parsed = parseDate(date);
      const items = calendarTasksFor(date);
      return `<div class="calendar-day ${parsed.getMonth() !== anchor.getMonth() && calendarMode === "month" ? "outside" : ""} ${date === todayISO() ? "today" : ""} ${date === selectedDate ? "selected" : ""}" data-action="select-date" data-date="${date}"><span class="day-number">${parsed.getDate()}</span><div class="calendar-events">${items.slice(0, 3).map(item => `<div class="calendar-event ${item.eventType === "assessment" ? "assessment" : item.category === "routine" ? "routine" : ""}" title="${escapeHTML(item.title)}">${escapeHTML(item.title)}</div>`).join("")}${items.length > 3 ? `<span class="calendar-event">+${items.length - 3} mais</span>` : ""}</div></div>`;
    }).join("");
    calendar = `<div class="calendar-grid">${weeks}${days}</div>`;
  }
  return `${pageHeading("ORGANIZAÇÃO", "Calendário", "Planeje sua rotina e distribua seus estudos com clareza.", `<button class="button button-primary" data-action="new-task">＋ Nova tarefa</button>`)}<div class="calendar-toolbar">${controls}</div>${filter}${calendar}<div class="section-spacer"><button class="button button-secondary button-small" data-action="new-task">＋ Adicionar tarefa em ${formatDate(selectedDate)}</button></div>`;
}
function routinePage() {
  const dates = weekDates(parseDate(selectedDate));
  const weekdayCards = dates.map(date => {
    const parsed = parseDate(date);
    const tasks = dueTasks(date).filter(task => task.category === "routine");
    return `<article class="card"><div class="card-header"><h2 class="card-title">${dayNames[parsed.getDay()]} ${parsed.getDate()}</h2><button class="card-link" data-action="new-task" data-date="${date}">+ Tarefa</button></div><div class="card-body"><div class="task-list">${tasks.length ? tasks.map(task => taskRow(task, date, true)).join("") : `<div class="empty-state">Sem atividades</div>`}</div></div></article>`;
  }).join("");
  return `${pageHeading("ORGANIZAÇÃO PESSOAL", "Minha rotina", "Uma visão semanal para equilibrar compromissos e tempo livre.", `<button class="button button-secondary" data-action="new-task" data-category="routine">＋ Adicionar atividade</button>`)}<div class="calendar-toolbar"><div class="calendar-controls"><button class="icon-button" data-action="calendar-prev" aria-label="Semana anterior">‹</button><h2 class="calendar-title">${formatDate(dates[0])} — ${formatDate(dates[6])}</h2><button class="icon-button" data-action="calendar-next" aria-label="Próxima semana">›</button></div><button class="button button-secondary button-small" data-action="calendar-today">Esta semana</button></div><section class="grid subject-grid">${weekdayCards}</section>`;
}
function subjectCard(subject) {
  const topics = subject.topics || [];
  const completed = topics.filter(topic => topic.done).length;
  const progress = topics.length ? Math.round(completed / topics.length * 100) : 0;
  return `<article class="card subject-card"><div class="subject-top"><div style="display:flex;gap:10px"><span class="subject-color" style="background:${escapeHTML(subject.color || "#66856e")}"></span><h3>${escapeHTML(subject.name)}</h3></div><div class="row-actions"><button class="text-button" data-action="edit-subject" data-id="${escapeHTML(subject.id)}">Editar</button><button class="text-button danger" data-action="delete-subject" data-id="${escapeHTML(subject.id)}">Excluir</button></div></div><p class="subject-desc">${escapeHTML(subject.description || "Sem descrição")}</p><div class="subject-progress-label"><span>Conteúdos concluídos</span><span>${completed}/${topics.length} · ${progress}%</span></div><div class="thin-track"><div class="thin-fill" style="width:${progress}%"></div></div>${topics.length ? `<div class="topic-list">${topics.map((topic, index) => `<label class="topic-row"><input type="checkbox" data-action="toggle-topic" data-subject="${escapeHTML(subject.id)}" data-index="${index}" ${topic.done ? "checked" : ""}>${escapeHTML(topic.title)}</label>`).join("")}</div>` : ""}</article>`;
}
function subjectsPage() {
  return `${pageHeading("SEU APRENDIZADO", "Minhas matérias", "Organize conteúdos e acompanhe seu progresso em cada matéria.", `<button class="button button-primary" data-action="new-subject">＋ Nova matéria</button>`)}${state.subjects.length ? `<section class="grid subject-grid">${state.subjects.map(subjectCard).join("")}</section>` : `<article class="card empty-state">Cadastre sua primeira matéria para organizar conteúdos e notas.<br><br><button class="button button-primary" data-action="new-subject">＋ Adicionar matéria</button></article>`}`;
}
function focusPage() {
  const focusMinutes = Number(state.settings.focusMinutes) || 25;
  const subjectOptions = `<option value="">Escolher matéria (opcional)</option>${state.subjects.map(subject => `<option value="${escapeHTML(subject.id)}" ${sessionSubject === subject.id ? "selected" : ""}>${escapeHTML(subject.name)}</option>`).join("")}`;
  const history = [...state.sessions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  return `${pageHeading("ATENÇÃO PLENA", "Foco e produtividade", "Sessões de foco para avançar com presença, uma etapa por vez.")}<section class="focus-layout"><article class="card timer-card"><div class="timer-modes">${[["focus", "Foco"], ["short", "Pausa curta"], ["long", "Pausa longa"]].map(([mode, label]) => `<button class="${timerMode === mode ? "selected" : ""}" data-action="timer-mode" data-mode="${mode}">${label}</button>`).join("")}</div><div class="timer-ring"><div><div class="timer-time" id="timerDisplay">${formatTimer(timerRemaining)}</div><div class="timer-caption">${timerRunning ? "Sessão em andamento" : "Pronto quando você estiver"}</div></div></div><div class="timer-buttons"><button class="button button-primary" data-action="timer-toggle">${timerRunning ? "Ⅱ Pausar" : "▶ Iniciar foco"}</button><button class="button button-secondary" data-action="timer-reset">↻ Reiniciar</button></div></article><div class="focus-side"><article class="card setting-card"><h3>Sua sessão</h3><div class="form-grid"><div class="field"><label for="sessionSubject">Matéria</label><select id="sessionSubject">${subjectOptions}</select></div><p class="hint">A sessão é registrada automaticamente ao concluir o ciclo de foco.</p></div></article><article class="card"><div class="card-header"><h2 class="card-title">Sessões recentes</h2></div><div class="card-body">${history.length ? history.map(session => `<div class="upcoming-item"><div class="date-tile"><strong>${Math.floor(session.minutes / 60)}h</strong><span>${session.minutes % 60} min</span></div><div class="upcoming-info"><strong>${escapeHTML(subjectById(session.subjectId)?.name || "Estudo livre")}</strong><span>${formatDate(session.date)} · sessão concluída</span></div></div>`).join("") : `<div class="empty-state">Suas sessões concluídas aparecerão aqui.</div>`}</div></article></div></section>`;
}
function academicPage() {
  const assessments = [...state.assessments].sort((a, b) => a.date.localeCompare(b.date));
  const rows = assessments.length ? assessments.map(item => {
    const parsed = parseDate(item.date);
    return `<div class="academic-row"><div class="date-tile"><strong>${parsed.getDate()}</strong><span>${new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(parsed).replace(".", "")}</span></div><div class="upcoming-info"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(subjectById(item.subjectId)?.name || "Sem matéria")} · ${escapeHTML(item.type)}${item.time ? ` · ${escapeHTML(item.time)}` : ""}</span></div><span class="status-pill ${item.status === "Em andamento" ? "in-progress" : ""}">${escapeHTML(item.status)}</span><div class="row-actions"><button class="text-button" data-action="edit-assessment" data-id="${escapeHTML(item.id)}">Editar</button><button class="text-button danger" data-action="delete-assessment" data-id="${escapeHTML(item.id)}">Excluir</button></div></div>`;
  }).join("") : `<div class="card empty-state">Nenhuma prova ou atividade cadastrada.<br><br><button class="button button-primary" data-action="new-assessment">＋ Adicionar compromisso</button></div>`;
  const gradeRows = state.grades.length ? state.grades.map(grade => `<tr><td>${escapeHTML(grade.title)}</td><td>${escapeHTML(subjectById(grade.subjectId)?.name || "Matéria removida")}</td><td>${Number(grade.score).toLocaleString("pt-BR")}</td><td>${Number(grade.weight).toLocaleString("pt-BR")}</td><td><button class="text-button danger" data-action="delete-grade" data-id="${escapeHTML(grade.id)}">Excluir</button></td></tr>`).join("") : `<tr><td colspan="5" class="empty-state">Cadastre avaliações para calcular suas médias.</td></tr>`;
  return `${pageHeading("VIDA ACADÊMICA", "Provas e atividades", "Acompanhe entregas, avaliações e notas em um só lugar.", `<button class="button button-primary" data-action="new-assessment">＋ Novo compromisso</button>`)}<section class="stack"><article class="card"><div class="card-header"><h2 class="card-title">Próximas provas e entregas</h2></div><div class="card-body"><div class="academic-list">${rows}</div></div></article><article class="card"><div class="card-header"><h2 class="card-title">Notas e avaliações</h2><button class="button button-secondary button-small" data-action="new-grade">＋ Registrar nota</button></div><div class="card-body"><div class="table-wrap"><table class="grade-table"><thead><tr><th>Avaliação</th><th>Matéria</th><th>Nota</th><th>Peso</th><th></th></tr></thead><tbody>${gradeRows}</tbody></table></div></div></article></section>`;
}
function weightedAverage(subjectId) {
  const grades = state.grades.filter(grade => grade.subjectId === subjectId);
  const totalWeight = grades.reduce((sum, grade) => sum + Number(grade.weight), 0);
  return totalWeight ? grades.reduce((sum, grade) => sum + Number(grade.score) * Number(grade.weight), 0) / totalWeight : null;
}
function performancePage() {
  const dates = weekDates();
  const minutes = dates.map(date => minutesStudied(date));
  const max = Math.max(...minutes, 60);
  const chart = dates.map((date, index) => `<div class="chart-column"><div class="bar-area"><div class="bar" title="${Math.floor(minutes[index] / 60)}h ${minutes[index] % 60}m" style="height:${Math.max(3, minutes[index] / max * 100)}%"></div></div><span class="chart-label">${dayNames[parseDate(date).getDay()]}</span></div>`).join("");
  const averages = state.subjects.map(subject => {
    const average = weightedAverage(subject.id);
    const target = Number(subject.passingGrade || state.settings.passingGrade || 7);
    const needed = average === null ? "" : average >= target ? "Meta de aprovação alcançada" : `Faltam ${(target - average).toFixed(1).replace(".", ",")} pts para a média mínima`;
    return `<div class="subject-average"><div><strong>${escapeHTML(subject.name)}</strong><div class="hint">${needed || "Adicione notas para acompanhar a média"}</div></div><span class="average-value">${average === null ? "—" : average.toFixed(1).replace(".", ",")}</span></div>`;
  }).join("");
  const weekTotal = minutes.reduce((sum, value) => sum + value, 0);
  const done = completedTasksCount(todayISO());
  const taskTotal = dueTasks(todayISO()).length;
  const topicTotal = state.subjects.reduce((sum, subject) => sum + (subject.topics || []).length, 0);
  const topicDone = state.subjects.reduce((sum, subject) => sum + (subject.topics || []).filter(topic => topic.done).length, 0);
  return `${pageHeading("SEU PROGRESSO", "Desempenho", "Pequenos avanços consistentes constroem grandes resultados.")}<section class="grid stats-grid">${statCard("Estudo nesta semana", `${Math.floor(weekTotal / 60)}h ${weekTotal % 60}m`, "Tempo registrado no Pomodoro", "◷")}${statCard("Tarefas concluídas hoje", `${done}/${taskTotal}`, "Progresso diário", "✓")}${statCard("Conteúdos concluídos", `${topicDone}/${topicTotal}`, "Em todas as matérias", "▤")}${statCard("Sessões totais", state.sessions.length, "Ciclos de foco concluídos", "◉")}</section><section class="grid performance-grid"><article class="card"><div class="card-header"><h2 class="card-title">Horas de estudo nesta semana</h2></div><div class="card-body"><div class="chart">${chart}</div></div></article><article class="card"><div class="card-header"><h2 class="card-title">Médias por matéria</h2></div><div class="card-body">${averages || `<div class="empty-state">Adicione matérias para acompanhar suas médias.</div>`}</div></article></section>`;
}
function settingsPage() {
  return `${pageHeading("PREFERÊNCIAS", "Configurações", "Deixe seu espaço com a sua cara.")}<section class="settings-stack"><article class="card setting-card"><h3>Aparência</h3><div class="appearance-setting"><div><strong>Modo escuro</strong><p class="hint">Use um tema mais suave para ambientes com pouca luz.</p></div><button class="button button-secondary" data-action="toggle-theme">${state.settings.darkMode ? "☀ Ativar modo claro" : "☾ Ativar modo escuro"}</button></div></article><article class="card setting-card" style="max-width:570px"><h3>Seu perfil e metas</h3><form id="settingsForm" class="form-grid"><div class="field"><label for="userName">Como podemos chamar você?</label><input id="userName" name="name" value="${escapeHTML(state.settings.name)}" placeholder="Seu nome"></div><div class="field-row"><div class="field"><label for="dailyGoal">Meta diária de estudo (horas)</label><input id="dailyGoal" name="dailyGoal" type="number" min="0.5" max="24" step="0.5" required value="${Number(state.settings.dailyGoal)}"></div><div class="field"><label for="weeklyGoal">Meta semanal (horas)</label><input id="weeklyGoal" name="weeklyGoal" type="number" min="1" max="168" step="1" required value="${Number(state.settings.weeklyGoal)}"></div></div><div class="field-row"><div class="field"><label for="focusMinutes">Foco (minutos)</label><input id="focusMinutes" name="focusMinutes" type="number" min="1" max="180" required value="${Number(state.settings.focusMinutes)}"></div><div class="field"><label for="shortBreak">Pausa curta (minutos)</label><input id="shortBreak" name="shortBreak" type="number" min="1" max="60" required value="${Number(state.settings.shortBreak)}"></div></div><div class="field"><label for="longBreak">Pausa longa (minutos)</label><input id="longBreak" name="longBreak" type="number" min="1" max="90" required value="${Number(state.settings.longBreak)}"></div><button class="button button-primary" type="submit">Salvar preferências</button></form></article></section>`;
}
const pageNames = { dashboard: "Visão geral", calendar: "Calendário", routine: "Minha rotina", subjects: "Matérias", focus: "Foco", academic: "Provas e atividades", performance: "Desempenho", settings: "Configurações" };
function render() {
  applyTheme();
  $("#pageTitle").textContent = pageNames[activePage] || "Visão geral";
  $("#breadcrumbProfile").textContent = activeProfile === "ana" ? "Ana" : "Henrique";
  $("#headerDate").textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short" }).format(new Date());
  $$(".nav-link[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === activePage));
  const pages = { dashboard: dashboardPage, calendar: calendarPage, routine: routinePage, subjects: subjectsPage, focus: focusPage, academic: academicPage, performance: performancePage, settings: settingsPage };
  $("#content").innerHTML = (pages[activePage] || dashboardPage)();
}
function applyTheme() {
  const darkMode = Boolean(state.settings?.darkMode);
  document.body.classList.toggle("dark-theme", darkMode);
  document.body.classList.toggle("henrique-theme", activeProfile === "henrique");
  const themeToggle = $(".theme-toggle");
  if (themeToggle) {
    themeToggle.textContent = darkMode ? "☀" : "☾";
    themeToggle.setAttribute("aria-label", darkMode ? "Ativar modo claro" : "Ativar modo escuro");
    themeToggle.title = darkMode ? "Ativar modo claro" : "Ativar modo escuro";
  }
  const themeColor = $('meta[name="theme-color"]');
  if (themeColor) themeColor.content = darkMode
    ? activeProfile === "henrique" ? "#171e27" : "#201a1d"
    : activeProfile === "henrique" ? "#f3f6f9" : "#fbf7f3";
}
async function selectProfile(profileId) {
  if (!["ana", "henrique"].includes(profileId)) return;
  activeProfile = profileId;
  $("#profileError").textContent = "";
  try {
    const loaded = await readState();
    state = loaded.data || defaults();
    state.settings = { ...defaults().settings, ...(state.settings || {}) };
    if (!Array.isArray(state.tasks)) state.tasks = [];
    if (!Array.isArray(state.subjects)) state.subjects = [];
    if (!Array.isArray(state.assessments)) state.assessments = [];
    if (!Array.isArray(state.grades)) state.grades = [];
    if (!Array.isArray(state.sessions)) state.sessions = [];
    if (loaded.legacy) await persist();
    timerRemaining = Number(state.settings.focusMinutes) * 60;
    sessionSubject = "";
    $("#activeProfileName").textContent = profileId === "ana" ? "Ana" : "Henrique";
    $(".avatar").textContent = profileId === "ana" ? "A" : "H";
    $("#profileGate").hidden = true;
    $("#appShell").hidden = false;
    render();
  } catch (error) {
    activeProfile = null;
    $("#profileError").textContent = `Não foi possível abrir o perfil: ${error.message}`;
  }
}
function showProfilePicker() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerRunning = false;
  $("#modalRoot").innerHTML = "";
  $("#sidebar").classList.remove("open");
  $("#appShell").hidden = true;
  $("#profileGate").hidden = false;
  document.body.classList.remove("dark-theme", "henrique-theme");
  activeProfile = null;
}
function formField(label, name, options = {}) {
  const required = options.required === false ? "" : "required";
  const value = options.value ?? "";
  if (options.type === "select") {
    const choices = options.options || [];
    return `<div class="field"><label for="${name}">${label}</label><select id="${name}" name="${name}" ${required}>${options.empty ? `<option value="">${options.empty}</option>` : ""}${choices.map(choice => `<option value="${escapeHTML(choice.value)}" ${String(value) === String(choice.value) ? "selected" : ""}>${escapeHTML(choice.label)}</option>`).join("")}</select></div>`;
  }
  if (options.type === "textarea") return `<div class="field"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" ${required} placeholder="${escapeHTML(options.placeholder || "")}">${escapeHTML(value)}</textarea></div>`;
  return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${options.type || "text"}" value="${escapeHTML(value)}" placeholder="${escapeHTML(options.placeholder || "")}" ${options.min !== undefined ? `min="${options.min}"` : ""} ${options.max !== undefined ? `max="${options.max}"` : ""} ${options.step ? `step="${options.step}"` : ""} ${required}></div>`;
}
function openModal(title, body) {
  $("#modalRoot").innerHTML = `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><header class="modal-header"><h2 id="modalTitle">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="Fechar">×</button></header>${body}</section></div>`;
  $(".modal-backdrop .modal").addEventListener("click", event => event.stopPropagation());
  const first = $("input, select, textarea", $("#modalRoot"));
  if (first) first.focus();
}
function showTaskForm(task = null, defaultsForForm = {}) {
  const date = defaultsForForm.date || selectedDate || todayISO();
  const selectedCategory = defaultsForForm.category || task?.category || "study";
  const days = ["D", "S", "T", "Q", "Q", "S", "S"];
  const selectedWeekdays = task?.weekdays || [];
  const recurrence = task?.recurrence || "once";
  const subjectChoices = state.subjects.map(subject => ({ value: subject.id, label: subject.name }));
  const body = `<form id="taskForm" data-id="${escapeHTML(task?.id || "")}"><div class="modal-body">${formField("Nome da tarefa", "title", { value: task?.title || "", placeholder: "Ex.: Revisar capítulo 3" })}<div class="field-row">${formField("Categoria", "category", { type: "select", value: selectedCategory, options: [{ value: "study", label: "Estudos" }, { value: "routine", label: "Rotina" }] })}${formField("Matéria", "subjectId", { type: "select", value: task?.subjectId || "", options: subjectChoices, empty: "Sem matéria", required: false })}</div><div class="field-row">${formField("Data de início", "startDate", { type: "date", value: task?.startDate || date })}${formField("Até (opcional)", "endDate", { type: "date", value: task?.endDate || "", required: false })}</div><div class="field-row">${formField("Horário (opcional)", "time", { type: "time", value: task?.time || "", required: false })}${formField("Prioridade", "priority", { type: "select", value: task?.priority || "Normal", options: ["Baixa", "Normal", "Alta"].map(value => ({ value, label: value })) })}</div>${formField("Repetição", "recurrence", { type: "select", value: recurrence, options: [{ value: "once", label: "Uma vez" }, { value: "daily", label: "Todos os dias no intervalo" }, { value: "weekdays", label: "Dias úteis (seg–sex)" }, { value: "custom", label: "Dias da semana escolhidos" }] })}<div class="field" id="weekdaysField" style="${recurrence === "custom" ? "" : "display:none"}"><label>Repetir nestes dias</label><div class="check-group">${days.map((day, index) => `<label class="weekday-check"><input type="checkbox" name="weekdays" value="${index}" ${selectedWeekdays.includes(index) ? "checked" : ""}><span>${day}</span></label>`).join("")}</div></div>${formField("Descrição (opcional)", "description", { type: "textarea", value: task?.description || "", required: false, placeholder: "Detalhes úteis para lembrar..." })}<div class="modal-footer">${task ? `<button type="button" class="button button-secondary danger" data-action="delete-task" data-id="${escapeHTML(task.id)}">Excluir</button>` : ""}<button type="button" class="button button-secondary" data-action="close-modal">Cancelar</button><button class="button button-primary" type="submit">Salvar tarefa</button></div></div></form>`;
  openModal(task ? "Editar tarefa" : "Nova tarefa", body);
}
function showSubjectForm(subject = null) {
  const topics = (subject?.topics || []).map(topic => topic.title).join("\n");
  const body = `<form id="subjectForm" data-id="${escapeHTML(subject?.id || "")}"><div class="modal-body">${formField("Nome da matéria", "name", { value: subject?.name || "", placeholder: "Ex.: Biologia" })}${formField("Descrição", "description", { value: subject?.description || "", required: false, placeholder: "Um resumo sobre a matéria" })}<div class="field"><label for="color">Cor de identificação</label><input id="color" name="color" type="color" value="${escapeHTML(subject?.color || "#66856e")}" style="height:40px;padding:4px"></div>${formField("Conteúdos (um por linha)", "topics", { type: "textarea", value: topics, required: false, placeholder: "Citologia\\nGenética\\nEcologia" })}${formField("Média mínima para aprovação", "passingGrade", { type: "number", value: subject?.passingGrade || state.settings.passingGrade || 7, min: 0, max: 10, step: 0.1 })}<div class="modal-footer">${subject ? `<button type="button" class="button button-secondary danger" data-action="delete-subject" data-id="${escapeHTML(subject.id)}">Excluir</button>` : ""}<button type="button" class="button button-secondary" data-action="close-modal">Cancelar</button><button class="button button-primary" type="submit">Salvar matéria</button></div></div></form>`;
  openModal(subject ? "Editar matéria" : "Nova matéria", body);
}
function showAssessmentForm(assessment = null) {
  const subjects = state.subjects.map(subject => ({ value: subject.id, label: subject.name }));
  const body = `<form id="assessmentForm" data-id="${escapeHTML(assessment?.id || "")}"><div class="modal-body">${formField("Nome", "title", { value: assessment?.title || "", placeholder: "Ex.: Prova de unidade 1" })}<div class="field-row">${formField("Tipo", "type", { type: "select", value: assessment?.type || "Prova", options: ["Prova", "Trabalho", "Seminário", "Entrega", "Outro"].map(value => ({ value, label: value })) })}${formField("Matéria", "subjectId", { type: "select", value: assessment?.subjectId || "", options: subjects, empty: subjects.length ? "Selecionar matéria" : "Sem matérias cadastradas", required: subjects.length > 0 })}</div><div class="field-row">${formField("Data", "date", { type: "date", value: assessment?.date || selectedDate })}${formField("Horário (opcional)", "time", { type: "time", value: assessment?.time || "", required: false })}</div>${formField("Status", "status", { type: "select", value: assessment?.status || "Pendente", options: ["Pendente", "Em andamento", "Concluído"].map(value => ({ value, label: value })) })}${formField("Descrição (opcional)", "description", { type: "textarea", value: assessment?.description || "", required: false })}<div class="modal-footer">${assessment ? `<button type="button" class="button button-secondary danger" data-action="delete-assessment" data-id="${escapeHTML(assessment.id)}">Excluir</button>` : ""}<button type="button" class="button button-secondary" data-action="close-modal">Cancelar</button><button class="button button-primary" type="submit">Salvar compromisso</button></div></div></form>`;
  openModal(assessment ? "Editar compromisso" : "Novo compromisso", body);
}
function showGradeForm() {
  if (!state.subjects.length) return notify("Cadastre uma matéria antes de registrar notas.");
  const subjects = state.subjects.map(subject => ({ value: subject.id, label: subject.name }));
  const body = `<form id="gradeForm"><div class="modal-body">${formField("Nome da avaliação", "title", { placeholder: "Ex.: Prova parcial" })}${formField("Matéria", "subjectId", { type: "select", options: subjects })}<div class="field-row">${formField("Nota obtida (0–10)", "score", { type: "number", min: 0, max: 10, step: 0.1 })}${formField("Peso", "weight", { type: "number", min: 0.1, max: 100, step: 0.1, value: 1 })}</div><div class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">Cancelar</button><button class="button button-primary" type="submit">Salvar nota</button></div></div></form>`;
  openModal("Registrar nota", body);
}
function formatTimer(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function setTimerMode(mode) {
  if (timerRunning) return notify("Pause a sessão antes de trocar o modo.");
  timerMode = mode;
  const mins = mode === "focus" ? state.settings.focusMinutes : mode === "short" ? state.settings.shortBreak : state.settings.longBreak;
  timerRemaining = Number(mins) * 60;
  render();
}
function updateTimerDisplay() {
  const display = $("#timerDisplay");
  if (display) display.textContent = formatTimer(timerRemaining);
}
async function completeFocusSession() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerRunning = false;
  timerRemaining = 0;
  state.sessions.push({ id: uid(), date: todayISO(), minutes: Number(state.settings.focusMinutes), subjectId: sessionSubject || "", completedAt: new Date().toISOString() });
  await saveAndRender("Sessão concluída e registrada. Muito bem!");
  if ("Notification" in window && Notification.permission === "granted") new Notification("Sessão concluída", { body: "Seu tempo de foco foi registrado." });
}
function toggleTimer() {
  if (timerRunning) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
    render();
    return;
  }
  if (!timerRemaining) setTimerMode(timerMode);
  if (timerMode !== "focus") {
    timerRunning = true;
    timerInterval = setInterval(() => {
      timerRemaining -= 1;
      updateTimerDisplay();
      if (timerRemaining <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        timerRunning = false;
        notify("Pausa concluída. Pronto para voltar ao foco?");
        render();
      }
    }, 1000);
    render();
    return;
  }
  sessionSubject = $("#sessionSubject")?.value || sessionSubject;
  timerRunning = true;
  timerInterval = setInterval(() => {
    timerRemaining -= 1;
    updateTimerDisplay();
    if (timerRemaining <= 0) completeFocusSession();
  }, 1000);
  render();
}
function navigate(page) {
  if (!pageNames[page]) return;
  activePage = page;
  $("#sidebar").classList.remove("open");
  render();
}
function moveCalendar(amount) {
  const date = parseDate(selectedDate);
  if (activePage === "routine" || calendarMode === "week") date.setDate(date.getDate() + amount * 7);
  else if (calendarMode === "month") date.setMonth(date.getMonth() + amount);
  else date.setDate(date.getDate() + amount * (calendarMode === "week" || activePage === "routine" ? 7 : 1));
  selectedDate = dateISO(date);
  render();
}
function selectedCheckboxValues(form, name) {
  return $$(`input[name="${name}"]:checked`, form).map(input => Number(input.value));
}
function formDataObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

document.addEventListener("click", async event => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    event.preventDefault();
    navigate(pageButton.dataset.page);
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "close-modal" || action === "dismiss-modal") { $("#modalRoot").innerHTML = ""; return; }
  if (action === "select-profile") { await selectProfile(target.dataset.profile); return; }
  if (action === "switch-profile") { showProfilePicker(); return; }
  if (action === "toggle-theme") {
    state.settings.darkMode = !state.settings.darkMode;
    await saveAndRender(state.settings.darkMode ? "Modo escuro ativado." : "Modo claro ativado.");
    return;
  }
  if (action === "new-task") { showTaskForm(null, { date: target.dataset.date, category: target.dataset.category }); return; }
  if (action === "edit-task") { const task = state.tasks.find(item => item.id === target.dataset.id); if (task) showTaskForm(task); return; }
  if (action === "delete-task") {
    if (!confirm("Excluir esta tarefa?")) return;
    state.tasks = state.tasks.filter(item => item.id !== target.dataset.id);
    $("#modalRoot").innerHTML = "";
    await saveAndRender("Tarefa excluída.");
    return;
  }
  if (action === "toggle-task") {
    const task = state.tasks.find(item => item.id === target.dataset.id);
    if (!task) return;
    task.completed ||= {};
    task.completed[target.dataset.date] = !task.completed[target.dataset.date];
    await saveAndRender(task.completed[target.dataset.date] ? "Tarefa concluída." : "Tarefa reaberta.");
    return;
  }
  if (action === "select-date") { selectedDate = target.dataset.date; render(); return; }
  if (action === "calendar-mode") { calendarMode = target.dataset.mode; render(); return; }
  if (action === "calendar-filter") { calendarFilter = target.dataset.filter; render(); return; }
  if (action === "calendar-prev") { moveCalendar(-1); return; }
  if (action === "calendar-next") { moveCalendar(1); return; }
  if (action === "calendar-today") { selectedDate = todayISO(); render(); return; }
  if (action === "new-subject") { showSubjectForm(); return; }
  if (action === "edit-subject") { const subject = state.subjects.find(item => item.id === target.dataset.id); if (subject) showSubjectForm(subject); return; }
  if (action === "delete-subject") {
    if (!confirm("Excluir esta matéria? As notas e tarefas relacionadas serão mantidas, mas sem vínculo.")) return;
    state.subjects = state.subjects.filter(item => item.id !== target.dataset.id);
    if ($("#modalRoot")) $("#modalRoot").innerHTML = "";
    await saveAndRender("Matéria excluída.");
    return;
  }
  if (action === "toggle-topic") {
    const subject = state.subjects.find(item => item.id === target.dataset.subject);
    if (!subject?.topics[target.dataset.index]) return;
    subject.topics[target.dataset.index].done = target.checked;
    await saveAndRender();
    return;
  }
  if (action === "new-assessment") { showAssessmentForm(); return; }
  if (action === "edit-assessment") { const item = state.assessments.find(assessment => assessment.id === target.dataset.id); if (item) showAssessmentForm(item); return; }
  if (action === "delete-assessment") {
    if (!confirm("Excluir este compromisso?")) return;
    state.assessments = state.assessments.filter(item => item.id !== target.dataset.id);
    $("#modalRoot").innerHTML = "";
    await saveAndRender("Compromisso excluído.");
    return;
  }
  if (action === "new-grade") { showGradeForm(); return; }
  if (action === "delete-grade") {
    if (!confirm("Excluir esta nota?")) return;
    state.grades = state.grades.filter(item => item.id !== target.dataset.id);
    await saveAndRender("Nota excluída.");
    return;
  }
  if (action === "timer-mode") { setTimerMode(target.dataset.mode); return; }
  if (action === "timer-toggle") { toggleTimer(); return; }
  if (action === "timer-reset") {
    clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
    timerRemaining = Number(timerMode === "focus" ? state.settings.focusMinutes : timerMode === "short" ? state.settings.shortBreak : state.settings.longBreak) * 60;
    render();
    return;
  }
});

document.addEventListener("change", event => {
  if (event.target.name === "recurrence") {
    const field = $("#weekdaysField");
    if (field) field.style.display = event.target.value === "custom" ? "" : "none";
  }
  if (event.target.id === "sessionSubject") sessionSubject = event.target.value;
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  if (form.id === "taskForm") {
    const data = formDataObject(form);
    const existing = state.tasks.find(task => task.id === form.dataset.id);
    if (data.endDate && data.endDate < data.startDate) return notify("A data final deve ser igual ou posterior à inicial.");
    const weekdays = selectedCheckboxValues(form, "weekdays");
    if (data.recurrence === "custom" && !weekdays.length) return notify("Escolha ao menos um dia para a repetição.");
    const task = { ...(existing || {}), id: existing?.id || uid(), title: data.title.trim(), category: data.category, subjectId: data.subjectId, startDate: data.startDate, endDate: data.endDate, time: data.time, priority: data.priority, recurrence: data.recurrence, weekdays, description: data.description || "", completed: existing?.completed || {} };
    if (!task.title) return notify("Informe o nome da tarefa.");
    if (existing) state.tasks = state.tasks.map(item => item.id === existing.id ? task : item);
    else state.tasks.push(task);
    $("#modalRoot").innerHTML = "";
    await saveAndRender(existing ? "Tarefa atualizada." : "Tarefa adicionada.");
  } else if (form.id === "subjectForm") {
    const data = formDataObject(form);
    const existing = form.dataset.id ? state.subjects.find(subject => subject.id === form.dataset.id) : null;
    const previousTopics = existing?.topics || [];
    const topics = (data.topics || "").split("\n").map(line => line.trim()).filter(Boolean).map(title => {
      const previous = previousTopics.find(topic => topic.title === title);
      return { title, done: previous?.done || false };
    });
    const subject = { id: existing?.id || uid(), name: data.name.trim(), description: data.description || "", color: data.color, passingGrade: Number(data.passingGrade), topics };
    if (!subject.name) return notify("Informe o nome da matéria.");
    if (existing) state.subjects = state.subjects.map(item => item.id === existing.id ? subject : item);
    else state.subjects.push(subject);
    $("#modalRoot").innerHTML = "";
    await saveAndRender(existing ? "Matéria atualizada." : "Matéria adicionada.");
  } else if (form.id === "assessmentForm") {
    const data = formDataObject(form);
    const existing = form.dataset.id ? state.assessments.find(item => item.id === form.dataset.id) : null;
    const assessment = { ...(existing || {}), id: existing?.id || uid(), title: data.title.trim(), type: data.type, subjectId: data.subjectId || "", date: data.date, time: data.time, status: data.status, description: data.description || "" };
    if (!assessment.title) return notify("Informe o nome do compromisso.");
    if (existing) state.assessments = state.assessments.map(item => item.id === existing.id ? assessment : item);
    else state.assessments.push(assessment);
    $("#modalRoot").innerHTML = "";
    await saveAndRender(existing ? "Compromisso atualizado." : "Compromisso adicionado.");
  } else if (form.id === "gradeForm") {
    const data = formDataObject(form);
    state.grades.push({ id: uid(), title: data.title.trim(), subjectId: data.subjectId, score: Number(data.score), weight: Number(data.weight) });
    $("#modalRoot").innerHTML = "";
    await saveAndRender("Nota registrada. A média foi atualizada.");
  } else if (form.id === "settingsForm") {
    const data = formDataObject(form);
    state.settings = { ...state.settings, name: data.name.trim(), dailyGoal: Number(data.dailyGoal), weeklyGoal: Number(data.weeklyGoal), focusMinutes: Number(data.focusMinutes), shortBreak: Number(data.shortBreak), longBreak: Number(data.longBreak) };
    timerRemaining = Number(state.settings.focusMinutes) * 60;
    await saveAndRender("Preferências salvas.");
  }
});

$("#menuToggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#sidebarScrim").addEventListener("click", () => $("#sidebar").classList.remove("open"));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") $("#modalRoot").innerHTML = "";
});

async function startApp() {
  try {
    db = await openDatabase();
    $("#profileGate").hidden = false;
  } catch (error) {
    $("#profileError").textContent = `Não foi possível iniciar a ORGANA: ${error.message}`;
  }
}
startApp();
