/**
 * @file routes/audit.ts
 *
 * Audit log replay and export endpoints.
 *
 * GET  /api/audit                  — paginated query of the audit stream
 * GET  /api/audit/orders/:orderId  — full timeline for one order
 * GET  /api/audit/export           — NDJSON export (streaming)
 * GET  /api/audit/tail             — most recent N entries (live monitoring)
 *
 * All endpoints are read-only.  The audit log is append-only and is never
 * mutated through these routes.
 *
 * Query params for GET /api/audit:
 *   orderId      Filter to a specific order
 *   eventTypes   Comma-separated list of event type strings
 *   since        Unix seconds (start of window, inclusive)
 *   until        Unix seconds (end of window, inclusive)
 *   limit        Page size (default 100, max 1000)
 *   afterId      Cursor — return entries with id > this value
 *   count        "true" to include totalCount in the response
 *
 * Query params for GET /api/audit/export:
 *   Same filters as above, plus:
 *   pageSize     Batch size used while streaming (default 500)
 */

import { Router, type Request, type Response } from "express";
import type { Logger } from "pino";
import type { AuditRepository } from "../../audit/audit-repo.js";
import type { AuditExporter } from "../../audit/audit-exporter.js";
import type { AuditEventType } from "../../audit/audit-log.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseIntParam(val: unknown, defaultVal: number, max?: number): number {
  const n = val !== undefined ? parseInt(String(val), 10) : defaultVal;
  const safe = isNaN(n) ? defaultVal : n;
  return max !== undefined ? Math.min(safe, max) : safe;
}

function parseEventTypes(val: unknown): AuditEventType[] | undefined {
  if (!val || typeof val !== 'string') return undefined;
  const parts = val.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? (parts as AuditEventType[]) : undefined;
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function auditRoutes(
  repo: AuditRepository,
  exporter: AuditExporter,
  log: Logger,
): Router {
  const router = Router();

  /**
   * GET /api/audit
   * Paginated query of the audit stream with optional filters.
   */
  router.get('/audit', async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = parseIntParam(req.query['limit'], 100, 1000);
      const afterId = req.query['afterId'] !== undefined
        ? parseIntParam(req.query['afterId'], 0)
        : undefined;
      const since = req.query['since'] !== undefined
        ? parseIntParam(req.query['since'], 0)
        : undefined;
      const until = req.query['until'] !== undefined
        ? parseIntParam(req.query['until'], 0)
        : undefined;
      const orderId = typeof req.query['orderId'] === 'string'
        ? req.query['orderId']
        : undefined;
      const eventTypes = parseEventTypes(req.query['eventTypes']);
      const includeCount = req.query['count'] === 'true';

      const page = await repo.query({
        orderId,
        eventTypes,
        since,
        until,
        limit,
        cursor: afterId !== undefined ? { afterId } : undefined,
        includeCount,
      });

      res.json({
        entries: page.entries,
        nextCursor: page.nextCursor ? page.nextCursor.afterId : null,
        totalCount: page.totalCount,
      });
    } catch (err) {
      log.error({ err }, 'audit query failed');
      res.status(500).json({ error: 'internal_error', message: 'audit query failed' });
    }
  });

  /**
   * GET /api/audit/orders/:orderId
   * Full event timeline for a specific order, oldest-first.
   */
  router.get('/audit/orders/:orderId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId } = req.params;
      if (!orderId || typeof orderId !== 'string') {
        res.status(400).json({ error: 'bad_request', message: 'orderId is required' });
        return;
      }

      const entries = await exporter.orderTimeline(orderId);

      res.json({
        orderId,
        entries,
        count: entries.length,
      });
    } catch (err) {
      log.error({ err }, 'audit timeline query failed');
      res.status(500).json({ error: 'internal_error', message: 'audit timeline query failed' });
    }
  });

  /**
   * GET /api/audit/orders/:orderId/validate
   * Validate that the stored audit sequence is consistent with the
   * order state machine.  Returns any discrepancies found.
   */
  router.get('/audit/orders/:orderId/validate', async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId } = req.params;
      if (!orderId || typeof orderId !== 'string') {
        res.status(400).json({ error: 'bad_request', message: 'orderId is required' });
        return;
      }

      const discrepancies = await exporter.validateOrderSequences([orderId]);

      res.json({
        orderId,
        valid: discrepancies.length === 0,
        discrepancies,
      });
    } catch (err) {
      log.error({ err }, 'audit validation failed');
      res.status(500).json({ error: 'internal_error', message: 'audit validation failed' });
    }
  });

  /**
   * GET /api/audit/tail
   * Most recent N audit entries — useful for live monitoring dashboards.
   * Query param: n (default 50, max 500)
   */
  router.get('/audit/tail', async (req: Request, res: Response): Promise<void> => {
    try {
      const n = parseIntParam(req.query['n'], 50, 500);
      const entries = await repo.tail(n);
      res.json({ entries, count: entries.length });
    } catch (err) {
      log.error({ err }, 'audit tail query failed');
      res.status(500).json({ error: 'internal_error', message: 'audit tail query failed' });
    }
  });

  /**
   * GET /api/audit/export
   * Stream the audit log as NDJSON (newline-delimited JSON).
   *
   * Each line is a JSON object representing one audit entry with its payload
   * already parsed (not raw JSON string) — the output is self-contained and
   * requires no database connection to consume.
   *
   * The response streams as Transfer-Encoding: chunked so large exports do not
   * buffer in memory.
   *
   * Optional cursor param `afterId` allows incremental exports: save the last
   * id you received, pass it as afterId on the next call to get only new entries.
   */
  router.get('/audit/export', async (req: Request, res: Response): Promise<void> => {
    try {
      const afterId = req.query['afterId'] !== undefined
        ? parseIntParam(req.query['afterId'], 0)
        : undefined;
      const since = req.query['since'] !== undefined
        ? parseIntParam(req.query['since'], 0)
        : undefined;
      const until = req.query['until'] !== undefined
        ? parseIntParam(req.query['until'], 0)
        : undefined;
      const orderId = typeof req.query['orderId'] === 'string'
        ? req.query['orderId']
        : undefined;
      const eventTypes = parseEventTypes(req.query['eventTypes']);
      const pageSize = parseIntParam(req.query['pageSize'], 500, 2000);

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      // Tell clients the last cursor id so they can resume.
      // The actual value is sent as a trailing X-Audit-Final-Cursor header
      // once the stream completes.

      const result = await exporter.exportNdjson(res, {
        orderId,
        eventTypes,
        since,
        until,
        pageSize,
        resumeCursor: afterId !== undefined ? { afterId } : undefined,
      });

      // Append a metadata sentinel line at the end of the stream so clients
      // can detect a clean end-of-stream and extract the final cursor without
      // parsing HTTP trailers.
      const sentinel = JSON.stringify({
        _sentinel: true,
        entriesExported: result.entriesProcessed,
        finalCursorId: result.finalCursor?.afterId ?? null,
      }) + '\n';
      res.end(sentinel);

      log.info(
        { entriesExported: result.entriesProcessed, finalCursorId: result.finalCursor?.afterId },
        'audit export completed',
      );
    } catch (err) {
      log.error({ err }, 'audit export failed');
      // If headers already sent (partial stream), we can only close the conn.
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', message: 'audit export failed' });
      } else {
        res.end();
      }
    }
  });

  return router;
}
