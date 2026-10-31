/**
 * session — tracks live authenticated connections so an inbound message
 * can be routed to its recipient's socket (or reported as
 * RECIPIENT_OFFLINE — the gateway always tells the sender which).
 *
 * DESIGN NOTE (STEP 21 — race conditions): DuoSpace is 1:1 calling, and
 * per callLatency.ts's own doc comment, "single slot, not a list" is
 * already this codebase's established pattern for one-active-call state
 * (see DuoSpaceConnectionService.kt). This registry mirrors that: one
 * live socket per user id, not a list — a fresh connection from the
 * same user (reconnect, or a second device/tab) REPLACES the previous
 * one rather than both being tracked, and the old socket is closed. This
 * is a deliberate simplification, not an accident — see
 * docs/calling-architecture-v2.md's "Known limitations" for the explicit
 * multi-device tradeoff this makes (a second device of the same user
 * will NOT receive WebSocket offers; it is reachable through push only).
 *
 * PHASE 4: the registry is now transport-agnostic. It stores a
 * `GatewayConnection` (see below) rather than a `ws` WebSocket, so the
 * gateway's routing/authorization logic is unit-testable without opening
 * a real socket, and server.ts is reduced to an adapter around `ws`.
 */

/** The minimal surface the gateway needs from a live connection. */
export interface GatewayConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
}

interface Session {
  userId: string;
  conn: GatewayConnection;
  connectedAt: number;
}

export class SessionRegistry {
  private byUserId = new Map<string, Session>();

  register(userId: string, conn: GatewayConnection): void {
    const existing = this.byUserId.get(userId);
    if (existing && existing.conn !== conn) {
      try { existing.conn.close(4000, "replaced_by_new_connection"); } catch { /* already closed */ }
    }
    this.byUserId.set(userId, { userId, conn, connectedAt: Date.now() });
  }

  unregister(userId: string, conn: GatewayConnection): void {
    const existing = this.byUserId.get(userId);
    // Only remove if this call is for the CURRENTLY registered
    // connection — an old socket's delayed close event must not evict a
    // newer connection that already replaced it (same stale-event guard
    // shape as callLatency.ts's traceId check).
    if (existing && existing.conn === conn) {
      this.byUserId.delete(userId);
    }
  }

  getConnection(userId: string): GatewayConnection | null {
    return this.byUserId.get(userId)?.conn ?? null;
  }

  /** True only if the user has a registered connection that is still open. */
  isOnline(userId: string): boolean {
    const c = this.byUserId.get(userId)?.conn;
    return !!c && c.isOpen();
  }

  size(): number {
    return this.byUserId.size;
  }

  /** Snapshot of every registered connection (heartbeat/shutdown use). */
  connections(): GatewayConnection[] {
    return Array.from(this.byUserId.values(), (s) => s.conn);
  }
}
