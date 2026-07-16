import { buildHeadcountModel } from "./src/domain/model.js";
import { pnlTemplateRows } from "./src/domain/pnl_template.js";
const model = buildHeadcountModel({
  employees: [
    { employee_ext_id:"E1", name:"A", department_name:"Engineering", annual_salary:120000, start_date:"2020-01-01" },
    { employee_ext_id:"E2", name:"B", department_name:"Engineering", annual_salary:120000, start_date:"2020-01-01" },
    { employee_ext_id:"E3", name:"C", department_name:"Sales", annual_salary:60000, start_date:"2020-01-01" },
  ],
  loadedMultiplier:1.2, start:{year:2026,month0:0}, months:6, now:new Date("2026-07-15"),
});
const rows = pnlTemplateRows(model, ["Engineering","Sales"]);
rows.forEach((r,i)=>console.log((i+1)+": "+r.slice(0,5).join(" | ")));
