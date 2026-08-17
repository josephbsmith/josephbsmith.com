const CAMPAIGN_START = "2026-08-17";
const CAMPAIGN_END = "2027-05-05";
const DEFAULT_RATE = 10_000;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function localDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateNumber(value) {
  return Date.parse(`${value}T00:00:00Z`);
}

function weekStart(value = localDate()) {
  const day = new Date(`${value}T00:00:00Z`);
  const mondayIndex = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - mondayIndex);
  return day.toISOString().slice(0, 10);
}

function campaignWeek(today) {
  const week = Math.floor((dateNumber(today) - dateNumber(CAMPAIGN_START)) / 604_800_000) + 1;
  return Math.max(1, Math.min(38, week));
}

function audit(db, entityType, entityId, action, value) {
  return db.prepare("INSERT INTO audit_events(entity_type,entity_id,action,new_value,actor,source) VALUES(?,?,?,?,?,?)")
    .bind(entityType, entityId ?? null, action, JSON.stringify(value), "Joseph", "smith_os");
}

async function setting(db, key, fallback) {
  const row = await db.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return row ? Number(row.value) : fallback;
}

async function state(db) {
  const today = localDate();
  const week = weekStart(today);
  const period = today.slice(0, 7);
  const [goalsResult, running, totals, settlements, eligible, accountsResult, journalsResult,
    commitments, closeRow, periodRow, statementCounts, unreviewed, trial] = await Promise.all([
    db.prepare(`SELECT g.*,t.id task_id,t.title task_title,t.due_date task_due_date,t.is_extra_time,
      COALESCE(w.minutes,0) week_minutes,COALESCE(w.amount,0) week_accrued,
      COALESCE(a.minutes,0) total_minutes,
      COALESCE(a.amount,0) total_accrued,COALESCE(s.amount,0) settled_cents
      FROM chapter_goals g
      LEFT JOIN goal_tasks t ON t.goal_id=g.id AND t.status='active'
      LEFT JOIN (SELECT t.goal_id,SUM(e.minutes) minutes,SUM(e.accrued_cents) amount FROM goal_time_entries e JOIN goal_tasks t ON t.id=e.task_id WHERE e.status='posted' AND e.week_start=? GROUP BY t.goal_id) w ON w.goal_id=g.id
      LEFT JOIN (SELECT t.goal_id,SUM(e.minutes) minutes,SUM(e.accrued_cents) amount FROM goal_time_entries e JOIN goal_tasks t ON t.id=e.task_id WHERE e.status='posted' GROUP BY t.goal_id) a ON a.goal_id=g.id
      LEFT JOIN (SELECT t.goal_id,SUM(s.amount_cents) amount FROM goal_task_settlements s JOIN goal_tasks t ON t.id=s.task_id GROUP BY t.goal_id) s ON s.goal_id=g.id
      ORDER BY g.number`).bind(week).all(),
    db.prepare("SELECT e.*,t.title,g.number FROM goal_time_entries e JOIN goal_tasks t ON t.id=e.task_id JOIN chapter_goals g ON g.id=t.goal_id WHERE e.status='running'").first(),
    db.prepare("SELECT COALESCE(SUM(accrued_cents),0) accrued FROM goal_time_entries WHERE status='posted'").first(),
    db.prepare("SELECT COALESCE(SUM(amount_cents),0) settled FROM goal_task_settlements").first(),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN je.status IN ('posted','reversed') THEN l.debit_cents-l.credit_cents ELSE 0 END),0) amount
      FROM journal_entry_lines l JOIN journal_entries je ON je.id=l.entry_id
      WHERE l.account_id IN (SELECT ba.gl_account_id FROM bank_accounts ba JOIN goal_cash_accounts gca ON gca.bank_account_id=ba.id)`).first(),
    db.prepare(`SELECT a.code,a.name,a.type,a.normal_balance,
      COALESCE(SUM(CASE WHEN je.status IN ('posted','reversed') THEN l.debit_cents-l.credit_cents ELSE 0 END),0) raw
      FROM ledger_accounts a LEFT JOIN journal_entry_lines l ON l.account_id=a.id
      LEFT JOIN journal_entries je ON je.id=l.entry_id WHERE a.type!='statistical'
      GROUP BY a.id HAVING raw<>0 ORDER BY a.code`).all(),
    db.prepare(`SELECT je.id,je.entry_date,je.memo,je.source,
      COALESCE(SUM(l.debit_cents),0) amount_cents FROM journal_entries je
      LEFT JOIN journal_entry_lines l ON l.entry_id=je.id
      WHERE je.status IN ('posted','reversed') GROUP BY je.id ORDER BY je.entry_date DESC,je.id DESC LIMIT 8`).all(),
    db.prepare("SELECT COALESCE(SUM(amount_cents),0) amount FROM commitments WHERE status IN ('planned','approved','committed')").first(),
    db.prepare("SELECT * FROM goal_week_closes WHERE week_start=?").bind(week).first(),
    db.prepare("SELECT * FROM accounting_periods WHERE label=?").bind(period).first(),
    db.prepare("SELECT COUNT(*) count,COALESCE(SUM(status='reconciled'),0) reconciled FROM month_end_statements WHERE period_label=?").bind(period).first(),
    db.prepare(`SELECT COUNT(*) count FROM imported_transactions t JOIN month_end_statements s ON s.id=t.statement_id
      WHERE s.period_label=? AND t.status='unreviewed'`).bind(period).first(),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN je.status IN ('posted','reversed') THEN l.debit_cents ELSE 0 END),0) debit,
      COALESCE(SUM(CASE WHEN je.status IN ('posted','reversed') THEN l.credit_cents ELSE 0 END),0) credit
      FROM journal_entry_lines l JOIN journal_entries je ON je.id=l.entry_id WHERE je.entry_date<=?`)
      .bind(periodRowEnd(period)).first(),
  ]);
  const completedDays = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const goals = goalsResult.results.map((goal) => {
    const paceMinutes = Math.floor(goal.weekly_target_minutes * completedDays / 7);
    const behind = (goal.task_due_date && goal.task_due_date < today) || goal.week_minutes < paceMinutes;
    return { ...goal, pace_minutes: paceMinutes, pace_status: behind ? "behind" : "on_track" };
  });
  const accrued = totals.accrued || 0;
  const settled = settlements.settled || 0;
  const accounts = accountsResult.results.map((account) => ({
    ...account,
    balance_cents: account.normal_balance === "credit" ? -account.raw : account.raw,
  }));
  const assets = accounts.filter((a) => a.type === "asset").reduce((sum, a) => sum + a.raw, 0);
  const liabilities = accounts.filter((a) => a.type === "liability").reduce((sum, a) => sum - a.raw, 0);
  const liquid = accounts.filter((a) => ["10100", "10200", "10300", "10400"].includes(a.code))
    .reduce((sum, a) => sum + a.raw, 0);
  const startSavings = await setting(db, "eligible_savings_start_cents", 3_000_000);
  const targetSavings = await setting(db, "eligible_savings_target_cents", 7_500_000);
  const elapsed = Math.max(0, Math.min(dateNumber(today) - dateNumber(CAMPAIGN_START), dateNumber(CAMPAIGN_END) - dateNumber(CAMPAIGN_START)));
  const savingsPace = startSavings + Math.floor((targetSavings - startSavings) * elapsed / (dateNumber(CAMPAIGN_END) - dateNumber(CAMPAIGN_START)));
  const weekRows = goals.map((goal) => ({ number: goal.number, outcome: goal.outcome,
    minutes: goal.week_minutes, accrued_cents: goal.week_accrued }));
  return {
    now: new Date().toISOString(), today, week_start: week, week_number: campaignWeek(today),
    days_left: Math.max(0, Math.floor((dateNumber(CAMPAIGN_END) - dateNumber(today)) / 86_400_000)),
    rate_cents: await setting(db, "goal_hourly_rate_cents", DEFAULT_RATE), running, goals,
    liability_cents: accrued - settled, completed_capital_cents: settled,
    eligible_savings_cents: eligible.amount || 0, savings_pace_cents: savingsPace,
    savings_target_cents: targetSavings, liquid_cash_cents: liquid,
    external_commitments_cents: commitments.amount || 0,
    contract_adjusted_capital_cents: liquid - (commitments.amount || 0) - (accrued - settled),
    finances: { assets_cents: assets, liabilities_cents: liabilities, net_worth_cents: assets - liabilities,
      accounts, journals: journalsResult.results },
    week: { rows: weekRows, closed: closeRow },
    month: { id: periodRow?.id || null, period, status: periodRow?.status || "missing", checks: [
      { label: "Goal timer stopped", done: !running },
      { label: "Statements reconciled", done: statementCounts.count > 0 && statementCounts.count === statementCounts.reconciled },
      { label: "No unreviewed transactions", done: unreviewed.count === 0 },
      { label: "Trial balance balances", done: trial.debit === trial.credit },
    ] },
  };
}

