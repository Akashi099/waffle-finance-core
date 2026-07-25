-- Migration: 007_audit_log (PostgreSQL)
--
-- Equivalent of 007_audit_log.sql for the PostgreSQL backend.
-- See that file for design notes.

CREATE TABLE IF NOT EXISTS audit_log (
    id             BIGSERIAL    PRIMARY KEY,
    schema_version INTEGER      NOT NULL DEFAULT 1,
    event_type     TEXT         NOT NULL,
    order_id       TEXT,
    request_id     TEXT,
    payload_json   TEXT         NOT NULL,
    created_at     INTEGER      NOT NULL
                                DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_order_id
    ON audit_log (order_id, id ASC)
    WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_id_asc
    ON audit_log (id ASC);

CREATE INDEX IF NOT EXISTS idx_audit_log_event_type
    ON audit_log (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON audit_log (created_at DESC);
