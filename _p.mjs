import { buildHeadcountModel } from "./src/domain/model.js";
import { computePnl } from "./src/domain/pnl.js";
const model = buildHeadcountModel({
  employees: [
    { employee_ext_id:"E1", department_name:"Sales", annual_salary:120000, start_date:"2020-01-01" },
  ],
  scenarioHires: [{ id:"h1", department:"Sales", role:"AE", start_month:"2026-08", annual_salary:120000 }],
  loadedMultiplier:1.2, start:{year:2026,month0:0}, months:12, now:new Date("2026-07-15"),
});
const pnl = computePnl(model, { byDept:{ Sales:{ perHead:600000, rampMonths:6 } }, quota:{ amount:1000000, departments:["Sales"] } });
console.log("nowIdx", pnl.nowIdx);
console.log("Sales perDept", pnl.perDept.find(d=>d.department==="Sales"));
console.log("total net12", pnl.total.net12, "benefit12", pnl.total.benefit12, "cost12", pnl.total.cost12);
console.log("attainment", pnl.quota.attainment, "includedBen12", pnl.quota.includedBenefit12);
console.log("cumNet last", pnl.total.cumNet[pnl.total.cumNet.length-1]);