function periodRowEnd(period) {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

async function body(request) {
  if (!request.headers.get("Content-Type")?.includes("application/json")) throw new Error("JSON required.");
  return request.json();
}

async function clockIn(db, data) {
  const taskId = Number(data.task_id);
  const task = await db.prepare("SELECT t.id,t.status,g.number FROM goal_tasks t JOIN chapter_goals g ON g.id=t.goal_id WHERE t.id=?")
    .bind(taskId).first();
  if (!task || task.status !== "active") throw new Error("Choose an active goal contract.");
  if (await db.prepare("SELECT 1 found FROM goal_time_entries WHERE status='running'").first()) throw new Error("A timer is already running.");
  const week = weekStart();
  if (await db.prepare("SELECT 1 found FROM goal_week_closes WHERE week_start=?").bind(week).first()) throw new Error("This week is closed.");
  const rate = await setting(db, "goal_hourly_rate_cents", DEFAULT_RATE);
  const started = new Date().toISOString();
  const result = await db.prepare("INSERT INTO goal_time_entries(task_id,started_at,hourly_rate_cents,week_start) VALUES(?,?,?,?)")
    .bind(taskId, started, rate, week).run();
  await audit(db, "goal_time_entry", result.meta.last_row_id, "clock_in", { task_id: taskId, goal: task.number, week_start: week }).run();
  return { id: result.meta.last_row_id, started_at: started };
}

async function clockOut(db) {
  const row = await db.prepare(`SELECT e.*,t.title,g.number FROM goal_time_entries e JOIN goal_tasks t ON t.id=e.task_id
    JOIN chapter_goals g ON g.id=t.goal_id WHERE e.status='running'`).first();
  if (!row) throw new Error("No timer is running.");
  const ended = new Date();
  const seconds = Math.max(0, Math.floor((ended.getTime() - Date.parse(row.started_at)) / 1000));
  const minutes = Math.max(1, Math.floor((seconds + 30) / 60));
  const accrued = Math.floor((row.hourly_rate_cents * minutes + 30) / 60);
  await db.batch([
    db.prepare("UPDATE goal_time_entries SET ended_at=?,minutes=?,accrued_cents=?,status='posted' WHERE id=?")
      .bind(ended.toISOString(), minutes, accrued, row.id),
    audit(db, "goal_time_entry", row.id, "clock_out", { minutes, accrued_cents: accrued }),
  ]);
  return { minutes, accrued_cents: accrued, goal: row.number, title: row.title };
}

async function completeTask(db, data) {
  const taskId = Number(data.task_id);
  const evidence = String(data.evidence || "").trim();
  if (!evidence) throw new Error("Add the proof location or completion receipt.");
  const task = await db.prepare("SELECT * FROM goal_tasks WHERE id=?").bind(taskId).first();
  if (!task || task.status !== "active") throw new Error("Only an active contract can be completed.");
  if (await db.prepare("SELECT 1 found FROM goal_time_entries WHERE task_id=? AND status='running'").bind(taskId).first()) throw new Error("Clock out first.");
  const totals = await db.prepare("SELECT COALESCE(SUM(minutes),0) minutes,COALESCE(SUM(accrued_cents),0) amount FROM goal_time_entries WHERE task_id=? AND status='posted'")
    .bind(taskId).first();
  const stamp = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO goal_task_settlements(task_id,minutes,amount_cents,evidence,settled_at) VALUES(?,?,?,?,?)")
      .bind(taskId, totals.minutes, totals.amount, evidence, stamp),
    db.prepare("UPDATE goal_tasks SET status='complete',evidence=?,completed_at=? WHERE id=?")
      .bind(evidence, stamp, taskId),
    audit(db, "goal_task", taskId, "complete", { minutes: totals.minutes, settled_cents: totals.amount, evidence }),
  ]);
  return totals;
}

