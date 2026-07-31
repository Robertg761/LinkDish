(function () {
  var apiBaseUrl = "https://api.linkdish.ca";
  var clientKey = "linkdish:marketing:analytics-client-id:v1";
  var sessionKey = "linkdish:marketing:analytics-session-id:v1";
  var sessionLastSeenKey = "linkdish:marketing:analytics-session-last-seen:v1";
  var sessionTimeoutMs = 30 * 60 * 1000;

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }

    if (!window.crypto || !window.crypto.getRandomValues) {
      return "";
    }

    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.from(bytes, function (value) {
      return value.toString(16).padStart(2, "0");
    }).join("");

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join("-");
  }

  function getStoredId(key) {
    var existing = window.localStorage.getItem(key);

    if (existing) {
      return existing;
    }

    var next = uuid();

    if (!next) {
      return "";
    }

    window.localStorage.setItem(key, next);
    return next;
  }

  function getSessionId() {
    var now = Date.now();
    var lastSeen = Number(window.localStorage.getItem(sessionLastSeenKey) || 0);
    var sessionId = window.localStorage.getItem(sessionKey);

    if (!sessionId || !Number.isFinite(lastSeen) || now - lastSeen > sessionTimeoutMs) {
      sessionId = uuid();

      if (sessionId) {
        window.localStorage.setItem(sessionKey, sessionId);
      }
    }

    if (sessionId) {
      window.localStorage.setItem(sessionLastSeenKey, String(now));
    }

    return sessionId;
  }

  function referrerHostname() {
    if (!document.referrer) {
      return undefined;
    }

    try {
      return new URL(document.referrer).hostname.replace(/^www\./, "");
    } catch (_error) {
      return undefined;
    }
  }

  function utm(name) {
    return new URLSearchParams(window.location.search).get(name) || undefined;
  }

  function send(eventName, properties) {
    var anonymousId = getStoredId(clientKey);
    var sessionId = getSessionId();

    if (!anonymousId || !sessionId) {
      return;
    }

    var event = {
      eventName: eventName,
      occurredAt: new Date().toISOString(),
      platform: "marketing_site",
      anonymousId: anonymousId,
      sessionId: sessionId,
      routeOrScreen: window.location.pathname,
      referrerHostname: referrerHostname(),
      utmSource: utm("utm_source"),
      utmMedium: utm("utm_medium"),
      utmCampaign: utm("utm_campaign"),
      properties: properties || {}
    };
    var body = JSON.stringify({ events: [event] });

    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        apiBaseUrl + "/analytics/events",
        new Blob([body], { type: "application/json" })
      );
      return;
    }

    fetch(apiBaseUrl + "/analytics/events", {
      body: body,
      headers: {
        "content-type": "application/json"
      },
      keepalive: true,
      method: "POST"
    }).catch(function () {});
  }

  function pageEventName() {
    if (window.location.pathname.indexOf("/support") === 0) {
      return "marketing_support_viewed";
    }

    if (window.location.pathname.indexOf("/privacy") === 0) {
      return "marketing_privacy_viewed";
    }

    if (window.location.pathname.indexOf("/invite") === 0) {
      return "marketing_invite_page_viewed";
    }

    return "marketing_page_viewed";
  }

  send(pageEventName(), {
    path: window.location.pathname
  });

  document.addEventListener("click", function (event) {
    var link = event.target instanceof Element ? event.target.closest("a") : null;

    if (!link) {
      return;
    }

    var href = link.getAttribute("href") || "";
    var label = (link.textContent || "").trim().slice(0, 80);
    var targetUrl;

    try {
      targetUrl = new URL(href, window.location.href);
    } catch (_error) {
      targetUrl = null;
    }

    if (
      targetUrl &&
      (targetUrl.hostname === "play.google.com" || targetUrl.hostname.endsWith(".play.google.com"))
    ) {
      send("marketing_play_store_clicked", { cta: label });
      return;
    }

    if (
      targetUrl &&
      (targetUrl.hostname === "app.linkdish.ca" || targetUrl.hostname.endsWith(".app.linkdish.ca"))
    ) {
      send("marketing_web_app_clicked", { cta: label });
      return;
    }

    if (link.classList.contains("button") || link.classList.contains("info-link")) {
      send("marketing_cta_clicked", { cta: label });
    }
  });
})();
