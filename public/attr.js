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
 *
 * v2 (10/2026): also records what the visitor DOES — page views with active
 * dwell time, scroll depth and the sections they actually saw, plus named
 * interactions (buttons, links, videos, accordions, tabs, forms) — batched
 * to our app with sendBeacon so nothing blocks the page. Meta's _fbp/_fbc
 * cookies ride along for server-side conversion matching.
 */
(function () {
  "use strict";
  var KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
              "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"];
  var STORE = "lpo_attr";
  var TTL_MS = 90 * 24 * 3600 * 1000;

  function cookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]).slice(0, 200) : null;
    } catch (e) { return null; }
  }

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
      // Meta's browser id / click cookies (set by the Meta pixel) — the
      // server-side match keys for Conversions API events later.
      var fbp = cookie("_fbp"); if (fbp) out.fbp = fbp;
      var fbc = cookie("_fbc"); if (fbc) out.fbc = fbc;
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

  // First-party identity capture: any email submitted anywhere on the page
  // (builder save, newsletter, checkout forms) links this browser's touch
  // history to the person DIRECTLY — Klaviyo's anonymous-profile merge only
  // sticks when the identify goes through Klaviyo JS, which the builder
  // doesn't do. Fire-and-forget; deduped per email.
  (function captureIdentity() {
    if (!vid) return;
    function send(email) {
      try {
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
        var key = "lpo_attr_ident";
        try { if (localStorage.getItem(key) === email) return; localStorage.setItem(key, email); } catch (e) {}
        fetch("https://lpo-sales-engine.vercel.app/api/attr/identify", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ vid: vid, email: email }),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    }
    function fromField(t) {
      try {
        if (t && t.matches && t.matches('input[type="email"], input[name*="email" i], input[autocomplete="email"]') && t.value) {
          send(t.value.trim().toLowerCase());
        }
      } catch (e) {}
    }
    document.addEventListener("submit", function (ev) {
      try {
        var f = ev.target;
        var inp = f && f.querySelector && f.querySelector('input[type="email"], input[name*="email" i], input[autocomplete="email"]');
        if (inp && inp.value) send(inp.value.trim().toLowerCase());
      } catch (e) {}
    }, true);
    document.addEventListener("focusout", function (ev) { fromField(ev.target); }, true);
  })();

  // ── Behavior tracking (v2) ──────────────────────────────────────────────
  // What this browser does on the site, keyed by vid so it stitches onto the
  // contact (retroactively too) once they identify. Batched; sent with
  // sendBeacon on hide/unload and every 15s while there is something queued.
  (function behavior() {
    if (!vid || !window.navigator) return;
    var ENDPOINT = "https://lpo-sales-engine.vercel.app/api/attr/events";
    var MAX_PER_PAGE = 150;
    var queue = [], sent = 0;
    var path = location.pathname.slice(0, 300);
    var title = (document.title || "").slice(0, 200);

    // Session: 30-min idle gap starts a new one.
    var sid = null;
    try {
      var raw = sessionStorage.getItem("lpo_sid");
      var rec = raw ? JSON.parse(raw) : null;
      if (rec && rec.id && Date.now() - rec.t < 30 * 60 * 1000) sid = rec.id;
      if (!sid) sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "s-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2, 8);
      sessionStorage.setItem("lpo_sid", JSON.stringify({ id: sid, t: Date.now() }));
    } catch (e) { sid = sid || "s-" + Date.now().toString(16); }
    function touchSession() { try { sessionStorage.setItem("lpo_sid", JSON.stringify({ id: sid, t: Date.now() })); } catch (e) {} }

    function push(ev) {
      if (sent + queue.length >= MAX_PER_PAGE) return;
      ev.at = new Date().toISOString();
      ev.p = path;
      queue.push(ev);
      touchSession();
    }

    function flush() {
      if (!queue.length) return;
      var batch = queue.splice(0, 50);
      sent += batch.length;
      var body = JSON.stringify({ vid: vid, sid: sid, ua: (navigator.userAgent || "").slice(0, 200), fbp: cookie("_fbp"), fbc: cookie("_fbc"), events: batch });
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }))) return;
      } catch (e) {}
      try { fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body, keepalive: true }).catch(function () {}); } catch (e) {}
    }

    // Page view.
    var extRef = document.referrer && document.referrer.indexOf(location.hostname) === -1 ? document.referrer.slice(0, 300) : null;
    push({ t: "pv", ti: title, r: extRef });

    // Active dwell: seconds while visible AND the user did something in the last 60s.
    var active = 0, lastInput = Date.now(), tick = null;
    function onInput() { lastInput = Date.now(); }
    ["mousemove", "keydown", "scroll", "touchstart", "click"].forEach(function (n) { document.addEventListener(n, onInput, { passive: true, capture: true }); });
    tick = setInterval(function () {
      if (document.visibilityState === "visible" && Date.now() - lastInput < 60000) active++;
    }, 1000);

    // Scroll depth.
    var maxScroll = 0;
    function depth() {
      try {
        var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
        var pct = h > 0 ? Math.min(100, Math.round(((window.scrollY || 0) / h) * 100)) : 100;
        if (pct > maxScroll) maxScroll = pct;
      } catch (e) {}
    }
    window.addEventListener("scroll", depth, { passive: true });
    setTimeout(depth, 1500);

    // Sections seen: a section counts once it has been ≥50% visible for 2s.
    // Label = its first heading, so "Pricing", "Specs", "Gallery" read naturally.
    var seen = [], seenSet = {};
    try {
      if (window.IntersectionObserver) {
        var timers = {};
        function label(el) {
          var h = el.querySelector("h1, h2, h3, [class*='heading'], [class*='title']");
          var txt = h ? (h.textContent || "").trim().replace(/\s+/g, " ") : "";
          if (!txt) txt = el.getAttribute("aria-label") || el.id || "";
          return txt.slice(0, 60);
        }
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            var el = en.target, k = el.__lpoKey || (el.__lpoKey = Math.random().toString(16).slice(2));
            if (en.isIntersecting && en.intersectionRatio >= 0.5) {
              if (!timers[k]) timers[k] = setTimeout(function () {
                var l = label(el);
                if (l && !seenSet[l] && seen.length < 40) { seenSet[l] = 1; seen.push(l); }
              }, 2000);
            } else if (timers[k]) { clearTimeout(timers[k]); timers[k] = null; }
          });
        }, { threshold: [0.5] });
        var secs = document.querySelectorAll("section, [id^='shopify-section'], main > div[id], article");
        for (var i = 0; i < secs.length && i < 120; i++) io.observe(secs[i]);
      }
    } catch (e) {}

    // Interactions.
    function text(el) { return ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80); }
    document.addEventListener("click", function (ev) {
      try {
        var t = ev.target; if (!t || !t.closest) return;
        var a = t.closest("a[href]");
        if (a) {
          var href = a.getAttribute("href") || "";
          if (/^tel:/i.test(href)) return push({ t: "ix", n: "tel", d: href.replace(/^tel:/i, "").slice(0, 40) });
          if (/^mailto:/i.test(href)) return push({ t: "ix", n: "mail", d: href.replace(/^mailto:/i, "").slice(0, 80) });
          var u; try { u = new URL(a.href, location.href); } catch (e) { return; }
          var txt = text(a);
          if (u.hostname !== location.hostname) return push({ t: "ix", n: "outbound", d: (u.hostname + u.pathname).slice(0, 160) + (txt ? " · " + txt : "") });
          return push({ t: "ix", n: "link", d: (u.pathname + u.search).slice(0, 160) + (txt ? " · " + txt : "") });
        }
        var b = t.closest("button, [role='button'], input[type='submit'], input[type='button'], summary, [role='tab'], [aria-expanded]");
        if (!b) return;
        var tx = text(b);
        if (b.matches("summary") || b.hasAttribute("aria-expanded")) {
          var opening = b.matches("summary") ? !(b.parentElement && b.parentElement.open) : b.getAttribute("aria-expanded") !== "true";
          if (opening && tx) return push({ t: "ix", n: "expand", d: tx });
          return;
        }
        if (b.getAttribute("role") === "tab") return tx && push({ t: "ix", n: "tab", d: tx });
        if (tx) push({ t: "ix", n: "click", d: tx });
      } catch (e) {}
    }, true);

    // Videos: play once per element, then 50% and complete.
    document.addEventListener("play", function (ev) {
      try {
        var v = ev.target; if (!v || v.tagName !== "VIDEO" || v.__lpoPlayed) return;
        v.__lpoPlayed = 1;
        var src = (v.currentSrc || v.src || (v.getAttribute("poster") || "")).split("/").pop().slice(0, 80) || "video";
        push({ t: "ix", n: "video", d: src + " · play" });
        var half = false;
        v.addEventListener("timeupdate", function () {
          if (!half && v.duration && v.currentTime / v.duration >= 0.5) { half = true; push({ t: "ix", n: "video", d: src + " · 50%" }); }
        });
        v.addEventListener("ended", function () { push({ t: "ix", n: "video", d: src + " · complete" }); });
      } catch (e) {}
    }, true);

    // Forms: first focus in a form, and submit.
    var formsStarted = {};
    document.addEventListener("focusin", function (ev) {
      try {
        var f = ev.target && ev.target.closest ? ev.target.closest("form") : null;
        if (!f || !f.matches("form")) return;
        var k = f.id || f.getAttribute("name") || f.getAttribute("action") || "form";
        if (formsStarted[k]) return; formsStarted[k] = 1;
        push({ t: "ix", n: "form_start", d: k.slice(0, 80) });
      } catch (e) {}
    }, true);
    document.addEventListener("submit", function (ev) {
      try {
        var f = ev.target; if (!f || !f.matches || !f.matches("form")) return;
        push({ t: "ix", n: "form_submit", d: (f.id || f.getAttribute("name") || f.getAttribute("action") || "form").slice(0, 80) });
        flush();
      } catch (e) {}
    }, true);

    // Page end: active seconds, depth, sections. Sent on hide so a tab left
    // open overnight still reports only the time they were actually there.
    var ended = false;
    function end() {
      if (ended) return; ended = true;
      depth();
      push({ t: "pe", dur: active, sc: maxScroll, secs: seen.slice(0, 40) });
      flush();
      // A later return to the tab reports only the NEW time/sections.
      active = 0; seen = []; seenSet = {};
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") end();
      else if (ended) { ended = false; } // came back: keep counting into a fresh pageend
    });
    window.addEventListener("pagehide", end);
    setInterval(flush, 15000);
  })();

  // Identity propagates even WITHOUT campaign params (direct/organic
  // visitors): the vid alone lets the server link this browser's history
  // when they later identify (builder save, survey, checkout). Only bail
  // when there's neither a vid nor any attribution to carry.
  if (!attr.first && !vid) return;

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
