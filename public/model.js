/* Financial model interactions (Directive 4.0): zoom, sort, filters, and Excel-
 * style collapsible rows (by department) and columns (by year). Vanilla JS. */
(function () {
  var sheet = document.getElementById("model-sheet");
  if (!sheet) return;
  var body = document.getElementById("roster-body");

  // ---- zoom (persisted) ----
  var lvl = document.getElementById("zoom-lvl"), zout = document.getElementById("zoom-out"), zin = document.getElementById("zoom-in");
  var z = 1; try { z = parseFloat(localStorage.getItem("hq_model_zoom") || "1") || 1; } catch (e) {}
  function applyZoom() { sheet.style.zoom = z; if (lvl) lvl.textContent = Math.round(z * 100) + "%"; try { localStorage.setItem("hq_model_zoom", String(z)); } catch (e) {} }
  function setZoom(v) { z = Math.max(0.5, Math.min(1.6, Math.round(v * 20) / 20)); applyZoom(); }
  if (zout) zout.addEventListener("click", function () { setZoom(z - 0.1); });
  if (zin) zin.addEventListener("click", function () { setZoom(z + 0.1); });
  applyZoom();

  function prows() { return body ? Array.prototype.slice.call(body.querySelectorAll("tr.prow")) : []; }
  function groupRows() { return body ? Array.prototype.slice.call(body.querySelectorAll("tr.grp[data-dept]")) : []; }

  // ---- department row grouping / blocks ----
  function blocks() {
    var out = [], cur = null;
    Array.prototype.forEach.call(body ? body.children : [], function (tr) {
      if (tr.classList.contains("grp") && tr.hasAttribute("data-dept")) { cur = { grp: tr, prows: [] }; out.push(cur); }
      else if (tr.classList.contains("prow") && cur) cur.prows.push(tr);
    });
    return out;
  }

  // collapse / expand a department
  var deptCollapsed = {};
  Array.prototype.forEach.call(document.querySelectorAll(".grptoggle"), function (btn) {
    btn.addEventListener("click", function () {
      var d = btn.getAttribute("data-dept");
      deptCollapsed[d] = !deptCollapsed[d];
      btn.textContent = deptCollapsed[d] ? "▸" : "▾";
      applyFilters();
    });
  });

  // ---- filters ----
  var fSearch = document.getElementById("f-search"), fDept = document.getElementById("f-dept"), fMin = document.getElementById("f-min"), fMax = document.getElementById("f-max");
  function applyFilters() {
    var q = (fSearch && fSearch.value || "").trim().toLowerCase();
    var min = fMin && fMin.value !== "" ? Number(fMin.value) : null;
    var max = fMax && fMax.value !== "" ? Number(fMax.value) : null;
    blocks().forEach(function (b) {
      var d = b.grp.getAttribute("data-dept");
      var anyVisible = false;
      b.prows.forEach(function (tr) {
        var name = tr.getAttribute("data-name") || "", role = tr.getAttribute("data-role") || "", dd = tr.getAttribute("data-dept") || "", sal = Number(tr.getAttribute("data-salary") || 0);
        var ok = true;
        if (q && name.indexOf(q) < 0 && role.indexOf(q) < 0 && dd.toLowerCase().indexOf(q) < 0) ok = false;
        if (min != null && sal < min) ok = false;
        if (max != null && sal > max) ok = false;
        if (ok && deptCollapsed[d]) { tr.style.display = "none"; }
        else { tr.style.display = ok ? "" : "none"; }
        if (ok) anyVisible = true;
      });
      b.grp.style.display = anyVisible ? "" : "none";
    });
  }
  [fSearch, fMin, fMax].forEach(function (el) { if (el) { el.addEventListener("input", applyFilters); el.addEventListener("change", applyFilters); } });
  // Department is a server-side scope (so the annual summary + subtotals recompute).
  if (fDept) fDept.addEventListener("change", function () {
    var u = new URL(window.location.href);
    if (fDept.value) u.searchParams.set("dept", fDept.value); else u.searchParams.delete("dept");
    window.location.href = u.toString();
  });

  // ---- column (year) collapse ----
  Array.prototype.forEach.call(document.querySelectorAll(".ytoggle"), function (btn) {
    var collapsed = false;
    btn.addEventListener("click", function () {
      var y = btn.getAttribute("data-year");
      collapsed = !collapsed;
      btn.textContent = collapsed ? "+" : "–";
      // month/bucket cells for this year
      Array.prototype.forEach.call(sheet.querySelectorAll('[data-yb="' + y + '"]'), function (c) { c.hidden = collapsed; });
      // year-total cells for this year
      Array.prototype.forEach.call(sheet.querySelectorAll('.ytot[data-year="' + y + '"]'), function (c) { c.hidden = !collapsed; });
      // group header colspan
      var gh = sheet.querySelector('th.ygrp[data-year="' + y + '"]');
      if (gh) gh.colSpan = collapsed ? 1 : Number(gh.getAttribute("data-span")) || gh.colSpan;
    });
  });

  // ---- sort (within each department block) ----
  var dir = {};
  function cellVal(tr, key, type) { var v = tr.getAttribute("data-" + key); if (v == null) v = ""; return type === "num" ? (Number(v) || 0) : String(v).toLowerCase(); }
  Array.prototype.forEach.call(sheet.querySelectorAll("th.sortable"), function (th) {
    th.classList.add("clickable");
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-sort"), type = th.getAttribute("data-type");
      var d = dir[key] === "asc" ? "desc" : "asc"; dir = {}; dir[key] = d;
      Array.prototype.forEach.call(sheet.querySelectorAll("th.sortable"), function (h) { h.removeAttribute("data-dir"); });
      th.setAttribute("data-dir", d);
      blocks().forEach(function (b) {
        b.prows.sort(function (a, c) {
          var va = cellVal(a, key, type), vc = cellVal(c, key, type);
          if (va < vc) return d === "asc" ? -1 : 1;
          if (va > vc) return d === "asc" ? 1 : -1;
          return 0;
        });
        var after = b.grp;
        b.prows.forEach(function (tr) { after.parentNode.insertBefore(tr, after.nextSibling); after = tr; });
      });
    });
  });
})();
