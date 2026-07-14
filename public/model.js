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

  // ---- filters (one line: search + department scope) ----
  var fSearch = document.getElementById("f-search"), fDept = document.getElementById("f-dept");
  function applyFilters() {
    var q = (fSearch && fSearch.value || "").trim().toLowerCase();
    blocks().forEach(function (b) {
      var d = b.grp.getAttribute("data-dept");
      var anyVisible = false;
      b.prows.forEach(function (tr) {
        var name = tr.getAttribute("data-name") || "", role = tr.getAttribute("data-role") || "", dd = tr.getAttribute("data-dept") || "";
        var ok = !q || name.indexOf(q) >= 0 || role.indexOf(q) >= 0 || dd.toLowerCase().indexOf(q) >= 0;
        tr.style.display = ok && !deptCollapsed[d] ? "" : "none";
        if (ok) anyVisible = true;
      });
      b.grp.style.display = anyVisible ? "" : "none";
    });
  }
  if (fSearch) { fSearch.addEventListener("input", applyFilters); fSearch.addEventListener("change", applyFilters); }
  // Department is a server-side scope (so the annual summary + subtotals recompute).
  function scopeToDept(v) {
    var u = new URL(window.location.href);
    if (v) u.searchParams.set("dept", v); else u.searchParams.delete("dept");
    window.location.href = u.toString();
  }
  if (fDept) fDept.addEventListener("change", function () { scopeToDept(fDept.value); });
  // The assumptions section has its own department selector (same server scope).
  var asmDept = document.getElementById("asm-dept");
  if (asmDept) asmDept.addEventListener("change", function () { scopeToDept(asmDept.value); });

  // ---- column (year) collapse ----
  // The server already renders every year but the current one collapsed, so seed each
  // toggle's state from its own label rather than assuming "expanded".
  Array.prototype.forEach.call(document.querySelectorAll(".ytoggle"), function (btn) {
    var collapsed = btn.textContent.trim() === "+";
    btn.addEventListener("click", function () {
      var y = btn.getAttribute("data-year");
      collapsed = !collapsed;
      btn.textContent = collapsed ? "+" : "–";
      btn.setAttribute("aria-label", (collapsed ? "Expand " : "Collapse ") + y);
      // month/bucket cells for this year
      Array.prototype.forEach.call(sheet.querySelectorAll('[data-yb="' + y + '"]'), function (c) { c.hidden = collapsed; });
      // year-total cells for this year
      Array.prototype.forEach.call(sheet.querySelectorAll('.ytot[data-year="' + y + '"]'), function (c) { c.hidden = !collapsed; });
      // group header colspan
      var gh = sheet.querySelector('th.ygrp[data-year="' + y + '"]');
      if (gh) gh.colSpan = collapsed ? 1 : Number(gh.getAttribute("data-span")) || gh.colSpan;
    });
  });

  // ---- rename a plan: submit on Enter or blur, so there's no stray "Rename" step ----
  (function planRename() {
    var form = document.querySelector("form.pb-rename");
    if (!form) return;
    var input = form.querySelector('input[name="name"]');
    if (!input) return;
    var last = input.value;
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    input.addEventListener("blur", function () {
      var v = input.value.trim();
      if (!v || v === last) { input.value = last; return; } // empty or unchanged: no submit
      form.submit();
    });
  })();

  // ---- destructive actions ask first ----
  Array.prototype.forEach.call(document.querySelectorAll("form.confirm-delete"), function (f) {
    f.addEventListener("submit", function (ev) {
      var msg = f.getAttribute("data-confirm") || "Are you sure? This cannot be undone.";
      // "{when}" resolves to whatever end month the row's picker is showing.
      var mo = f.querySelector('input[name="end_month"]');
      if (mo) msg = msg.replace("{when}", mo.value ? "at the end of " + mo.value : "at the end of this month");
      if (!window.confirm(msg)) ev.preventDefault();
    });
  });

  // ---- open on the current month ----
  // Past years arrive collapsed, so "now" sits a short scroll in; nudge it into view
  // rather than leaving the sheet parked on the first month of history.
  (function scrollToNow() {
    var wrap = sheet.closest ? sheet.closest(".sheet-wrap") : null;
    var nowTh = sheet.querySelector('th.mc[data-now="1"]');
    if (!wrap || !nowTh || nowTh.hidden) return;
    var firstHead = sheet.querySelector("th.rowhead");
    var frozen = firstHead ? firstHead.getBoundingClientRect().width : 0;
    var left = nowTh.offsetLeft - frozen - 24;
    if (left > 0) wrap.scrollLeft = left;
  })();

  // ---- autosave (plan sheets only) -------------------------------------------
  // The browser never prices anyone. It posts one cell, and the server replies with
  // the recomputed row, department subtotal, grand total, KPIs and summary, already
  // formatted. That keeps the sheet and the CSV export honest about the same numbers.
  (function autosave() {
    var csrfEl = document.getElementById("model-csrf");
    var version = sheet.getAttribute("data-version");
    if (sheet.getAttribute("data-editable") !== "1" || !csrfEl || !version) return;
    var period = sheet.getAttribute("data-period") || "month";
    var dept = sheet.getAttribute("data-dept") || "";
    var pill = document.getElementById("save-pill");
    var pillTimer = null;

    function say(text, cls) {
      if (!pill) return;
      pill.textContent = text;
      pill.className = "save-pill " + (cls || "");
      pill.hidden = false;
      if (pillTimer) clearTimeout(pillTimer);
      if (cls !== "err") pillTimer = setTimeout(function () { pill.hidden = true; }, 1800);
    }

    function setSeries(tr, s) {
      if (!tr || !s) return;
      var cells = tr.querySelectorAll("td.mc:not(.ytot)");
      for (var i = 0; i < cells.length && i < s.cells.length; i++) {
        cells[i].textContent = s.cells[i].t;
        cells[i].setAttribute("data-v", s.cells[i].v);
      }
      Object.keys(s.yearTotals || {}).forEach(function (y) {
        var yt = tr.querySelector('td.ytot[data-year="' + y + '"]');
        if (yt) { yt.textContent = s.yearTotals[y].t; yt.setAttribute("data-v", s.yearTotals[y].v); }
      });
    }

    // Department names can contain anything; match by attribute value, not a selector.
    function deptRow(name) {
      var rows = body ? body.querySelectorAll("tr.grp[data-dept]") : [];
      for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute("data-dept") === name) return rows[i];
      return null;
    }

    function patch(input, data) {
      var tr = input.closest("tr");
      var field = input.getAttribute("data-field");

      if (data.row) {
        setSeries(tr, data.row);
        var loaded = tr.querySelector("td.loaded");
        if (loaded) loaded.textContent = data.row.loaded;
        tr.setAttribute("data-loaded", String(data.row.loaded).replace(/,/g, ""));
      }
      // keep the sort/filter attributes honest about what the row now says
      if (field === "name") tr.setAttribute("data-name", (input.value || "").toLowerCase());
      else if (field === "salary") tr.setAttribute("data-salary", input.value || "0");
      else if (field === "start") tr.setAttribute("data-start", input.value || "");
      else if (field === "end") { tr.setAttribute("data-end", input.value || ""); tr.classList.toggle("ends", !!input.value); }

      // per-field override marks: a cell edited back to its roster value stops glowing
      if (data.marks) {
        ["name", "start", "end", "salary"].forEach(function (f) {
          var td = tr.querySelector('td[data-cell="' + f + '"]');
          if (td) td.classList.toggle("ovr", !!data.marks[f]);
        });
      }
      var reset = tr.querySelector("form.row-reset"), clean = tr.querySelector(".row-clean");
      if (reset) reset.hidden = !data.overridden;
      if (clean) clean.hidden = !!data.overridden;

      if (data.dept) setSeries(deptRow(data.dept.name), data.dept);
      if (data.total) setSeries(body ? body.querySelector("tr.total-grp") : null, data.total);

      if (data.kpis) Object.keys(data.kpis).forEach(function (k) {
        var el = document.querySelector('.kpi[data-k="' + k + '"] .val');
        if (el) el.textContent = data.kpis[k];
      });

      // The summary is keyed by year, so rows are matched by name rather than position.
      if (data.summary) Object.keys(data.summary).forEach(function (year) {
        var tr = document.querySelector('#annual-summary tbody tr[data-year="' + year + '"]');
        if (!tr) return;
        var tds = tr.querySelectorAll("td");
        var vals = data.summary[year];
        for (var j = 0; j < vals.length && j + 1 < tds.length; j++) tds[j + 1].textContent = vals[j];
      });
    }

    function save(input) {
      var b = new URLSearchParams();
      b.set("_csrf", csrfEl.value);
      b.set("key", input.getAttribute("data-key"));
      b.set("field", input.getAttribute("data-field"));
      b.set("value", input.value);
      b.set("period", period);
      if (dept) b.set("dept", dept);
      say("Saving…", "");
      fetch("/model/versions/" + version + "/cell", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: b.toString()
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: "Save failed." }; });
      }).then(function (data) {
        if (!data.ok) { input.classList.add("bad"); say(data.error || "Not saved.", "err"); return; }
        input.classList.remove("bad");
        // Moving a start date can widen the window, changing how many columns and years
        // exist. The save landed; the page we're looking at is simply out of date.
        if (data.windowKey && data.windowKey !== sheet.getAttribute("data-windowkey")) {
          say("Saved — refreshing…", "ok");
          window.location.reload();
          return;
        }
        if (document.activeElement !== input) input.value = data.value; // snap to normalised
        patch(input, data);
        say("Saved", "ok");
      }).catch(function () {
        input.classList.add("bad");
        say("Network error — not saved.", "err");
      });
    }

    // "change" fires on blur / Enter / picker commit — one save per finished cell,
    // not one per keystroke.
    var timers = new WeakMap();
    Array.prototype.forEach.call(sheet.querySelectorAll("input.cell-input"), function (input) {
      var initial = input.value;
      input.addEventListener("change", function () {
        if (input.value === initial) return; // nothing actually changed
        initial = input.value;
        if (timers.get(input)) clearTimeout(timers.get(input));
        timers.set(input, setTimeout(function () { save(input); }, 150));
      });
      // Enter should commit, not submit anything
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    });
  })();

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

  // ---- input validation: warn on out-of-place values before submitting ----
  function monthOutOfRange(v) {
    if (!/^\d{4}-\d{2}$/.test(v || "")) return false;
    var y = Number(v.slice(0, 4));
    return y < 1990 || y > 2100;
  }
  Array.prototype.forEach.call(document.querySelectorAll("form[data-validate]"), function (f) {
    f.addEventListener("submit", function (ev) {
      var warnings = [];
      Array.prototype.forEach.call(f.querySelectorAll("input"), function (inp) {
        var v = (inp.value || "").trim();
        if (v === "") return;
        if (inp.getAttribute("data-check") === "salary" || inp.name === "scn_salary") {
          var n = Number(v);
          if (!isFinite(n) || n < 0) warnings.push("The salary can't be negative.");
          else if (n > 50000000) warnings.push("That salary looks like a typo (over $50M).");
        }
        if (inp.getAttribute("type") === "month" && monthOutOfRange(v)) warnings.push("The date " + v + " looks out of range (expected a year 1990-2100).");
      });
      var st = f.querySelector('input[name="scn_start"]'), en = f.querySelector('input[name="scn_end"]');
      if (st && en && st.value && en.value && en.value < st.value) warnings.push("The end month is before the start month.");
      if (warnings.length && !window.confirm(warnings.join("\n") + "\n\nAdd it anyway?")) ev.preventDefault();
    });
  });

  // ---- popups (data-open-modal="X" opens #X-modal; scrim/close/Esc dismiss) ----
  Array.prototype.forEach.call(document.querySelectorAll("[data-open-modal]"), function (btn) {
    btn.addEventListener("click", function () {
      var name = btn.getAttribute("data-open-modal");
      var m = document.getElementById(name + "-modal") || document.getElementById(name);
      if (m) m.hidden = false;
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".modal-scrim"), function (scrim) {
    scrim.addEventListener("click", function (e) { if (e.target === scrim) scrim.hidden = true; });
    Array.prototype.forEach.call(scrim.querySelectorAll("[data-close-modal]"), function (b) {
      b.addEventListener("click", function () { scrim.hidden = true; });
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") Array.prototype.forEach.call(document.querySelectorAll(".modal-scrim:not([hidden])"), function (m) { m.hidden = true; });
  });
  // Reopen the Excel-link popup after creating a token (the ensure route adds ?excel=1).
  if (/[?&]excel=1(&|$)/.test(window.location.search)) {
    var xl = document.getElementById("excel-link-modal");
    if (xl) { xl.hidden = false; var f = xl.querySelector("input.mono"); if (f) f.select && f.select(); }
  }
})();
