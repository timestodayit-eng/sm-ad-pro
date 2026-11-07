import type { PoolConnection } from 'mysql2/promise';
import { execute } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export interface AuditEntry {
  orgId?: number | null;
  actorUserId?: number | null;
  actorKind?: 'user' | 'ai' | 'system' | 'scheduler';
  action: string;
  targetType?: string;
  targetId?: string | number;
  details?: Record<string, unknown>;
  correlationId?: string;
  ip?: string;
}

/** Append-only audit log. Callers pass a transaction connection when the audit must commit with the change. */
export async function audit(entry: AuditEntry, conn?: PoolConnection): Promise<void> {
  try {
    await execute(
      `INSERT INTO audit_logs (org_id, actor_user_id, actor_kind, action, target_type, target_id, details, correlation_id, ip)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        entry.orgId ?? null,
        entry.actorUserId ?? null,
        entry.actorKind ?? 'user',
        entry.action,
        entry.targetType ?? null,
        entry.targetId != null ? String(entry.targetId) : null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.correlationId ?? null,
        entry.ip ?? null,
      ],
      conn,
    );
  } catch (err) {
    if (conn) throw err; // inside a transaction the change must not commit without its audit row
    logger.error({ err, action: entry.action }, 'audit write failed');
  }
}
