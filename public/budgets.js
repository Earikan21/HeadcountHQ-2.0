// Live cost-impact estimate as headcount allocations change (CSP: same-origin).
(function () {
  function fmt(n) {
    n = Math.round(n);
    var a = Math.abs(n);
    if (a >= 1e6) return "$" + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
    if (a >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + n;
  }
  document.querySelectorAll("input[data-current]").forEach(function (input) {
    var current = +input.dataset.current || 0;
    var low = +input.dataset.bandLow || 0, high = +input.dataset.bandHigh || 0;
    var out = document.getElementById(input.dataset.expectedTarget);
    if (!out) return;
    input.addEventListener("input", function () {
      var add = Math.max(0, (+input.value || 0) - current);
      if (add > 0 && low > 0) { out.textContent = "+ expected " + fmt(add * low) + "–" + fmt(add * high); out.classList.add("on"); }
      else { out.textContent = ""; out.classList.remove("on"); }
    });
  });
})();
