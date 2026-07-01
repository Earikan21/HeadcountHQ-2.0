import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/domain/seats.js";

test("vacate resolves by mode + backfill policy", () => {
  assert.equal(S.nextStatusOnVacate({ seatMode: "person", backfillPolicy: "auto" }), "closed");
  assert.equal(S.nextStatusOnVacate({ seatMode: "seat", backfillPolicy: "auto" }), "open");
  assert.equal(S.nextStatusOnVacate({ seatMode: "seat", backfillPolicy: "reapprove" }), "frozen");
  // person mode ignores backfill policy entirely
  assert.equal(S.nextStatusOnVacate({ seatMode: "person", backfillPolicy: "reapprove" }), "closed");
});

test("transition rules", () => {
  assert.ok(S.canTransition("proposed", "approved"));
  assert.ok(S.canTransition("open", "filled"));
  assert.ok(S.canTransition("frozen", "approved"));
  assert.ok(!S.canTransition("closed", "open"));      // closed is terminal
  assert.ok(!S.canTransition("proposed", "filled"));  // must be approved/open first
  assert.ok(!S.canTransition("open", "bogus"));
});

test("countSeats: approved excludes proposed+closed; active = filled", () => {
  const seats = [
    { status: "proposed" }, { status: "approved" }, { status: "open" },
    { status: "filled" }, { status: "filled" }, { status: "frozen" }, { status: "closed" },
  ];
  const c = S.countSeats(seats);
  assert.equal(c.total, 7);
  assert.equal(c.active, 2);             // two filled
  assert.equal(c.approved, 5);           // approved(1)+open(1)+filled(2)+frozen(1), excludes proposed+closed
  assert.equal(c.open, 1);
  assert.equal(c.frozen, 1);
});

test("fillRate guards divide-by-zero", () => {
  assert.equal(S.fillRate({ approved: 0, active: 0 }), 0);
  assert.equal(S.fillRate({ approved: 4, active: 2 }), 0.5);
});
