/**
 * LPO first-party ad-attribution capture. Included on lonepeakoverland.com:
 *   <script src="https://lpo-sales-engine.vercel.app/attr.js" defer></script>
 *
 * Persists UTMs + ad click IDs (gclid/gbraid/wbraid/fbclid/msclkid/ttclid)
 * for 90 days as first-touch (set once) + last-touch (updated only on visits
 * that carry new params — a later direct visit never erases a paid click).
 * Stamps them into: Klaviyo profile properties (attr_*), Shopify cart
 * attributes (→ order note_attributes → our CRM), and outbound Typeform
 * links (→ hidden fields). Everything is fail-silent.
 */
(function () {
  "use strict";
  var KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
              "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"];
  var STORE = "lpo_attr";
  var TTL_MS = 90 * 24 * 3600 * 1000;

  function readParams() {
    try {
      var q = new URLSearchParams(location.search);
      var out = {};
      var found = false;
      for (var i = 0; i < KEYS.length; i++) {
        var v = q.get(KEYS[i]);
        if (v) { out[KEYS[i]] = v.slice(0, 200); found = true; }
      }
      if (!found) return null;
      out.lp = (location.origin + location.pathname).slice(0, 300);
      if (document.referrer && document.referrer.indexOf(location.hostname) === -1) {
        out.ref = document.referrer.slice(0, 300);
      }
      out.at = new Date().toISOString();
      return out;
    } catch (e) { return null; }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return {};
      var d = JSON.parse(raw);
      // Expire the whole record off first-touch age.
      if (d.first && d.first.at && Date.now() - Date.parse(d.first.at) > TTL_MS) return {};
      return d && typeof d === "object" ? d : {};
    } catch (e) { return {}; }
  }

  function save(d) {
    try { localStorage.setItem(STORE, JSON.stringify(d)); } catch (e) {}
    try {
      // Cookie mirror (apex domain) so other subdomains can read it too.
      var host = location.hostname.split(".").slice(-2).join(".");
      document.cookie = STORE + "=" + encodeURIComponent(JSON.stringify(d)) +
        ";path=/;domain=." + host + ";max-age=" + Math.floor(TTL_MS / 1000) + ";SameSite=Lax";
    } catch (e) {}
  }

  // Persistent visitor id — the tiny pointer that identity events carry so
  // the server can link this browser's touch history to a contact.
  var vid = null;
  try {
    vid = localStorage.getItem("lpo_vid");
    if (!vid) {
      vid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : "v-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2, 10);
      localStorage.setItem("lpo_vid", vid);
    }
  } catch (e) {}

  var attr = load();
  var fresh = readParams();
  if (fresh) {
    if (!attr.first) attr.first = fresh;
    attr.last = fresh; // last NON-DIRECT touch: only param-carrying visits update it
    // Full touch history (multi-touch journeys for pre-purchase leads).
    // Skip repeats of the same source+campaign within 30 min (reloads).
    var touches = attr.touches || [];
    var prev = touches[touches.length - 1];
    var isDup = prev && prev.utm_source === fresh.utm_source && prev.utm_campaign === fresh.utm_campaign &&
      prev.gclid === fresh.gclid && prev.fbclid === fresh.fbclid &&
      prev.at && (Date.parse(fresh.at) - Date.parse(prev.at)) < 30 * 60 * 1000;
    if (!isDup) {
      touches.push(fresh);
      while (touches.length > 20) touches.shift();
      attr.touches = touches;
    }
    save(attr);
  } else if (!attr.first && document.referrer && document.referrer.indexOf(location.hostname) === -1) {
    // Organic first visit: record landing/referrer so "organic" is explicit.
    attr.first = { lp: (location.origin + location.pathname).slice(0, 300),
                   ref: document.referrer.slice(0, 300), at: new Date().toISOString() };
    save(attr);
  }
  // Beacon unsynced touches DIRECTLY to our app (no third-party porting).
  // text/plain body → simple CORS request, no preflight; fire-and-forget.
  (function syncTouches() {
    try {
      if (!vid || !attr.touches || attr.touches.length === 0) return;
      var synced = 0;
      try { synced = parseInt(localStorage.getItem("lpo_attr_synced") || "0", 10) || 0; } catch (e) {}
      if (synced >= attr.touches.length) return;
      var pending = attr.touches.slice(synced);
      fetch("https://lpo-sales-engine.vercel.app/api/attr/touch", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ vid: vid, touches: pending }),
        keepalive: true,
      }).then(function (r) {
        if (r.ok) try { localStorage.setItem("lpo_attr_synced", String(attr.touches.length)); } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  })();

  if (!attr.first) return; // nothing to propagate

  function flat() {
    var out = {};
    var f = attr.first || {}, l = attr.last || {};
    var map = { utm_source: "source", utm_medium: "medium", utm_campaign: "campaign",
                utm_content: "content", utm_term: "term" };
    Object.keys(map).forEach(function (k) {
      if (f[k]) out["attr_first_" + map[k]] = f[k];
      if (l[k]) out["attr_last_" + map[k]] = l[k];
    });
    ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"].forEach(function (k) {
      if (l[k]) out["attr_" + k] = l[k];
      else if (f[k]) out["attr_" + k] = f[k];
    });
    if (f.lp) out.attr_landing = f.lp;
    if (f.ref) out.attr_referrer = f.ref;
    if (f.at) out.attr_first_at = f.at;
    if (l.at) out.attr_last_at = l.at;
    return out;
  }
  var props = flat();
  // Identity events carry only the visitor-id pointer — the touch history
  // itself lives in our app via the beacon above.
  if (vid) props.attr_vid = vid;

  // ── Klaviyo profile stamp (merges onto the anonymous profile; sticks when
  //    the visitor later identifies via any form/checkout) ──
  var tries = 0;
  (function stampKlaviyo() {
    try {
      var k = window.klaviyo || window._learnq;
      if (k && typeof k.push === "function") { k.push(["identify", props]); return; }
    } catch (e) {}
    if (++tries < 20) setTimeout(stampKlaviyo, 1500);
  })();

  // ── Shopify cart attributes (→ order.note_attributes → CRM) ──
  function stampCart() {
    try {
      var sig = STORE + "_stamped";
      fetch("/cart.js", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cart) {
          if (!cart || !cart.token) return;
          var mark = cart.token + ":" + (props.attr_last_at || props.attr_first_at || "");
          if (localStorage.getItem(sig) === mark) return;
          var attributes = {};
          Object.keys(props).forEach(function (k) { attributes[k] = String(props[k]); });
          fetch("/cart/update.js", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ attributes: attributes }),
          }).then(function (r) { if (r.ok) try { localStorage.setItem(sig, mark); } catch (e) {} });
        })
        .catch(function () {});
    } catch (e) {}
  }
  if (location.hostname.indexOf("lonepeakoverland") !== -1) stampCart();

  // ── Typeform link decoration (→ declared hidden fields) ──
  document.addEventListener("click", function (ev) {
    try {
      var a = ev.target && ev.target.closest ? ev.target.closest("a[href*='typeform.com']") : null;
      if (!a) return;
      var u = new URL(a.href);
      var f = attr.first || {}, l = attr.last || {};
      KEYS.forEach(function (k) {
        var v = l[k] || f[k];
        if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
      });
      if (vid && !u.searchParams.has("vid")) u.searchParams.set("vid", vid);
      a.href = u.toString();
    } catch (e) {}
  }, true);
})();
