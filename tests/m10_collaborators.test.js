import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/database.js";
import { migrateToLatest } from "../src/db/migrate.js";
import { createDepartment } from "../src/repos/departments.js";
import { createUserWithPassword } from "../src/repos/users.js";
import { departmentIdsForUser, setDepartmentsForUser } from "../src/repos/collaborators.js";
import {
  setDelegatedBudget, getDelegatedBudget, ownerReconciliation,
  companyDelegation, setEnvelope, setCompanyBudget,
} from "../src/repos/budgets.js";
import { listEmployees } from "../src/repos/roster.js";
import { ROLE_LABELS } from "../src/authz.js";

const PW = "pw-abcdefghij";
function freshDb() { const db = openDb(":memory:"); migrateToLatest(db); return db; }
function addEmployee(db, ext, name, deptId) {
  db.prepare("INSERT INTO employees (employee_ext_id, name, department_id, employment_status) VALUES (?,?,?, 'active')").run(ext, name, deptId);
}
const mgr = (db, email, deptId) =>
  createUserWithPassword(db, { email, name: email, role: "manager", password: PW, departmentId: deptId });

test("Finance Admin role is now labelled 'Finance Manager'", () => {
  assert.equal(ROLE_LABELS.finance_admin, "Finance Manager");
});

test("creating a collaborator with a department populates the canonical join", () => {
  const db = freshDb();
  const eng = createDepartment(db, { name: "Engineering" });
  const u = mgr(db, "a@x.co", eng.id);
  assert.deepEqual(departmentIdsForUser(db, u.id), [eng.id]);
  db.close();
});

test("an owner can hold several departments; the set is replaceable", () => {
  const db = freshDb();
  const a = createDepartment(db, { name: "Photonics" });
  const b = createDepartment(db, { name: "Chemistry" });
  const c = createDepartment(db, { name: "Mechanical" });
  const owner = mgr(db, "o@x.co", a.id);
  setDepartmentsForUser(db, owner.id, [a.id, b.id, c.id]);
  assert.deepEqual(departmentIdsForUser(db, owner.id).slice().sort((x, y) => x - y), [a.id, b.id, c.id]);
  setDepartmentsForUser(db, owner.id, [b.id]);
  assert.deepEqual(departmentIdsForUser(db, owner.id), [b.id]);
  const row = db.prepare("SELECT department_id FROM users WHERE id=?").get(owner.id);
  assert.equal(row.department_id, b.id, "legacy column follows the first owned dept");
  db.close();
});

test("scope-as-set: listing is limited to exactly the departments owned", () => {
  const db = freshDb();
  const a = createDepartment(db, { name: "A" });
  const b = createDepartment(db, { name: "B" });
  const c = createDepartment(db, { name: "C" });
  addEmployee(db, "E1", "Ann", a.id);
  addEmployee(db, "E2", "Bob", b.id);
  addEmployee(db, "E3", "Cara", c.id);
  assert.deepEqual(listEmployees(db, { departmentId: [a.id, b.id] }).map((e) => e.name).sort(), ["Ann", "Bob"]);
  assert.deepEqual(listEmployees(db, { departmentId: [a.id] }).map((e) => e.name), ["Ann"]);
  assert.deepEqual(listEmployees(db, { departmentId: [] }), [], "owns nothing -> sees nobody");
  assert.equal(listEmployees(db, { departmentId: null }).length, 3, "company-wide -> everyone");
  db.close();
});

test("delegated pool: single pool split across the owner's departments, with over-allocation", () => {
  const db = freshDb();
  const a = createDepartment(db, { name: "A" });
  const b = createDepartment(db, { name: "B" });
  const owner = mgr(db, "o@x.co", a.id);
  setDepartmentsForUser(db, owner.id, [a.id, b.id]);
  setDelegatedBudget(db, owner.id, 10, 1000000, owner.id);
  const pool0 = getDelegatedBudget(db, owner.id);
  assert.equal(pool0.headcount_budget, 10);
  assert.equal(pool0.money_budget, 1000000);
  setEnvelope(db, a.id, 6, 600000, owner.id);
  setEnvelope(db, b.id, 3, 300000, owner.id);
  let rec = ownerReconciliation(db, owner.id);
  assert.equal(rec.allocation.headcount.allocated, 9);
  assert.equal(rec.allocation.headcount.remaining, 1);
  assert.equal(rec.allocation.headcount.over, 0);
  assert.equal(rec.allocation.money.allocated, 900000);
  setEnvelope(db, b.id, 8, 300000, owner.id); // now 6+8 = 14 > pool of 10
  rec = ownerReconciliation(db, owner.id);
  assert.equal(rec.allocation.headcount.allocated, 14);
  assert.equal(rec.allocation.headcount.over, 4);
  db.close();
});

test("company delegation: sum of owner pools reconciled against the company budget", () => {
  const db = freshDb();
  const u1 = mgr(db, "1@x.co", createDepartment(db, { name: "A" }).id);
  const u2 = mgr(db, "2@x.co", createDepartment(db, { name: "B" }).id);
  setCompanyBudget(db, 20, 2000000, u1.id);
  setDelegatedBudget(db, u1.id, 12, 1200000, u1.id);
  setDelegatedBudget(db, u2.id, 6, 600000, u1.id);
  let cd = companyDelegation(db);
  assert.equal(cd.delegated.headcount, 18);
  assert.equal(cd.remaining.headcount, 2);
  assert.equal(cd.over.headcount, 0);
  setDelegatedBudget(db, u2.id, 12, 600000, u1.id); // 12+12 = 24 > cap of 20
  cd = companyDelegation(db);
  assert.equal(cd.delegated.headcount, 24);
  assert.equal(cd.over.headcount, 4);
  db.close();
});
