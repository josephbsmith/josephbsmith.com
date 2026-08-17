#!/usr/bin/env python3
"""Export the live Personal ERP into one idempotent D1 bootstrap migration."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return f"X'{value.hex()}'"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: export_erp_d1.py SOURCE.db OUTPUT.sql")
    source, output = Path(sys.argv[1]), Path(sys.argv[2])
    conn = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    tables = [row["name"] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    indexes = [row["sql"] for row in conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")]
    schema = [conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()["sql"]
        for table in tables]
    order = [
        "settings", "households", "ledger_accounts", "accounting_periods",
        "people", "locations", "cost_centers", "service_lines", "funding_sources",
        "tax_treatments", "vendors", "account_dimension_rules", "bank_accounts",
        "asset_classes", "assets", "maintenance_events", "debt_accounts",
        "journal_entries", "journal_entry_lines", "month_end_statements",
        "matching_rules", "imported_transactions", "bank_reconciliations",
        "depreciation_runs", "interest_accruals", "debt_payments", "budget_versions",
        "budget_lines", "goals", "commitments", "purchase_requests",
        "scenario_versions", "forecast_assumptions", "kpi_definitions", "kpi_results",
        "chapter_goals", "goal_tasks", "goal_time_entries", "goal_task_settlements",
        "goal_week_closes", "goal_cash_accounts", "audit_events",
    ]
    out = [
        "-- Personal ERP production bootstrap — generated from the live reconciled SQLite book.",
        "PRAGMA defer_foreign_keys = ON;",
        "",
        *[statement + ";\n" for statement in schema],
        "CREATE TABLE IF NOT EXISTS auth_attempts (",
        "  key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,",
        "  blocked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL",
        ");\n",
    ]
    for table in order:
        if table not in tables:
            continue
        rows = conn.execute(f'SELECT * FROM "{table}"').fetchall()
        if not rows:
            continue
        columns = [d[0] for d in conn.execute(f'SELECT * FROM "{table}" LIMIT 0').description]
        quoted = ",".join(f'"{column}"' for column in columns)
        for row in rows:
            values = ",".join(sql_value(row[column]) for column in columns)
            out.append(f'INSERT INTO "{table}" ({quoted}) VALUES ({values});')
        out.append("")
    out.extend(statement + ";" for statement in indexes)
    out.append("")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(out), encoding="utf-8")
    conn.close()


if __name__ == "__main__":
    main()
