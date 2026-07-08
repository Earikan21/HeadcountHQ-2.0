/* Light/dark theme. Applied to <html data-theme> before first paint (this file is
 * loaded synchronously in <head>) to avoid a flash; the toggle in the sidebar footer
 * flips and persists the choice. Falls back to the OS preference when unset. */
(function () {
  var KEY = "hq_theme";
  var root = document.documentElement;
  function apply(t) { root.setAttribute("data-theme", t === "dark" ? "dark" : "light"); }

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  apply(saved || (prefersDark ? "dark" : "light"));

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    function sync() {
      var dark = root.getAttribute("data-theme") === "dark";
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.classList.toggle("on", dark);
      var lbl = btn.querySelector(".tt-label");
      if (lbl) lbl.textContent = dark ? "Dark mode" : "Light mode";
    }
    sync();
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      sync();
    });
  });
})();
