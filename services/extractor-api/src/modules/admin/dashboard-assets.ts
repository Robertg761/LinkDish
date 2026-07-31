export const adminDashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LinkDish Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7f8;
        --surface: #ffffff;
        --surface-soft: #f8fafb;
        --surface-strong: #eef4f5;
        --rail: #091720;
        --rail-muted: #8aa0ac;
        --ink: #111820;
        --ink-soft: #344450;
        --muted: #667783;
        --line: #d8e1e5;
        --line-soft: #ebf0f2;
        --accent: #007c89;
        --accent-dark: #005b65;
        --accent-soft: #e7f6f7;
        --warn: #9b5c00;
        --warn-soft: #fff7e6;
        --bad: #b42318;
        --bad-soft: #fff1ef;
        --good: #117647;
        --good-soft: #ecfdf3;
        --shadow: 0 12px 40px rgba(15, 35, 45, 0.08);
        --radius: 8px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 14px;
        line-height: 1.45;
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      button,
      input,
      select {
        font: inherit;
      }

      button {
        border: 1px solid var(--accent-dark);
        border-radius: 7px;
        background: var(--accent);
        color: white;
        cursor: pointer;
        min-height: 38px;
        padding: 0 14px;
        font-size: 13px;
        font-weight: 700;
        transition:
          background 140ms ease,
          border-color 140ms ease,
          box-shadow 140ms ease,
          transform 140ms ease;
      }

      button:hover {
        background: var(--accent-dark);
        box-shadow: 0 8px 20px rgba(0, 124, 137, 0.18);
      }

      button:active {
        transform: translateY(1px);
      }

      button.secondary {
        background: white;
        color: var(--accent-dark);
        border-color: #b8cbd1;
      }

      button.secondary:hover {
        background: var(--accent-soft);
        box-shadow: none;
      }

      input,
      select {
        width: 100%;
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: white;
        color: var(--ink);
        padding: 0 11px;
        font-size: 13px;
        outline: none;
        transition:
          border-color 140ms ease,
          box-shadow 140ms ease,
          background 140ms ease;
      }

      input:focus,
      select:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 124, 137, 0.12);
      }

      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 248px minmax(0, 1fr);
      }

      .rail {
        position: sticky;
        top: 0;
        height: 100vh;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow-y: auto;
        padding: 18px 14px;
        background:
          linear-gradient(180deg, rgba(0, 124, 137, 0.12), transparent 220px),
          var(--rail);
        color: white;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 40px;
        padding: 0 4px 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .brand-mark {
        width: 30px;
        height: 30px;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: #00a2ad;
        color: white;
        font-size: 17px;
        font-weight: 900;
      }

      .brand strong {
        display: block;
        font-size: 15px;
        line-height: 1;
      }

      .brand span {
        color: var(--rail-muted);
        font-size: 11px;
      }

      .rail-group {
        display: grid;
        gap: 6px;
      }

      .rail-title {
        padding: 0 8px 4px;
        color: var(--rail-muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .rail-link {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 36px;
        width: 100%;
        border: 0;
        border-radius: 7px;
        padding: 0 10px;
        background: transparent;
        color: #dce8ec;
        cursor: pointer;
        font-size: 13px;
        font-weight: 650;
        text-align: left;
      }

      .rail-link:hover,
      .rail-link.active {
        background: rgba(0, 124, 137, 0.24);
        color: white;
        box-shadow: none;
        transform: none;
      }

      .rail-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.9;
      }

      .rail-footer {
        margin-top: auto;
        display: grid;
        gap: 6px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: var(--radius);
        padding: 10px;
        background: rgba(255, 255, 255, 0.05);
      }

      .rail .muted {
        color: var(--rail-muted);
      }

      .content {
        min-width: 0;
        padding: 16px;
      }

      .page {
        display: grid;
        gap: 14px;
      }

      .page[hidden] {
        display: none;
      }

      .page-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(380px, 0.75fr);
        gap: 14px;
        align-items: start;
      }

      .topbar {
        position: sticky;
        top: 0;
        z-index: 10;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 16px;
        align-items: center;
        margin: -16px -16px 16px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(14px);
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: 22px;
        line-height: 1.1;
        letter-spacing: 0;
      }

      h2 {
        font-size: 15px;
        line-height: 1.2;
        margin-bottom: 12px;
      }

      h3 {
        font-size: 11px;
        color: var(--muted);
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .muted {
        color: var(--muted);
      }

      .grid {
        display: grid;
        gap: 14px;
      }

      .kpis {
        grid-template-columns: repeat(6, minmax(0, 1fr));
        margin-bottom: 14px;
      }

      .main-grid {
        grid-template-columns: minmax(0, 1.25fr) minmax(380px, 0.75fr);
        align-items: start;
      }

      .priority-grid {
        grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr);
        align-items: start;
        margin-bottom: 14px;
      }

      .priority-grid > .panel,
      .priority-grid > .stack {
        align-self: start;
      }

      .panel {
        min-width: 0;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 16px;
        box-shadow: 0 1px 0 rgba(10, 31, 40, 0.02);
      }

      .panel-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }

      .panel-head h2 {
        margin-bottom: 0;
      }

      .metric {
        display: grid;
        gap: 7px;
        min-height: 94px;
        padding: 15px;
      }

      .metric strong {
        font-size: 25px;
        line-height: 1;
        letter-spacing: 0;
      }

      .metric span {
        color: var(--muted);
        font-size: 12px;
      }

      .row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .actions {
        display: flex;
        gap: 8px;
        align-items: end;
        flex-wrap: wrap;
      }

      .inline-form {
        display: grid;
        gap: 10px;
      }

      .lookup-actions {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: end;
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .subpanel {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 12px;
        min-width: 0;
        background: var(--surface-soft);
      }

      .subpanel h3 {
        margin-bottom: 8px;
      }

      .check-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .check-row input {
        width: auto;
        min-height: auto;
      }

      .account-summary {
        display: grid;
        gap: 12px;
        margin-top: 12px;
      }

      .account-summary > p.muted {
        min-height: 96px;
        display: grid;
        place-items: center;
        border: 1px dashed var(--line);
        border-radius: var(--radius);
        background: var(--surface-soft);
        padding: 18px;
        text-align: center;
      }

      .status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 23px;
        border-radius: 999px;
        padding: 0 9px;
        border: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        font-weight: 750;
        white-space: nowrap;
      }

      .status.good {
        color: var(--good);
        border-color: #b7e4c7;
        background: var(--good-soft);
      }

      .status.warn {
        color: var(--warn);
        border-color: #f4d58d;
        background: var(--warn-soft);
      }

      .status.bad {
        color: var(--bad);
        border-color: #f4b8b3;
        background: var(--bad-soft);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        border-bottom: 1px solid var(--line-soft);
        padding: 9px 8px;
        text-align: left;
        vertical-align: top;
        font-size: 12px;
      }

      th {
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.02em;
      }

      tbody tr:hover td {
        background: var(--surface-soft);
      }

      tr:last-child td {
        border-bottom: 0;
      }

      .table-scroll {
        overflow-x: auto;
      }

      .wrap {
        word-break: break-word;
      }

      .bars {
        display: grid;
        gap: 10px;
      }

      .bar-row {
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr) 42px;
        gap: 10px;
        align-items: center;
        font-size: 12px;
      }

      .bar-track {
        height: 9px;
        border-radius: 999px;
        background: #edf0f3;
        overflow: hidden;
      }

      .bar-fill {
        height: 100%;
        min-width: 2px;
        background: var(--accent);
      }

      .notes {
        display: grid;
        gap: 8px;
      }

      .limit-list {
        display: grid;
        gap: 10px;
      }

      .limit-card {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 12px;
        display: grid;
        gap: 8px;
        background: var(--surface-soft);
      }

      .limit-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 10px;
      }

      .limit-meter {
        height: 8px;
        border-radius: 999px;
        background: #edf0f3;
        overflow: hidden;
      }

      .limit-meter span {
        display: block;
        height: 100%;
        min-width: 2px;
        background: var(--accent);
      }

      .limit-meter span.warn {
        background: var(--warn);
      }

      .limit-meter span.bad {
        background: var(--bad);
      }

      .note {
        border-left: 3px solid var(--warn);
        background: var(--warn-soft);
        padding: 9px 10px;
        color: #573600;
        border-radius: 0 7px 7px 0;
        font-size: 12px;
      }

      .stack {
        display: grid;
        gap: 14px;
      }

      @media (max-width: 1100px) {
        .shell {
          grid-template-columns: 1fr;
        }

        .rail {
          position: static;
          height: auto;
          display: grid;
          gap: 10px;
        }

        .rail-footer {
          display: none;
        }

        .rail-group {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .rail-title {
          flex: 0 0 100%;
          padding-top: 4px;
        }

        .rail-link {
          width: auto;
          min-height: 32px;
          padding: 0 9px;
        }

        .rail-dot {
          display: none;
        }

        .content {
          padding: 14px;
        }

        .topbar {
          margin: -14px -14px 14px;
          grid-template-columns: 1fr;
        }

        .kpis {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .main-grid,
        .page-grid,
        .priority-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 720px) {
        .topbar,
        .actions,
        .lookup-actions,
        .row {
          grid-template-columns: 1fr;
          align-items: stretch;
          flex-direction: column;
        }

        .detail-grid {
          grid-template-columns: 1fr;
        }

        .kpis {
          grid-template-columns: 1fr;
        }

        table {
          display: block;
          overflow-x: auto;
          white-space: nowrap;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <aside class="rail" aria-label="Admin navigation">
        <div class="brand">
          <div class="brand-mark">L</div>
          <div>
            <strong>LinkDish Admin</strong>
            <span>Operations console</span>
          </div>
        </div>

        <div class="rail-group">
          <div class="rail-title">Operate</div>
          <button class="rail-link active" data-page-target="overview" type="button"><span class="rail-dot"></span>Overview</button>
          <button class="rail-link" data-page-target="accounts" type="button"><span class="rail-dot"></span>User Accounts</button>
          <button class="rail-link" data-page-target="analytics" type="button"><span class="rail-dot"></span>Analytics</button>
          <button class="rail-link" data-page-target="requests" type="button"><span class="rail-dot"></span>Recent Requests</button>
        </div>

        <div class="rail-group">
          <div class="rail-title">System</div>
          <button class="rail-link" data-page-target="model" type="button"><span class="rail-dot"></span>AI Model Control</button>
          <button class="rail-link" data-page-target="providers" type="button"><span class="rail-dot"></span>Providers</button>
          <button class="rail-link" data-page-target="settings" type="button"><span class="rail-dot"></span>Settings</button>
          <button class="rail-link" data-page-target="notes" type="button"><span class="rail-dot"></span>Notes</button>
        </div>

        <div class="rail-footer">
          <h3>Access</h3>
          <strong>Admin Operator</strong>
          <span class="muted">Token protected</span>
        </div>
      </aside>

      <section class="content">
        <section class="topbar">
          <div>
            <h1 id="page-title">Overview</h1>
            <p class="muted" id="page-description">Accounts, billing, analytics, provider health, and model controls.</p>
          </div>
          <div class="actions">
            <label>
              <h3>Environment</h3>
              <select id="environment">
                <option value="development">Development</option>
                <option value="production">Production</option>
              </select>
            </label>
            <button class="secondary" id="refresh" type="button">Refresh</button>
            <span class="status" id="refresh-status">Loading</span>
          </div>
        </section>

        <section class="page" data-page="overview">
          <section class="grid kpis" id="kpis"></section>
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Usage Analytics</h2>
                <p class="muted">Current extraction status and source-type distribution for the selected environment.</p>
              </div>
            </div>
            <div class="grid row">
              <div>
                <h3>Status</h3>
                <div class="bars" id="status-bars"></div>
              </div>
              <div>
                <h3>Source Types</h3>
                <div class="bars" id="source-bars"></div>
              </div>
            </div>
          </section>
        </section>

        <section class="page" data-page="accounts" hidden>
          <section class="page-grid">
            <section class="panel account-panel" id="accounts">
              <div class="panel-head">
                <div>
                  <h2>User Accounts</h2>
                  <p class="muted">Look up a LinkDish user, inspect billing and household state, then grant Plus or Family access.</p>
                </div>
                <span class="status" id="account-status">Idle</span>
              </div>
              <form class="inline-form" id="account-lookup-form">
                <div class="lookup-actions">
                  <label>
                    <h3>User Email</h3>
                    <input id="account-email" inputmode="email" placeholder="user@example.com" type="email" />
                  </label>
                  <button id="lookup-account" type="submit">Lookup</button>
                </div>
              </form>
              <div id="account-details" class="account-summary">
                <p class="muted">Enter a LinkDish account email to view profile data, active plan, RevenueCat history, household members, invites, and grant controls.</p>
              </div>
            </section>

            <section class="panel">
              <h2>Plans</h2>
              <div id="plans"></div>
            </section>
          </section>
        </section>

        <section class="page" data-page="model" hidden>
          <section class="panel" id="model-control">
            <div class="panel-head">
              <div>
                <h2>AI Model Control</h2>
                <p class="muted">Switch fallback provider/model and verify runtime persistence.</p>
              </div>
              <span class="status" id="model-status"></span>
            </div>
            <div class="row">
              <label>
                <h3>Provider</h3>
                <select id="provider">
                  <option value="none">None</option>
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                </select>
              </label>
              <label>
                <h3>Model</h3>
                <select id="model"></select>
              </label>
            </div>
            <div class="actions" style="margin-top: 12px">
              <button id="save-model" type="button">Save Model</button>
              <button class="secondary" id="reset-model" type="button">Reset To Env</button>
            </div>
            <div id="model-details" style="margin-top: 12px"></div>
          </section>

          <section class="panel">
            <h2>Pricing Monitor</h2>
            <div class="row" style="margin-bottom: 12px">
              <label>
                <h3>Provider</h3>
                <select id="pricing-provider"></select>
              </label>
              <div>
                <h3>Scope</h3>
                <span class="status" id="pricing-status"></span>
              </div>
            </div>
            <div id="pricing"></div>
          </section>
        </section>

        <section class="page" data-page="analytics" hidden>
          <section class="page-grid">
            <section class="panel">
              <div class="panel-head">
                <h2>Durable Analytics</h2>
                <span class="status" id="durable-analytics-status">Loading</span>
              </div>
              <div id="durable-analytics"></div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>iOS Waitlist</h2>
                <span class="status" id="ios-waitlist-count">Loading</span>
              </div>
              <div id="ios-waitlist"></div>
            </section>
          </section>
        </section>

        <section class="page" data-page="requests" hidden>
          <section class="panel" id="recent-requests">
            <h2>Recent Requests</h2>
            <div id="recent"></div>
          </section>
        </section>

        <section class="page" data-page="providers" hidden>
          <section class="page-grid">
            <section class="panel" id="providers">
              <h2>Provider Hub</h2>
              <div id="provider-hub"></div>
            </section>

            <section class="panel" id="limits">
              <h2>Provider Limit Rules</h2>
              <div id="provider-limits"></div>
            </section>
          </section>
        </section>

        <section class="page" data-page="settings" hidden>
          <section class="page-grid">
            <section class="panel">
              <h2>Configuration</h2>
              <div id="configuration"></div>
            </section>

            <section class="panel" id="environment-profile-panel">
              <h2>Environment Profile</h2>
              <div id="environment-profile"></div>
            </section>
          </section>
        </section>

        <section class="page" data-page="notes" hidden>
          <section class="panel" id="notes-panel">
            <h2>Notes For Later</h2>
            <div class="notes" id="notes"></div>
          </section>
        </section>
      </section>
    </main>

    <script>
      const state = { account: null, snapshot: null, pricingProvider: null };
      const initialEnvironment = new URLSearchParams(window.location.search).get("environment") ||
        (["localhost", "127.0.0.1", "::1"].includes(window.location.hostname) ? "development" : "production");
      const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
      const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

      const text = (value) => value == null || value === "" ? "Not set" : String(value);
      const dateText = (value) => value ? new Date(value).toLocaleString() : "Not set";
      const pct = (value) => formatter.format(value) + "%";
      const statusClass = (ok) => ok ? "status good" : "status warn";
      const providerLabel = (provider) => provider === "gemini" ? "Gemini" : provider === "openai" ? "OpenAI" : "None";
      const pageMeta = {
        overview: {
          title: "Overview",
          description: "Runtime extraction health, billing state, and high-level operating signals."
        },
        accounts: {
          title: "User Accounts",
          description: "Look up users, inspect billing and household details, and grant paid access."
        },
        analytics: {
          title: "Analytics",
          description: "Durable product analytics, source hostnames, platforms, and waitlist signals."
        },
        requests: {
          title: "Recent Requests",
          description: "Latest extraction traffic with source, status, plan, and latency details."
        },
        model: {
          title: "AI Model Control",
          description: "Fallback provider controls, active model, persistence state, and model pricing."
        },
        providers: {
          title: "Providers",
          description: "External provider health, setup status, usage guidance, and limit rules."
        },
        settings: {
          title: "Settings",
          description: "Runtime configuration, environment profile, and production-readiness state."
        },
        notes: {
          title: "Notes",
          description: "Follow-up items and unresolved setup notes surfaced by the dashboard."
        }
      };
      const escapeHtml = (value) => text(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
      const limitStatusClass = (status) => {
        if (status === "ok") return "status good";
        if (status === "upgrade" || status === "missing") return "status bad";
        return "status warn";
      };
      const limitStatusLabel = (status) => {
        if (status === "ok") return "OK";
        if (status === "watch") return "Watch";
        if (status === "upgrade") return "Upgrade soon";
        if (status === "missing") return "Missing config";
        if (status === "error") return "API error";
        return "Unknown";
      };

      const getHashPage = () => {
        const page = window.location.hash.replace(/^#/u, "");
        return pageMeta[page] ? page : "overview";
      };

      function setPage(page, options = {}) {
        const activePage = pageMeta[page] ? page : "overview";
        state.page = activePage;

        document.querySelectorAll("[data-page]").forEach((pageElement) => {
          pageElement.hidden = pageElement.dataset.page !== activePage;
        });
        document.querySelectorAll("[data-page-target]").forEach((button) => {
          button.classList.toggle("active", button.dataset.pageTarget === activePage);
        });

        document.getElementById("page-title").textContent = pageMeta[activePage].title;
        document.getElementById("page-description").textContent = pageMeta[activePage].description;

        if (options.updateHash !== false && window.location.hash !== "#" + activePage) {
          const method = options.replace ? "replaceState" : "pushState";
          window.history[method](null, "", "#" + activePage);
        }

        if (!options.preserveScroll) {
          window.scrollTo({ top: 0, behavior: "auto" });
        }
      }

      async function requestJson(url, options) {
        const headers = {};

        if (options?.body) {
          headers["content-type"] = "application/json";
        }

        const response = await fetch(url, {
          headers,
          ...options
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        return response.json();
      }

      function renderKpis(snapshot) {
        const metrics = snapshot.analytics;
        const values = [
          ["Requests", metrics.totalRequests, "Since API process start"],
          ["Success Rate", pct(metrics.successRate), metrics.successCount + " successful"],
          ["Fallback", metrics.fallbackAttemptCount, metrics.llmSuccessCount + " LLM successes"],
          ["Avg Latency", metrics.averageLatencyMs + " ms", "p95 " + metrics.p95LatencyMs + " ms"],
          ["Est. LLM Spend", usd.format(snapshot.pricing.estimatedSpendUsd), "Uses estimated token counts"],
          ["Billing", snapshot.billing.enforcementEnabled ? "Enabled" : "Disabled", snapshot.environment.environment + " / " + snapshot.billing.storageMode]
        ];

        document.getElementById("kpis").innerHTML = values.map(([label, value, detail]) => \`
          <article class="panel metric">
            <h3>\${label}</h3>
            <strong>\${value}</strong>
            <span>\${detail}</span>
          </article>
        \`).join("");
      }

      function renderBars(id, counts) {
        const entries = Object.entries(counts);
        const max = Math.max(1, ...entries.map(([, value]) => value));
        document.getElementById(id).innerHTML = entries.length === 0
          ? '<p class="muted">No data yet.</p>'
          : entries.map(([label, value]) => \`
            <div class="bar-row">
              <span>\${label}</span>
              <span class="bar-track"><span class="bar-fill" style="width: \${Math.max(3, (value / max) * 100)}%"></span></span>
              <strong>\${value}</strong>
            </div>
          \`).join("");
      }

      function renderCountTable(counts, emptyText) {
        const entries = Object.entries(counts);
        return entries.length === 0
          ? '<p class="muted">' + escapeHtml(emptyText) + '</p>'
          : \`
            <table>
              <thead><tr><th>Dimension</th><th>Failures</th></tr></thead>
              <tbody>
                \${entries.map(([label, count]) => \`
                  <tr><td>\${escapeHtml(label)}</td><td>\${count}</td></tr>
                \`).join("")}
              </tbody>
            </table>
          \`;
      }

      function renderDurableAnalytics(snapshot) {
        const analytics = snapshot.durableAnalytics;
        const failures = analytics.failureDrilldown;
        const status = document.getElementById("durable-analytics-status");
        status.className = analytics.enabled && analytics.configured ? "status good" : "status warn";
        status.textContent = analytics.source + " / " + analytics.windowDays + "d";

        const topSources = analytics.topSourceHostnames.length === 0
          ? '<p class="muted">No source hostnames yet.</p>'
          : \`
            <table>
              <thead><tr><th>Hostname</th><th>Requests</th><th>Failed/blocked</th></tr></thead>
              <tbody>
                \${analytics.topSourceHostnames.map((source) => \`
                  <tr>
                    <td>\${escapeHtml(source.label)}</td>
                    <td>\${source.count}</td>
                    <td>\${source.failureCount ?? 0}</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;
        const recentFailures = failures.recent.length === 0
          ? '<p class="muted">No durable extraction failures in this window.</p>'
          : \`
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Reason</th>
                  <th>Source</th>
                  <th>Platform / build</th>
                  <th>Visitor / session</th>
                  <th>Import ID</th>
                </tr>
              </thead>
              <tbody>
                \${failures.recent.map((failure) => \`
                  <tr>
                    <td>\${escapeHtml(new Date(failure.occurredAt).toLocaleString())}</td>
                    <td>\${escapeHtml(failure.reason)}</td>
                    <td>\${escapeHtml(failure.sourceHostname ?? "unknown")}</td>
                    <td>
                      \${escapeHtml(failure.platform)}
                      <br /><span class="muted">\${escapeHtml(
                        [failure.appVersion, failure.buildNumber].filter(Boolean).join(" / ") ||
                          "unknown"
                      )}</span>
                    </td>
                    <td>
                      \${escapeHtml(failure.visitorAlias ?? "unknown")}
                      <br /><span class="muted">\${escapeHtml(
                        failure.sessionAlias ?? "unknown"
                      )}</span>
                    </td>
                    <td><span class="muted">\${escapeHtml(
                      failure.correlationId ?? "unavailable"
                    )}</span></td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;

        document.getElementById("durable-analytics").innerHTML = \`
          <div class="grid row">
            <div>
              <h3>Overview</h3>
              <table>
                <tbody>
                  <tr><th>Events</th><td>\${analytics.totals.events}</td></tr>
                  <tr><th>Unique visitors</th><td>\${analytics.totals.uniqueVisitors}</td></tr>
                  <tr><th>Signed-up accounts</th><td>\${snapshot.accounts?.totalUsers ?? "unavailable"}</td></tr>
                  <tr><th>Extractions</th><td>\${analytics.totals.extractionEvents}</td></tr>
                  <tr><th>Extraction success</th><td>\${pct(analytics.totals.extractionSuccessRate)}</td></tr>
                  <tr><th>Client errors</th><td>\${analytics.totals.errors}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h3>Platforms</h3>
              <div class="bars" id="durable-platform-bars"></div>
            </div>
          </div>
          <h3 style="margin-top: 14px">Top Source Hosts</h3>
          \${topSources}
          <h3 style="margin-top: 18px">Extraction Failure Drilldown</h3>
          <div class="grid row">
            <div>
              <table>
                <tbody>
                  <tr><th>Failures / blocked</th><td>\${failures.total}</td></tr>
                  <tr><th>Distinct visitors</th><td>\${failures.distinctVisitors}</td></tr>
                  <tr><th>Distinct sessions</th><td>\${failures.distinctSessions}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h3>By reason</h3>
              \${renderCountTable(failures.byReason, "No failure reasons yet.")}
            </div>
          </div>
          <div class="grid row" style="margin-top: 14px">
            <div>
              <h3>By source</h3>
              \${renderCountTable(failures.bySourceHostname, "No failed sources yet.")}
            </div>
            <div>
              <h3>By platform</h3>
              \${renderCountTable(failures.byPlatform, "No failed platforms yet.")}
            </div>
            <div>
              <h3>By app / build</h3>
              \${renderCountTable(failures.byBuild, "No failed builds yet.")}
            </div>
          </div>
          <div class="grid row" style="margin-top: 14px">
            <div>
              <h3>By visitor alias</h3>
              \${renderCountTable(failures.byVisitor, "No visitor aliases yet.")}
            </div>
            <div>
              <h3>By session alias</h3>
              \${renderCountTable(failures.bySession, "No session aliases yet.")}
            </div>
          </div>
          <h3 style="margin-top: 18px">Recent failures</h3>
          \${recentFailures}
        \`;
        renderBars("durable-platform-bars", analytics.byPlatform);
      }

      function renderModel(snapshot) {
        const isRuntimeEnvironment = snapshot.environment.environment === snapshot.environment.runtimeEnvironment;
        const llm = isRuntimeEnvironment ? snapshot.llm : snapshot.environment.llm;
        document.getElementById("provider").value = llm.selectedProvider;
        renderModelOptions(snapshot, llm.selectedProvider, llm.activeModel);
        document.getElementById("provider").disabled = !isRuntimeEnvironment;
        document.getElementById("model").disabled = !isRuntimeEnvironment;
        document.getElementById("save-model").disabled = !isRuntimeEnvironment;
        document.getElementById("reset-model").disabled = !isRuntimeEnvironment;
        document.getElementById("model-status").className = isRuntimeEnvironment
          ? snapshot.llm.available && !snapshot.llm.persistence.loadError ? "status good" : "status warn"
          : "status";
        document.getElementById("model-status").textContent = isRuntimeEnvironment
          ? snapshot.llm.available ? "Available" : "Unavailable"
          : "Read-only profile";
        document.getElementById("model-details").innerHTML = \`
          <table>
            <tbody>
              <tr><th>Viewing</th><td>\${snapshot.environment.environment}</td></tr>
              <tr><th>Profile source</th><td>\${snapshot.environment.source}</td></tr>
              <tr><th>Runtime provider</th><td>\${snapshot.llm.runtimeProvider}</td></tr>
              <tr><th>Profile provider</th><td>\${llm.selectedProvider}</td></tr>
              <tr><th>Active model</th><td>\${text(llm.activeModel)}</td></tr>
              <tr><th>Config source</th><td>\${snapshot.llm.configSource}</td></tr>
              <tr><th>Persistence</th><td>\${snapshot.llm.persistence.configured ? "Configured" : "Not configured"}<br /><span class="muted">\${text(snapshot.llm.persistence.key)}</span></td></tr>
              <tr><th>Gemini key</th><td><span class="\${statusClass(llm.credentials.gemini)}">\${llm.credentials.gemini ? "Configured" : "Missing"}</span></td></tr>
              <tr><th>OpenAI key</th><td><span class="\${statusClass(llm.credentials.openai)}">\${llm.credentials.openai ? "Configured" : "Missing"}</span></td></tr>
              <tr><th>Runtime last changed</th><td>\${text(snapshot.llm.updatedAt)} by \${snapshot.llm.updatedBy}</td></tr>
            </tbody>
          </table>
        \`;
      }

      function renderKeyValueRows(rows) {
        return \`
          <table>
            <tbody>
              \${rows.map(([label, value]) => \`
                <tr><th>\${escapeHtml(label)}</th><td class="wrap">\${value}</td></tr>
              \`).join("")}
            </tbody>
          </table>
        \`;
      }

      function planStatusClass(plan) {
        if (plan === "family" || plan === "plus") return "status good";
        if (plan === "free") return "status warn";
        return "status";
      }

      function entitlementActive(expiresAt) {
        return !expiresAt || Date.parse(expiresAt) > Date.now();
      }

      function renderRevenueCatTables(account) {
        const subscriber = account.billing.subscriber;

        if (!subscriber) {
          return '<p class="muted">RevenueCat subscriber data is unavailable for this account.</p>';
        }

        const entitlements = subscriber.entitlements.length === 0
          ? '<p class="muted">No RevenueCat entitlements found.</p>'
          : \`
            <table>
              <thead><tr><th>Entitlement</th><th>Status</th><th>Product</th><th>Expires</th></tr></thead>
              <tbody>
                \${subscriber.entitlements.map((item) => \`
                  <tr>
                    <td><strong>\${escapeHtml(item.id)}</strong></td>
                    <td><span class="\${entitlementActive(item.expiresAt) ? "status good" : "status warn"}">\${entitlementActive(item.expiresAt) ? "Active" : "Expired"}</span></td>
                    <td>\${escapeHtml(item.productIdentifier)}</td>
                    <td>\${escapeHtml(dateText(item.expiresAt))}</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;

        const subscriptions = subscriber.subscriptions.length === 0
          ? '<p class="muted">No subscriptions found.</p>'
          : \`
            <table>
              <thead><tr><th>Product</th><th>Store</th><th>Period</th><th>Purchased</th><th>Expires</th></tr></thead>
              <tbody>
                \${subscriber.subscriptions.map((item) => \`
                  <tr>
                    <td><strong>\${escapeHtml(item.productId)}</strong><br /><span class="muted">\${escapeHtml(item.ownershipType)}</span></td>
                    <td>\${escapeHtml(item.store)}</td>
                    <td>\${escapeHtml(item.periodType)}</td>
                    <td>\${escapeHtml(dateText(item.purchaseAt))}</td>
                    <td>
                      \${escapeHtml(dateText(item.expiresAt))}
                      \${item.unsubscribeDetectedAt ? '<br /><span class="muted">Canceled ' + escapeHtml(dateText(item.unsubscribeDetectedAt)) + '</span>' : ""}
                      \${item.billingIssueDetectedAt ? '<br /><span class="muted">Billing issue ' + escapeHtml(dateText(item.billingIssueDetectedAt)) + '</span>' : ""}
                    </td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;

        const purchases = subscriber.nonSubscriptions.length === 0
          ? '<p class="muted">No one-time purchases found.</p>'
          : \`
            <table>
              <thead><tr><th>Product</th><th>Store</th><th>Purchased</th><th>Mode</th></tr></thead>
              <tbody>
                \${subscriber.nonSubscriptions.map((item) => \`
                  <tr>
                    <td><strong>\${escapeHtml(item.productId)}</strong><br /><span class="muted">\${escapeHtml(item.id)}</span></td>
                    <td>\${escapeHtml(item.store)}</td>
                    <td>\${escapeHtml(dateText(item.purchaseAt))}</td>
                    <td>\${item.isSandbox ? "Sandbox" : "Production"}</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;

        return \`
          <div class="stack">
            <div>
              <h3>Entitlements</h3>
              \${entitlements}
            </div>
            <div>
              <h3>Subscriptions</h3>
              \${subscriptions}
            </div>
            <div>
              <h3>One-Time Purchases</h3>
              \${purchases}
            </div>
          </div>
        \`;
      }

      function renderHousehold(account) {
        const household = account.household;

        if (!household) {
          return '<p class="muted">This account is not currently in a household.</p>';
        }

        const members = household.members.length === 0
          ? '<p class="muted">No active members found.</p>'
          : \`
            <table>
              <thead><tr><th>Member</th><th>Role</th><th>Joined</th></tr></thead>
              <tbody>
                \${household.members.map((member) => \`
                  <tr>
                    <td><strong>\${escapeHtml(member.email)}</strong><br /><span class="muted">\${escapeHtml(member.displayName)} \${escapeHtml(member.userId)}</span></td>
                    <td>\${member.role}</td>
                    <td>\${escapeHtml(dateText(member.joinedAt))}</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;

        const invites = household.invites.length === 0
          ? '<p class="muted">No pending invites.</p>'
          : \`
            <table>
              <thead><tr><th>Email</th><th>Expires</th></tr></thead>
              <tbody>
                \${household.invites.map((invite) => \`
                  <tr>
                    <td>\${escapeHtml(invite.email)}</td>
                    <td>\${escapeHtml(dateText(invite.expiresAt))}</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;

        return \`
          \${renderKeyValueRows([
            ["Household ID", escapeHtml(household.id)],
            ["Role", escapeHtml(household.role)],
            ["Owner user ID", escapeHtml(household.ownerUserId)],
            ["Members", household.activeMemberCount + " / " + household.memberLimit],
            ["Owner Family entitlement", household.ownerFamilyEntitlementActive ? "Active" : "Missing"],
            ["Cooldown slots", household.cooldownSlotCount]
          ])}
          <div style="margin-top: 12px">
            <h3>Members</h3>
            \${members}
          </div>
          <div style="margin-top: 12px">
            <h3>Pending Invites</h3>
            \${invites}
          </div>
        \`;
      }

      function renderGrantResult(result) {
        if (!result) return "";

        return \`
          <div class="note">
            \${result.dryRun ? "Dry run OK" : "Plan grant saved"}: \${escapeHtml(result.plan)} through \${escapeHtml(dateText(result.expiresAt))}
            \${result.auditId ? '<br />Audit ID: ' + escapeHtml(result.auditId) : ""}
            \${result.verifiedPlan ? '<br />Verified plan: ' + escapeHtml(result.verifiedPlan) : ""}
          </div>
        \`;
      }

      function renderAccountDetails(account, grantResult) {
        state.account = account;
        document.getElementById("account-status").className = "status good";
        document.getElementById("account-status").textContent = account.billing.effectivePlan || "Loaded";

        const billingErrors = account.billing.errors.length === 0
          ? ""
          : account.billing.errors.map((error) => \`<div class="note">\${escapeHtml(error)}</div>\`).join("");

        document.getElementById("account-details").innerHTML = \`
          \${renderGrantResult(grantResult)}
          <div class="detail-grid">
            <div class="subpanel">
              <h3>Account</h3>
              \${renderKeyValueRows([
                ["Email", '<strong>' + escapeHtml(account.user.email) + '</strong>'],
                ["User ID", escapeHtml(account.user.id)],
                ["Display name", escapeHtml(account.user.displayName)],
                ["Avatar", escapeHtml(account.user.avatarEmoji)],
                ["Created", escapeHtml(dateText(account.user.createdAt))],
                ["Updated", escapeHtml(dateText(account.user.updatedAt))]
              ])}
            </div>
            <div class="subpanel">
              <h3>Billing</h3>
              \${renderKeyValueRows([
                ["Effective plan", '<span class="' + planStatusClass(account.billing.effectivePlan) + '">' + escapeHtml(account.billing.effectivePlan) + '</span>'],
                ["RevenueCat plan", '<span class="' + planStatusClass(account.billing.revenueCatPlan) + '">' + escapeHtml(account.billing.revenueCatPlan) + '</span>'],
                ["Test premium override", escapeHtml(account.billing.testPremiumPlan)],
                ["Original app user ID", escapeHtml(account.billing.subscriber?.originalAppUserId)],
                ["First seen", escapeHtml(dateText(account.billing.subscriber?.firstSeenAt))],
                ["Last seen", escapeHtml(dateText(account.billing.subscriber?.lastSeenAt))],
                ["Management URL", account.billing.subscriber?.managementUrl ? '<a href="' + escapeHtml(account.billing.subscriber.managementUrl) + '" target="_blank" rel="noreferrer">Open RevenueCat</a>' : "Not set"]
              ])}
            </div>
          </div>
          \${billingErrors}
          <div class="subpanel">
            <h3>Manual Plan Grant</h3>
            <form class="inline-form" id="grant-plan-form">
              <div class="row">
                <label>
                  <h3>Plan</h3>
                  <select id="grant-plan">
                    <option value="family">Family</option>
                    <option value="plus">Plus</option>
                  </select>
                </label>
                <label>
                  <h3>Duration Days</h3>
                  <input id="grant-days" min="1" max="3650" step="1" type="number" value="365" />
                </label>
              </div>
              <label class="check-row">
                <input id="grant-dry-run" type="checkbox" />
                Dry run only
              </label>
              <div class="actions">
                <button id="grant-plan-submit" type="submit">Grant Plan</button>
                <span class="status" id="grant-status">Ready</span>
              </div>
            </form>
          </div>
          <div class="subpanel">
            <h3>RevenueCat Billing History</h3>
            \${renderRevenueCatTables(account)}
          </div>
          <div class="subpanel">
            <h3>Household</h3>
            \${renderHousehold(account)}
          </div>
        \`;

        document.getElementById("grant-plan-form").addEventListener("submit", grantAccountPlan);
      }

      function renderPlans(snapshot) {
        document.getElementById("plans").innerHTML = \`
          <table>
            <thead><tr><th>Plan</th><th>Price</th><th>Limits</th></tr></thead>
            <tbody>
              \${snapshot.plans.map((plan) => \`
                <tr>
                  <td><strong>\${plan.displayName}</strong></td>
                  <td>\${plan.monthlyPrice}<br /><span class="muted">\${plan.yearlyPrice} yearly</span></td>
                  <td>\${plan.monthlyImports} \${plan.id === "free" ? "total imports" : "imports/month"}<br />\${plan.savedRecipes}</td>
                </tr>
              \`).join("")}
            </tbody>
          </table>
        \`;
      }

      function renderPricing(snapshot) {
        const providers = [...new Set(snapshot.llm.catalog.map((model) => model.provider))];
        const isRuntimeEnvironment = snapshot.environment.environment === snapshot.environment.runtimeEnvironment;
        const activeLlm = isRuntimeEnvironment ? snapshot.llm : snapshot.environment.llm;
        const activeProvider = activeLlm.selectedProvider !== "none" ? activeLlm.selectedProvider : providers[0];
        const selectedProvider = providers.includes(state.pricingProvider)
          ? state.pricingProvider
          : activeProvider;
        state.pricingProvider = selectedProvider;
        const activeModel = selectedProvider === activeProvider ? activeLlm.activeModel : null;
        const providerModels = snapshot.llm.catalog.filter((model) => model.provider === selectedProvider);

        document.getElementById("pricing-provider").innerHTML = providers.map((provider) => \`
          <option value="\${provider}">\${providerLabel(provider)}</option>
        \`).join("");
        document.getElementById("pricing-provider").value = selectedProvider;
        document.getElementById("pricing-status").className = "status";
        document.getElementById("pricing-status").textContent = activeModel
          ? "Active: " + activeModel
          : "Provider catalog";
        document.getElementById("pricing").innerHTML = \`
          <table>
            <thead><tr><th>Model</th><th>Input</th><th>Output</th></tr></thead>
            <tbody>
              \${providerModels.map((model) => \`
                <tr>
                  <td>
                    <strong>\${model.label}</strong>
                    \${model.model === activeModel ? '<span class="status good" style="margin-left: 6px">Active</span>' : ""}
                    <br />
                    <span class="muted">\${model.model}</span>
                    \${model.price.note ? '<br /><span class="muted">' + model.price.note + '</span>' : ""}
                  </td>
                  <td>\${model.price.inputUsdPerMillionTokens == null ? "TBD" : usd.format(model.price.inputUsdPerMillionTokens)}</td>
                  <td>\${model.price.outputUsdPerMillionTokens == null ? "TBD" : usd.format(model.price.outputUsdPerMillionTokens)}</td>
                </tr>
              \`).join("")}
            </tbody>
          </table>
        \`;
      }

      function renderProviderLimits(snapshot) {
        document.getElementById("provider-limits").innerHTML = \`
          <div class="limit-list">
            \${snapshot.providerLimits.map((item) => {
              const meterClass = item.status === "upgrade" || item.status === "missing"
                ? "bad"
                : item.status === "watch"
                  ? "warn"
                  : "";
              const utilization = item.utilizationPct == null ? null : Math.max(0, Math.min(100, item.utilizationPct));

              return \`
                <article class="limit-card">
                  <div class="limit-head">
                    <div>
                      <strong>\${item.provider}</strong><br />
                      <span class="muted">\${item.area}</span>
                    </div>
                    <span class="\${limitStatusClass(item.status)}">\${limitStatusLabel(item.status)}</span>
                  </div>
                  \${utilization == null ? "" : \`
                    <div class="limit-meter" title="\${pct(utilization)} used">
                      <span class="\${meterClass}" style="width: \${Math.max(3, utilization)}%"></span>
                    </div>
                  \`}
                  <div>
                    <span>\${item.usageLabel}</span><br />
                    <span class="muted">Limit: \${item.limitLabel}</span>
                  </div>
                  <div class="muted">\${item.upgradeGuidance}</div>
                  <div class="muted">Source: \${item.source}</div>
                </article>
              \`;
            }).join("")}
          </div>
        \`;
      }

      function renderProviderHub(snapshot) {
        document.getElementById("provider-hub").innerHTML = \`
          <div class="limit-list">
            \${snapshot.providerHub.map((provider) => \`
              <article class="limit-card">
                <div class="limit-head">
                  <div>
                    <strong>\${provider.provider}</strong><br />
                    <span class="muted">\${provider.summary}</span>
                  </div>
                  <span class="\${limitStatusClass(provider.status)}">\${limitStatusLabel(provider.status)}</span>
                </div>
                \${provider.error ? \`<div class="note">\${provider.error}</div>\` : ""}
                <table>
                  <tbody>
                    \${provider.metrics.length === 0 ? \`
                      <tr><th>Live metrics</th><td>Not available</td></tr>
                    \` : provider.metrics.map((metric) => \`
                      <tr>
                        <th>\${metric.label}</th>
                        <td>
                          \${metric.value}
                          \${metric.detail ? \`<br /><span class="muted">\${metric.detail}</span>\` : ""}
                          \${metric.utilizationPct == null ? "" : \`<br /><span class="muted">\${pct(metric.utilizationPct)} used</span>\`}
                        </td>
                      </tr>
                    \`).join("")}
                    <tr><th>Source</th><td>\${provider.source}<br /><span class="muted">Checked \${new Date(provider.lastCheckedAt).toLocaleTimeString()}</span></td></tr>
                  </tbody>
                </table>
                <div class="actions">
                  \${provider.actions.map((action) => \`
                    <a class="status" href="\${action.href}" rel="noreferrer" target="_blank">\${action.label}</a>
                  \`).join("")}
                </div>
              </article>
            \`).join("")}
          </div>
        \`;
      }

      function renderModelOptions(snapshot, provider, selectedModel) {
        const modelSelect = document.getElementById("model");

        if (!snapshot || provider === "none") {
          modelSelect.innerHTML = '<option value="">None</option>';
          modelSelect.value = "";
          return;
        }

        const models = snapshot.llm.catalog.filter((model) => model.provider === provider);
        modelSelect.innerHTML = models.length === 0
          ? '<option value="">No models available</option>'
          : models.map((model) => \`
            <option value="\${model.model}">
              \${model.label}\${model.model === selectedModel ? " (active)" : ""}
            </option>
          \`).join("");
        modelSelect.value = models.some((model) => model.model === selectedModel)
          ? selectedModel
          : models[0]?.model || "";
      }

      function renderConfiguration(snapshot) {
        const rows = [
          ["API uptime", Math.round(snapshot.runtime.uptimeSeconds) + " seconds"],
          ["Port", snapshot.runtime.port],
          ["CORS", snapshot.runtime.corsOrigin],
          ["Browser fetch", snapshot.environment.runtime.browserFetchEnabled ? "Enabled" : "Disabled"],
          ["Rate limit", snapshot.environment.runtime.rateLimitMax + " / " + snapshot.environment.runtime.rateLimitWindowMs + " ms"],
          ["Sign-in code limit", snapshot.environment.runtime.authLoginCodeRateLimitMax + " / " + snapshot.environment.runtime.authLoginCodeRateLimitWindowMs + " ms"],
          ["Admin auth", snapshot.security.authMode],
          ["RevenueCat", snapshot.billing.revenueCatConfigured ? "Configured" : "Missing"],
          ["Upstash", snapshot.billing.upstashConfigured ? "Configured" : "Missing"]
        ];
        document.getElementById("configuration").innerHTML = \`
          <table><tbody>\${rows.map(([label, value]) => \`<tr><th>\${label}</th><td>\${value}</td></tr>\`).join("")}</tbody></table>
        \`;
      }

      function renderEnvironmentProfile(snapshot) {
        const profile = snapshot.environment;
        const rows = [
          ["Selected", profile.environment],
          ["Runtime environment", profile.runtimeEnvironment],
          ["Source", profile.source],
          ["Profile loaded", profile.available ? "Yes" : "No"],
          ["Provider", profile.llm.selectedProvider],
          ["Active model", text(profile.llm.activeModel)],
          ["Daily LLM budget", usd.format(profile.runtime.llmFallbackDailyBudgetUsd)],
          ["Fallback timeout", profile.runtime.llmFallbackTimeoutMs + " ms"],
          ["RevenueCat Plus entitlement", profile.billing.revenueCatEntitlementId],
          ["RevenueCat Family entitlement", profile.billing.revenueCatFamilyEntitlementId],
          [
            "Test premium override",
            profile.billing.testPremiumUserIdsConfigured
              ? "Enabled (" + profile.billing.testPremiumPlanId + ")"
              : "Disabled"
          ]
        ];
        document.getElementById("environment-profile").innerHTML = \`
          <table><tbody>\${rows.map(([label, value]) => \`<tr><th>\${label}</th><td>\${value}</td></tr>\`).join("")}</tbody></table>
        \`;
      }

      function renderRecent(snapshot) {
        document.getElementById("recent").innerHTML = snapshot.analytics.recentRequests.length === 0
          ? '<p class="muted">No extraction requests have hit this process yet.</p>'
          : \`
            <table>
              <thead><tr><th>Time</th><th>Host</th><th>Status</th><th>Attempt</th><th>Strategy</th><th>Plan</th><th>Latency</th></tr></thead>
              <tbody>
                \${snapshot.analytics.recentRequests.map((request) => \`
                  <tr>
                    <td>\${new Date(request.timestamp).toLocaleTimeString()}</td>
                    <td>\${request.hostname}</td>
                    <td>\${request.status}</td>
                    <td>\${request.attempt}</td>
                    <td>\${request.strategy}</td>
                    <td>\${request.billingPlan}<br /><span class="muted">\${text(request.quota)}</span></td>
                    <td>\${request.latencyMs} ms</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;
      }

      function renderIosWaitlist(snapshot) {
        const waitlist = snapshot.iosWaitlist || { entries: [], error: "Waitlist data unavailable.", hasMore: false, total: 0 };
        document.getElementById("ios-waitlist-count").className = waitlist.error ? "status warn" : "status good";
        document.getElementById("ios-waitlist-count").textContent = waitlist.total + " total";

        if (waitlist.error) {
          document.getElementById("ios-waitlist").innerHTML = \`<div class="note">\${escapeHtml(waitlist.error)}</div>\`;
          return;
        }

        if (waitlist.entries.length === 0) {
          document.getElementById("ios-waitlist").innerHTML = '<p class="muted">No iOS waitlist signups yet.</p>';
          return;
        }

        document.getElementById("ios-waitlist").innerHTML = \`
          <div class="table-scroll">
            <table>
              <thead><tr><th>Email</th><th>Signed up</th><th>Source</th><th>User agent</th></tr></thead>
              <tbody>
                \${waitlist.entries.map((entry) => \`
                  <tr>
                    <td><strong>\${escapeHtml(entry.email)}</strong></td>
                    <td>\${escapeHtml(new Date(entry.createdAt).toLocaleString())}</td>
                    <td>\${escapeHtml(entry.source)}</td>
                    <td class="wrap">\${escapeHtml(entry.userAgent)}</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          </div>
          \${waitlist.hasMore ? '<p class="muted" style="margin-top: 10px">Showing the newest ' + waitlist.entries.length + ' signups.</p>' : ""}
        \`;
      }

      function renderNotes(snapshot) {
        const notes = [
          ...snapshot.notes,
          ...snapshot.environment.notes,
          ...snapshot.llm.notes,
          ...(snapshot.durableAnalytics?.notes ?? [])
        ];
        document.getElementById("notes").innerHTML = notes.length === 0
          ? '<p class="muted">No unresolved setup notes.</p>'
          : notes.map((note) => \`<div class="note">\${note}</div>\`).join("");
      }

      function render(snapshot) {
        state.snapshot = snapshot;
        document.getElementById("environment").value = snapshot.environment.environment;
        renderKpis(snapshot);
        renderModel(snapshot);
        renderBars("status-bars", snapshot.analytics.counts.byStatus);
        renderBars("source-bars", snapshot.analytics.counts.bySourceType);
        renderDurableAnalytics(snapshot);
        renderPlans(snapshot);
        renderPricing(snapshot);
        renderProviderHub(snapshot);
        renderProviderLimits(snapshot);
        renderConfiguration(snapshot);
        renderEnvironmentProfile(snapshot);
        renderRecent(snapshot);
        renderIosWaitlist(snapshot);
        renderNotes(snapshot);
        document.getElementById("refresh-status").className = "status good";
        document.getElementById("refresh-status").textContent = "Updated " + new Date(snapshot.generatedAt).toLocaleTimeString();
      }

      async function refresh() {
        const selectedEnvironment = document.getElementById("environment").value;
        document.getElementById("refresh-status").className = "status";
        document.getElementById("refresh-status").textContent = "Loading";
        try {
          render(await requestJson("/admin/api/dashboard?environment=" + encodeURIComponent(selectedEnvironment)));
        } catch (error) {
          document.getElementById("refresh-status").className = "status bad";
          document.getElementById("refresh-status").textContent = "Failed";
          console.error(error);
        }
      }

      async function lookupAccount() {
        const email = document.getElementById("account-email").value.trim();

        if (!email) {
          document.getElementById("account-status").className = "status warn";
          document.getElementById("account-status").textContent = "Email required";
          return;
        }

        document.getElementById("account-status").className = "status";
        document.getElementById("account-status").textContent = "Loading";

        try {
          const account = await requestJson("/admin/api/users?email=" + encodeURIComponent(email));
          renderAccountDetails(account);
        } catch (error) {
          document.getElementById("account-status").className = "status bad";
          document.getElementById("account-status").textContent = "Lookup failed";
          document.getElementById("account-details").innerHTML = \`<div class="note">\${escapeHtml(error.message || error)}</div>\`;
          console.error(error);
        }
      }

      async function grantAccountPlan(event) {
        event.preventDefault();

        if (!state.account) {
          return;
        }

        const status = document.getElementById("grant-status");
        status.className = "status";
        status.textContent = "Saving";

        const payload = {
          dryRun: document.getElementById("grant-dry-run").checked,
          durationDays: Number(document.getElementById("grant-days").value),
          email: state.account.user.email,
          plan: document.getElementById("grant-plan").value
        };

        try {
          const result = await requestJson("/admin/api/billing/grants", {
            body: JSON.stringify(payload),
            method: "POST"
          });
          renderAccountDetails(result.account || state.account, result);
        } catch (error) {
          status.className = "status bad";
          status.textContent = "Grant failed";
          console.error(error);
        }
      }

      document.getElementById("environment").value = initialEnvironment;
      document.querySelectorAll("[data-page-target]").forEach((button) => {
        button.addEventListener("click", () => {
          setPage(button.dataset.pageTarget);
        });
      });
      window.addEventListener("popstate", () => {
        setPage(getHashPage(), {
          preserveScroll: true,
          updateHash: false
        });
      });
      document.getElementById("account-lookup-form").addEventListener("submit", (event) => {
        event.preventDefault();
        void lookupAccount();
      });
      document.getElementById("environment").addEventListener("change", refresh);
      document.getElementById("pricing-provider").addEventListener("change", () => {
        state.pricingProvider = document.getElementById("pricing-provider").value;
        renderPricing(state.snapshot);
      });
      document.getElementById("provider").addEventListener("change", () => {
        const selectedProvider = document.getElementById("provider").value;
        const firstModel = state.snapshot?.llm.catalog.find((model) => model.provider === selectedProvider);
        renderModelOptions(state.snapshot, selectedProvider, firstModel?.model || "");
      });
      document.getElementById("refresh").addEventListener("click", refresh);
      document.getElementById("save-model").addEventListener("click", async () => {
        const payload = {
          provider: document.getElementById("provider").value,
          model: document.getElementById("model").value
        };
        document.getElementById("model-status").className = "status";
        document.getElementById("model-status").textContent = "Saving";
        try {
          await requestJson("/admin/api/llm", { method: "PUT", body: JSON.stringify(payload) });
          await refresh();
        } catch (error) {
          document.getElementById("model-status").className = "status bad";
          document.getElementById("model-status").textContent = "Save failed";
          console.error(error);
        }
      });
      document.getElementById("reset-model").addEventListener("click", async () => {
        document.getElementById("model-status").className = "status";
        document.getElementById("model-status").textContent = "Resetting";
        try {
          await requestJson("/admin/api/llm", { method: "DELETE" });
          await refresh();
        } catch (error) {
          document.getElementById("model-status").className = "status bad";
          document.getElementById("model-status").textContent = "Reset failed";
          console.error(error);
        }
      });

      setPage(getHashPage(), {
        replace: true,
        updateHash: window.location.hash.length > 0
      });
      void refresh();
      setInterval(refresh, 30000);
    </script>
  </body>
</html>`;
