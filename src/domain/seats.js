/**
 * Seat lifecycle — pure logic, no DB. A SEAT is a budgeted, approved position
 * that exists independently of whoever fills it (Directive 2.0 §2.1). One code
 * path models seats; the workspace settings only pick the vacancy branch.
 *
 *   proposed → approved → open → filled
 *                              ↘ (occupant leaves) → open | frozen | closed
 *                  frozen → approved (re-approve) → open → filled
 *   (any non-closed) → closed
 */

export const SEAT_STATUSES = ["proposed", "approved", "open", "filled", "frozen", "closed"];

/** A seat counts toward APPROVED headcount once approved and not yet closed. */
const APPROVED_STATUSES = new Set(["approved", "open", "filled", "frozen"]);

export const SEAT_MODES = ["seat", "person"];
export const BACKFILL_POLICIES = ["auto", "reapprove"];

/** Allowed transitions (excluding the settings-driven vacate, handled below). */
const TRANSITIONS = {
  proposed: ["approved", "closed"],
  approved: ["open", "frozen", "closed"],
  open:     ["filled", "frozen", "closed"],
  filled:   ["open", "frozen", "closed"], // vacate resolves to one of these
  frozen:   ["approved", "open", "closed"],
  closed:   [],
};

export function canTransition(from, to) {
  return SEAT_STATUSES.includes(to) && (TRANSITIONS[from] || []).includes(to);
}

/**
 * Resolve what happens to a FILLED seat when its occupant leaves, given the
 * workspace settings. This is the single decision point the settings govern.
 *   - person mode            → seat closes (headcount dissolves)
 *   - seat mode + auto       → seat reopens (ready to backfill)
 *   - seat mode + reapprove  → seat freezes (needs re-approval before refill)
 */
export function nextStatusOnVacate({ seatMode, backfillPolicy }) {
  if (seatMode === "person") return "closed";
  return backfillPolicy === "reapprove" ? "frozen" : "open";
}

/** Roll up seats into approved/active/open/frozen counts (per the caller's grouping). */
export function countSeats(seats) {
  const byStatus = { proposed: 0, approved: 0, open: 0, filled: 0, frozen: 0, closed: 0 };
  for (const s of seats) if (s.status in byStatus) byStatus[s.status] += 1;
  let approved = 0;
  for (const st of APPROVED_STATUSES) approved += byStatus[st];
  return {
    total: seats.length,
    approved,                 // headcount that cleared approval and isn't closed
    active: byStatus.filled,  // seats currently filled
    open: byStatus.open,
    frozen: byStatus.frozen,
    proposed: byStatus.proposed,
    closed: byStatus.closed,
    byStatus,
  };
}

/** Active-vs-approved ratio (0..1), guarding divide-by-zero. */
export function fillRate(counts) {
  return counts.approved ? counts.active / counts.approved : 0;
}
