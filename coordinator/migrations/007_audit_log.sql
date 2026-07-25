-- Migration: 007_audit_log (SQLite)
--
-- Adds a durable, append-only audit log table to the coordinator database.
--
-- Design notes:
--   * Rows are NEVER updated or deleted — this is a forensic record.
--   * created_at is set by the DB so the value is independent of app clock drift.
--   * schema_version allows consumers to detect payload shape changes.
--   * order_id / request_id are nullable correlation anchors (not FK references)
--     so the audit log survives even if the orders row is later archived or
--     hard-deleted.
--   * payload_json stores the typed AuditPayload object (see audit-log.ts).
--     Keeping it as TEXT avoids JSON column limitations in older SQLite builds
--     while still being queryable via json_extract() in SQLite 3.38+.

CREATE TABLE IF NOT EXISTS audit_log (
    id             INTEGER  PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER  NOT NULL DEFAULT 1,
    event_type     TEXT     NOT NULL,
    -- Correlation anchors (nullable — system/reconciliation events have no order)
    order_id       TEXT,
    request_id     TEXT,
    -- Typed payload serialised as JSON
    payload_json   TEXT     NOT NULL,
    created_at     INTEGER  NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- Primary query pattern: fetch all entries for a specific order in time order.
CREATE INDEX IF NOT EXISTS idx_audit_log_order_id
    ON audit_log (order_id, id ASC)
    WHERE order_id IS NOT NULL;

-- Secondary query pattern: replay stream from a cursor position (id > X).
CREATE INDEX IF NOT EXISTS idx_audit_log_id_asc
    ON audit_log (id ASC);

-- Operational query: filter by event type for monitoring / alerting.
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type
    ON audit_log (event_type, created_at DESC);

-- Time-window queries used by the exporter (since / until filters).
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON audit_log (created_at DESC);