async function createTask(db, data) {
  const goalId = Number(data.goal_id);
  const title = String(data.title || "").trim();
  const due = String(data.due_date || "");
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("Title and due date are required.");
  if (await db.prepare("SELECT 1 found FROM goal_tasks WHERE goal_id=? AND status='active'").bind(goalId).first()) throw new Error("Complete the current contract first.");
  const goal = await db.prepare("SELECT number FROM chapter_goals WHERE id=?").bind(goalId).first();
  if (!goal) throw new Error("Goal not found.");
  const result = await db.prepare("INSERT INTO goal_tasks(goal_id,title,due_date) VALUES(?,?,?)").bind(goalId, title, due).run();
  await audit(db, "goal_task", result.meta.last_row_id, "create", { goal: goal.number, title, due_date: due }).run();
  return { id: result.meta.last_row_id };
}

async function setRate(db, data) {
  const cents = Math.round(Number(data.hourly_rate) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Enter a valid hourly rate.");
  await db.batch([
    db.prepare("INSERT INTO settings(key,value) VALUES('goal_hourly_rate_cents',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(cents)),
    audit(db, "setting", null, "goal_rate", { hourly_rate_cents: cents }),
  ]);
  return { hourly_rate_cents: cents };
}

async function closeWeek(db, data) {
  const week = String(data.week_start || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || weekStart(week) !== week) throw new Error("Choose a Monday week start.");
  if (await db.prepare("SELECT 1 found FROM goal_week_closes WHERE week_start=?").bind(week).first()) throw new Error("That week is already closed.");
  if (await db.prepare("SELECT 1 found FROM goal_time_entries WHERE week_start=? AND status='running'").bind(week).first()) throw new Error("Clock out first.");
  const totals = await db.prepare("SELECT COALESCE(SUM(minutes),0) minutes,COALESCE(SUM(accrued_cents),0) amount FROM goal_time_entries WHERE week_start=? AND status='posted'")
    .bind(week).first();
  const stamp = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO goal_week_closes(week_start,total_minutes,accrued_cents,closed_at) VALUES(?,?,?,?)")
      .bind(week, totals.minutes, totals.amount, stamp),
    audit(db, "goal_week", null, "close", { week_start: week, minutes: totals.minutes, amount: totals.amount }),
  ]);
  return totals;
}

