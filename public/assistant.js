/* Floating assistant widget (Directive 4.0). Posts questions to /assistant/ask
 * (same-origin, cookies + CSRF) and renders the answer. No dependencies. */
(function () {
  var fab = document.getElementById("ai-fab");
  var panel = document.getElementById("ai-panel");
  var closeBtn = document.getElementById("ai-close");
  var form = document.getElementById("ai-form");
  var q = document.getElementById("ai-q");
  var log = document.getElementById("ai-log");
  var csrfEl = document.getElementById("ai-csrf");
  var csrf = csrfEl ? csrfEl.value : "";
  if (!fab || !panel || !form) return;

  fab.addEventListener("click", function () {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && q) q.focus();
  });
  if (closeBtn) closeBtn.addEventListener("click", function () { panel.hidden = true; });

  function add(cls, text) {
    var d = document.createElement("div");
    d.className = "ai-msg " + cls;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = (q.value || "").trim();
    if (!text) return;
    add("me", text);
    q.value = "";
    var pending = add("ai", "Thinking…");
    var body = new URLSearchParams();
    body.set("question", text);
    body.set("_csrf", csrf);
    fetch("/assistant/ask", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }).then(function (r) {
      return r.json().catch(function () { return { error: "Something went wrong." }; });
    }).then(function (data) {
      pending.textContent = data.answer || data.error || "No answer.";
    }).catch(function () {
      pending.textContent = "Network error — please try again.";
    });
  });
})();
