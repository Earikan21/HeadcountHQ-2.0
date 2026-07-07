/* Financial model interactions (Directive 4.0): zoom, sortable columns, and
 * search / department / salary filters. Vanilla JS, no dependencies. */
(function () {
  var sheet = document.getElementById("model-sheet");
  if (!sheet) return;

  // ---- zoom (persisted) ----
  var lvl = document.getElementById("zoom-lvl"), zout = document.getElementById("zoom-out"), zin = document.getElementById("zoom-in");
  var z = 1; try { z = parseFloat(localStorage.getItem("hq_model_zoom") || "1") || 1; } catch (e) {}
  function applyZoom() { sheet.style.zoom = z; if (lvl) lvl.textContent = Math.round(z * 100) + "%"; try { localStorage.setItem("hq_model_zoom", String(z)); } catch (e) {} }
  function setZoom(v) { z = Math.max(0.5, Math.min(1.6, Math.round(v * 20) / 20)); applyZoom(); }
  if (zout) zout.addEventListener("click", function () { setZoom(z - 0.1); });
  if (zin) zin.addEventListener("click", function () { setZoom(z + 0.1); });
  applyZoom();

  var body = document.getElementById("roster-body");
  function rows() { return body ? Array.prototype.slice.call(body.querySelectorAll("tr.prow")) : []; }

  // ---- filters ----
  var fSearch = document.getElementById("f-search"), fDept = document.getElementById("f-dept"), fMin = document.getElementById("f-min"), fMax = document.getElementById("f-max");
  function applyFilters() {
    var q = (fSearch && fSearch.value || "").trim().toLowerCase();
    var dept = (fDept && fDept.value) || "";
    var min = fMin && fMin.value !== "" ? Number(fMin.value) : null;
    var max = fMax && fMax.value !== "" ? Number(fMax.value) : null;
    rows().forEach(function (tr) {
      var name = tr.getAttribute("data-name") || "", role = tr.getAttribute("data-role") || "", d = tr.getAttribute("data-dept") || "", sal = Number(tr.getAttribute("data-salary") || 0);
      var ok = true;
      if (q && name.indexOf(q) < 0 && role.indexOf(q) < 0 && d.toLowerCase().indexOf(q) < 0) ok = false;
      if (dept && d !== dept) ok = false;
      if (min != null && sal < min) ok = false;
      if (max != null && sal > max) ok = false;
      tr.style.display = ok ? "" : "none";
    });
  }
  [fSearch, fDept, fMin, fMax].forEach(function (el) { if (el) { el.addEventListener("input", applyFilters); el.addEventListener("change", applyFilters); } });

  // ---- sort ----
  var dir = {};
  function cellVal(tr, key, type) {
    var v = tr.getAttribute("data-" + key);
    if (v == null) v = "";
    return type === "num" ? (Number(v) || 0) : String(v).toLowerCase();
  }
  Array.prototype.slice.call(sheet.querySelectorAll("th.sortable")).forEach(function (th) {
    th.classList.add("clickable");
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-sort"), type = th.getAttribute("data-type");
      var d = dir[key] === "asc" ? "desc" : "asc"; dir = {}; dir[key] = d;
      Array.prototype.slice.call(sheet.querySelectorAll("th.sortable")).forEach(function (h) { h.removeAttribute("data-dir"); });
      th.setAttribute("data-dir", d);
      var rs = rows();
      rs.sort(function (a, b) {
        var va = cellVal(a, key, type), vb = cellVal(b, key, type);
        if (va < vb) return d === "asc" ? -1 : 1;
        if (va > vb) return d === "asc" ? 1 : -1;
        return 0;
      });
      rs.forEach(function (tr) { body.appendChild(tr); });
    });
  });
})();
