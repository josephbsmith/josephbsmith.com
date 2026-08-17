const app = document.getElementById("app");
const dialog = document.getElementById("dialog");
const dialogBody = document.getElementById("dialog-body");
const toastNode = document.getElementById("toast");
let state;
let view = location.hash.slice(1) || "now";
let timerInterval;

const dollars = (cents) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format((Number(cents) || 0) / 100);
const hours = (minutes) => `${Math.floor((minutes || 0) / 60)}:${String((minutes || 0) % 60).padStart(2, "0")}`;
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);
const statusClass = (value) => value >= 0 ? "positive" : "negative";

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove("show"), 2600);
}

async function request(path, options = {}) {
  const response = await fetch(`/os/api/${path}`, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    ...options,
  });
  if (response.status === 401) {
    location.assign("/os/login");
    throw new Error("Authentication required.");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function refresh(message) {
  state = await request("state");
  document.getElementById("week-chip").textContent = `Week ${state.week_number}`;
  render();
  if (message) toast(message);
}

async function act(path, body, success) {
  try {
    await request(path, { method: "POST", body: JSON.stringify(body || {}) });
    dialog.close();
    await refresh(success);
  } catch (error) {
    toast(error.message);
  }
}

function metric(label, value, meta = "", cls = "") {
  return `<div class="stat"><span class="label">${esc(label)}</span><span class="value ${cls}">${esc(value)}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</div>`;
}

function timerCard() {
  if (state.running) {
    return `<section class="timer running"><div class="timer-state">Running · Goal ${state.running.number}</div><div class="clock" id="live-clock">00:00:00</div><div class="timer-title">${esc(state.running.title)}</div><button class="primary stop" id="clock-out">Clock out</button></section>`;
  }
  const options = state.goals.filter((goal) => goal.task_id).map((goal) =>
    `<option value="${goal.task_id}">Goal ${goal.number} · ${esc(goal.task_title)}${goal.is_extra_time ? " · extra time" : ""}</option>`).join("");
  return `<section class="timer"><div class="timer-state">Timer</div><div class="clock">00:00:00</div><label class="sub" for="goal-select">Goal</label><select id="goal-select"><option value="">Choose a goal</option>${options}</select><button class="primary" id="clock-in">Clock in</button></section>`;
}

function renderNow() {
  const savingsGap = state.eligible_savings_cents - state.savings_pace_cents;
  app.innerHTML = `<div class="eyebrow">Today</div><h1>Week ${state.week_number} of 38</h1><p class="sub">${state.days_left} days to May 5, 2027</p>
    ${timerCard()}
    <div class="stat-grid">
      ${metric("Eligible savings", dollars(state.eligible_savings_cents), `${dollars(Math.abs(savingsGap))} ${savingsGap >= 0 ? "ahead" : "behind"}`, savingsGap >= 0 ? "positive" : "negative")}
      ${metric("Goal liability", dollars(state.liability_cents), "internal")}
      ${metric("Completed work", dollars(state.completed_capital_cents), "settled contracts")}
      ${metric("Adjusted cash", dollars(state.contract_adjusted_capital_cents), "cash less commitments and goal liability", statusClass(state.contract_adjusted_capital_cents))}
    </div>
    <h2>Weekly progress</h2><div class="list">${state.goals.filter((goal) => goal.weekly_target_minutes > 0).map(goalCard).join("")}</div>`;
  wireTimer();
}

function goalCard(goal, full = false) {
  const percent = goal.weekly_target_minutes ? Math.min(100, Math.round(goal.week_minutes / goal.weekly_target_minutes * 100)) : 0;
  const status = goal.weekly_target_minutes === 0 ? "No quota" : goal.pace_status === "behind" ? "Behind" : "On pace";
  const statusTone = goal.pace_status === "behind" ? "bad" : "good";
  return `<article class="goal"><div class="goal-head"><span class="goal-number">Goal ${goal.number}</span><span class="pill ${goal.weekly_target_minutes ? statusTone : "extra"}">${status}</span></div>
    <h3>${esc(goal.outcome)}</h3><div class="goal-task">${esc(goal.task_title || "No open contract")}</div>
    <div class="progress"><i style="width:${percent}%"></i></div><div class="goal-meta"><span>${hours(goal.week_minutes)} / ${hours(goal.weekly_target_minutes)}</span><span>Due ${esc(goal.task_due_date || goal.deadline)}</span></div>
    ${full && goal.task_id ? `<div class="goal-actions"><button class="secondary finish" data-task="${goal.task_id}" data-title="${esc(goal.task_title)}">Complete contract</button></div>` : ""}
    ${full && !goal.task_id ? `<div class="goal-actions"><button class="secondary open-task" data-goal="${goal.id}" data-deadline="${goal.deadline}">Add contract</button></div>` : ""}</article>`;
}

function renderGoals() {
  app.innerHTML = `<div class="eyebrow">Goals</div><h1>Goal contracts</h1><p class="sub">Clocked time accrues to the internal goal liability until a contract is completed.</p>
    <div class="stat-grid">${metric("Goal liability", dollars(state.liability_cents))}${metric("Hourly rate", dollars(state.rate_cents), "internal rate")}${metric("Completed work", dollars(state.completed_capital_cents))}${metric("Time this week", hours(state.goals.reduce((sum, goal) => sum + goal.week_minutes, 0)), "hours : minutes")}</div>
    <div class="section-title"><h2>All goals</h2><button class="secondary" id="set-rate">Set rate</button></div><div class="list">${state.goals.map((goal) => goalCard(goal, true)).join("")}</div>`;
  document.getElementById("set-rate").addEventListener("click", rateDialog);
  document.querySelectorAll(".finish").forEach((button) => button.addEventListener("click", () => finishDialog(button.dataset.task, button.dataset.title)));
  document.querySelectorAll(".open-task").forEach((button) => button.addEventListener("click", () => taskDialog(button.dataset.goal, button.dataset.deadline)));
}

function renderMoney() {
  const finance = state.finances;
  app.innerHTML = `<div class="eyebrow">Finances</div><h1>Financial position</h1><p class="sub">Posted financial data. Internal goal liability is excluded from the household ledger.</p>
    <div class="stat-grid">${metric("Net worth", dollars(finance.net_worth_cents), "ledger")}${metric("Assets", dollars(finance.assets_cents))}${metric("Real liabilities", dollars(finance.liabilities_cents))}${metric("Eligible savings", dollars(state.eligible_savings_cents), `Target ${dollars(state.savings_target_cents)}`)}</div>
    <h2>Accounts</h2><div class="section">${finance.accounts.map((account) => `<div class="money-row"><span>${esc(account.code)} · ${esc(account.name)}</span><span>${dollars(account.balance_cents)}</span></div>`).join("")}</div>
    <h2>Latest journal entries</h2><div class="section">${finance.journals.map((entry) => `<div class="money-row"><span>${esc(entry.entry_date)}<br><span class="sub">${esc(entry.memo)}</span></span><span>${dollars(entry.amount_cents)}</span></div>`).join("") || `<div class="money-row sub">No posted entries.</div>`}</div>`;
}

function renderClose() {
  const totalMinutes = state.week.rows.reduce((sum, row) => sum + row.minutes, 0);
  const totalAccrued = state.week.rows.reduce((sum, row) => sum + row.accrued_cents, 0);
  app.innerHTML = `<div class="eyebrow">Close</div><h1>Weekly and monthly close</h1><p class="sub">Week of ${esc(state.week_start)} · ${esc(state.month.period)}</p>
    <div class="stat-grid">${metric("Week labor", hours(totalMinutes), "hours : minutes")}${metric("Week payroll", dollars(totalAccrued))}${metric("Week state", state.week.closed ? "Closed" : "Open")}${metric("Month state", state.month.status.replaceAll("_", " "))}</div>
    <h2>Weekly goals</h2><div class="section">${state.week.rows.map((row) => `<div class="money-row"><span>Goal ${row.number} · ${esc(row.outcome)}</span><span>${hours(row.minutes)}<br><span class="sub">${dollars(row.accrued_cents)}</span></span></div>`).join("")}</div>
    ${state.week.closed ? `<p><span class="pill good">Closed ${esc(state.week.closed.closed_at.slice(0, 10))}</span></p>` : `<button class="primary" id="close-week">Close week</button>`}
    <h2>Month-end controls</h2><div class="section">${state.month.checks.map((check) => `<div class="check ${check.done ? "done" : ""}"><b>${check.done ? "✓" : "!"}</b><span>${esc(check.label)}</span></div>`).join("")}</div>
    ${state.month.id ? `<button class="secondary" id="period-status" style="margin-top:12px">Set period status</button>` : ""}`;
  document.getElementById("close-week")?.addEventListener("click", () => act("week-close", { week_start: state.week_start }, "Week closed."));
  document.getElementById("period-status")?.addEventListener("click", periodDialog);
}

function wireTimer() {
  clearInterval(timerInterval);
  if (state.running) {
    const node = document.getElementById("live-clock");
    const tick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(state.running.started_at)) / 1000));
      node.textContent = `${String(Math.floor(elapsed / 3600)).padStart(2, "0")}:${String(Math.floor(elapsed % 3600 / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    };
    tick(); timerInterval = setInterval(tick, 1000);
    document.getElementById("clock-out").addEventListener("click", () => act("clock-out", {}, "Time posted to the ERP."));
  } else {
    document.getElementById("clock-in").addEventListener("click", () => {
      const task = document.getElementById("goal-select").value;
      if (!task) return toast("Select a goal contract.");
      act("clock-in", { task_id: Number(task) }, "Clock started.");
    });
  }
}

function openDialog(content, onSubmit) {
  dialogBody.innerHTML = content;
  const form = dialogBody.querySelector("form");
  form?.addEventListener("submit", (event) => { event.preventDefault(); onSubmit(new FormData(form)); });
  dialog.showModal();
}

function finishDialog(taskId, title) {
  openDialog(`<div class="dialog-title">Complete contract</div><p class="sub">${esc(title)}</p><form><div class="field"><label for="evidence">Evidence or receipt</label><input id="evidence" name="evidence" required autofocus></div><button class="primary" type="submit">Complete contract</button></form>`,
    (data) => act("task-complete", { task_id: Number(taskId), evidence: data.get("evidence") }, "Contract completed."));
}

function taskDialog(goalId, deadline) {
  openDialog(`<div class="dialog-title">Add contract</div><form><div class="field"><label for="title">Contract</label><input id="title" name="title" required autofocus></div><div class="field"><label for="due">Due</label><input id="due" name="due" type="date" value="${esc(deadline)}" required></div><button class="primary" type="submit">Add contract</button></form>`,
    (data) => act("task-create", { goal_id: Number(goalId), title: data.get("title"), due_date: data.get("due") }, "Contract added."));
}

function rateDialog() {
  openDialog(`<div class="dialog-title">Internal hourly rate</div><form><div class="field"><label for="rate">Universal rate</label><input id="rate" name="rate" type="number" min="0" step="0.01" value="${(state.rate_cents / 100).toFixed(2)}" required autofocus></div><button class="primary" type="submit">Set rate</button></form>`,
    (data) => act("rate", { hourly_rate: Number(data.get("rate")) }, "Rate updated."));
}

function periodDialog() {
  openDialog(`<div class="dialog-title">${esc(state.month.period)} period</div><form><div class="field"><label for="status">Status</label><select id="status" name="status"><option value="open">Open</option><option value="soft_closed">Soft closed</option><option value="hard_closed">Hard closed</option><option value="reopened">Reopened</option></select></div><div class="field"><label for="reason">Reason if reopening</label><input id="reason" name="reason"></div><button class="primary" type="submit">Apply</button></form>`,
    (data) => act("period-status", { period_id: state.month.id, status: data.get("status"), reason: data.get("reason") }, "Period updated."));
}

function render() {
  clearInterval(timerInterval);
  document.querySelectorAll(".dock button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  ({ now: renderNow, goals: renderGoals, money: renderMoney, close: renderClose }[view] || renderNow)();
}

document.querySelectorAll(".dock button").forEach((button) => button.addEventListener("click", () => {
  view = button.dataset.view; location.hash = view; render(); window.scrollTo({ top: 0, behavior: "smooth" });
}));
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
document.getElementById("dialog-close").addEventListener("click", () => dialog.close());
refresh().catch((error) => {
  app.innerHTML = `<section class="timer"><div class="timer-state">Unavailable</div><h1>${esc(error.message)}</h1><button class="primary" id="retry">Retry</button></section>`;
  document.getElementById("retry").addEventListener("click", () => location.reload());
});
