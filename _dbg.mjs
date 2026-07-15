import { openDb } from "./src/db/database.js";
import { migrateToLatest } from "./src/db/migrate.js";
import { createPlan, planHires, setPlanHires, getPlan, nextHireId } from "./src/repos/plans.js";
import { listDepartments } from "./src/repos/departments.js";

const db = openDb(":memory:"); migrateToLatest(db);
const A = createPlan(db, "Plan A"); const B = createPlan(db, "Plan B");
console.log("A id", A.id, "B id", B.id);
// add a Sales hire to Plan A
const hA = planHires(getPlan(db, A.id));
hA.push({ id: nextHireId(hA), department: "Sales", role: "SDR", start_month: "2027-03", annual_salary: 120000 });
setPlanHires(db, A.id, hA);

for (const id of [A.id, B.id]) {
  const plan = getPlan(db, id);
  const existing = planHires(plan);
  const planDepts = [...new Set(existing.map(h => String(h.department||"").trim()).filter(Boolean))];
  const realDepts = listDepartments(db).map(d => d.name);
  console.log(`plan ${plan.name}: existingHires=${existing.length}, planDepts=[${planDepts}], departments=[${[...new Set([...realDepts, ...planDepts])]}]`);
}
