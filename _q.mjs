import { buildHeadcountModel } from "./src/domain/model.js";
import { modelMatrixCells } from "./src/domain/model_export.js";
import { periodBuckets } from "./src/domain/model.js";
const model = buildHeadcountModel({
  employees:[{ employee_ext_id:"E1", name:"A", department_name:"Sales", annual_salary:120000, start_date:"2020-01-01" }],
  loadedMultiplier:1.2, start:{year:2026,month0:0}, months:12, now:new Date("2026-07-15"),
});
const monthly = modelMatrixCells(model);
const quarterly = modelMatrixCells(model, periodBuckets(model.cols, "quarter"));
console.log("monthly header cols:", monthly[0].length, monthly[0].slice(12));
console.log("quarterly header cols:", quarterly[0].length, quarterly[0].slice(12));
console.log("quarterly data row (from L on):", quarterly[1].slice(11));
console.log("quarterly TOTAL:", quarterly[2].slice(11));
