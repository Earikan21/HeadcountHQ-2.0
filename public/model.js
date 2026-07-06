/* Financial model zoom control (Directive 4.0). Uses CSS `zoom` on the grid and
 * remembers the level. No dependencies. */
(function () {
  var sheet = document.getElementById("model-sheet");
  var lvl = document.getElementById("zoom-lvl");
  var out = document.getElementById("zoom-out");
  var inc = document.getElementById("zoom-in");
  if (!sheet) return;
  var z = 1;
  try { z = parseFloat(localStorage.getItem("hq_model_zoom") || "1") || 1; } catch (e) {}
  function apply() {
    sheet.style.zoom = z;
    if (lvl) lvl.textContent = Math.round(z * 100) + "%";
    try { localStorage.setItem("hq_model_zoom", String(z)); } catch (e) {}
  }
  function set(v) { z = Math.max(0.5, Math.min(1.6, Math.round(v * 20) / 20)); apply(); }
  if (out) out.addEventListener("click", function () { set(z - 0.1); });
  if (inc) inc.addEventListener("click", function () { set(z + 0.1); });
  apply();
})();
