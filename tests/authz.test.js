import { test } from "node:test";
import assert from "node:assert/strict";
import * as az from "../src/authz.js";

const admin = { role: "finance_admin", department_id: null };
const exec = { role: "c_suite", department_id: null };
const mgr = { role: "manager", department_id: 7 };

test("compensation visibility per role", () => {
  assert.equal(az.compVisibility(admin), "exact");
  assert.equal(az.compVisibility(exec), "bands");
  assert.equal(az.compVisibility(mgr), "bands");
});

test("department scope", () => {
  assert.equal(az.departmentScope(admin), null);
  assert.equal(az.departmentScope(exec), null);
  assert.deepEqual(az.departmentScope(mgr), [7]);
});

test("canViewDepartment respects scope", () => {
  assert.equal(az.canViewDepartment(admin, 3), true);
  assert.equal(az.canViewDepartment(mgr, 7), true);
  assert.equal(az.canViewDepartment(mgr, 8), false);
});

test("scope supports collaborators who own several departments", () => {
  const owner = { role: "manager", department_ids: [3, 5] };
  assert.deepEqual(az.departmentScope(owner), [3, 5]);
  assert.equal(az.canViewDepartment(owner, 3), true);
  assert.equal(az.canViewDepartment(owner, 5), true);
  assert.equal(az.canViewDepartment(owner, 9), false);
});

test("a scoped collaborator owning nothing sees nothing", () => {
  const empty = { role: "manager", department_ids: [] };
  assert.deepEqual(az.departmentScope(empty), []);
  assert.equal(az.canViewDepartment(empty, 1), false);
});

test("account management is finance_admin only", () => {
  assert.equal(az.canManageAccounts(admin), true);
  assert.equal(az.canManageAccounts(exec), false);
  assert.equal(az.canManageAccounts(mgr), false);
});

test("approvals: admin + c_suite; requests: admin + manager", () => {
  assert.equal(az.canApproveRequests(exec), true);
  assert.equal(az.canApproveRequests(mgr), false);
  assert.equal(az.canCreateRequest(mgr), true);
  assert.equal(az.canCreateRequest(exec), false);
});