async function periodStatus(db, data) {
  const id = Number(data.period_id);
  const status = String(data.status || "");
  const reason = String(data.reason || "").trim();
  if (!['open', 'soft_closed', 'hard_closed', 'reopened'].includes(status)) throw new Error("Invalid period status.");
  if (status === 'reopened' && !reason) throw new Error("Reopening requires a reason.");
  const period = await db.prepare("SELECT * FROM accounting_periods WHERE id=?").bind(id).first();
  if (!period) throw new Error("Period not found.");
  await db.batch([
    db.prepare("UPDATE accounting_periods SET status=?,closed_at=?,reopened_reason=? WHERE id=?")
      .bind(status, status.includes('closed') ? new Date().toISOString() : null, status === 'reopened' ? reason : null, id),
    audit(db, "accounting_period", id, "status", { status, reason }),
  ]);
  return { period: period.label, status };
}

export async function onRequest(context) {
  const { request, env } = context;
  const raw = context.params.path;
  const path = Array.isArray(raw) ? raw.join("/") : String(raw || "state");
  try {
    if (request.method === "GET" && path === "state") return json(await state(env.DB));
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const data = await body(request);
    const actions = {
      "clock-in": clockIn, "clock-out": clockOut, "task-complete": completeTask,
      "task-create": createTask, "rate": setRate, "week-close": closeWeek,
      "period-status": periodStatus,
    };
    if (!actions[path]) return json({ error: "Not found." }, 404);
    return json({ ok: true, result: await actions[path](env.DB, data) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed." }, 400);
  }
}
