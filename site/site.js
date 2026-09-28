(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Must match the hamburger breakpoint in base.css (@media (max-width: 820px)).
  var desktopNav = window.matchMedia("(min-width: 821px)");
  var supportEmail = "support@linkdish.ca";

  root.classList.add("site-ready");

  function track(eventName, properties) {
    if (window.LinkDishAnalytics && typeof window.LinkDishAnalytics.track === "function") {
      window.LinkDishAnalytics.track(eventName, properties);
    }
  }

  function all(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  all("[data-current-year]").forEach(function (year) {
    year.textContent = String(new Date().getFullYear());
  });

  /* Navigation ------------------------------------------------------------ */

  var header = document.querySelector("[data-header]");
  var menuToggle = document.querySelector("[data-menu-toggle]");
  var siteNav = document.querySelector("[data-site-nav]");

  if (header && menuToggle && siteNav) {
    var menuLabel = menuToggle.querySelector(".sr-only");
    var isMenuOpen = function () {
      return menuToggle.getAttribute("aria-expanded") === "true";
    };
    var setMenu = function (open) {
      header.classList.toggle("is-menu-open", open);
      menuToggle.setAttribute("aria-expanded", String(open));

      if (menuLabel) {
        menuLabel.textContent = open ? "Close navigation" : "Open navigation";
      }
    };

    menuToggle.addEventListener("click", function () {
      setMenu(!isMenuOpen());
    });

    siteNav.addEventListener("click", function (event) {
      if (event.target instanceof Element && event.target.closest("a")) {
        setMenu(false);
      }
    });

    document.addEventListener("keydown", function (event) {
      // Only act when the menu is actually open, so Escape elsewhere keeps its focus.
      if (event.key === "Escape" && isMenuOpen()) {
        setMenu(false);
        menuToggle.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (isMenuOpen() && event.target instanceof Node && !header.contains(event.target)) {
        setMenu(false);
      }
    });

    var closeOnDesktop = function () {
      if (desktopNav.matches) {
        setMenu(false);
      }
    };

    if (desktopNav.addEventListener) {
      desktopNav.addEventListener("change", closeOnDesktop);
    } else if (desktopNav.addListener) {
      desktopNav.addListener(closeOnDesktop);
    }
  }

  /* Scroll reveal (below-the-fold content only; the hero is never hidden) --- */

  var revealItems = all("[data-reveal]");

  if (revealItems.length) {
    if (reduceMotion.matches || !("IntersectionObserver" in window)) {
      root.classList.remove("motion-ready");
    } else {
      var revealObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { rootMargin: "0px 0px -6% 0px", threshold: 0.08 }
      );

      revealItems.forEach(function (item, index) {
        item.style.setProperty("--reveal-delay", (index % 3) * 60 + "ms");
        revealObserver.observe(item);
      });

      // Anything already scrolled past (anchor links, restored scroll) shows at once.
      window.addEventListener(
        "load",
        function () {
          revealItems.forEach(function (item) {
            if (item.getBoundingClientRect().bottom < 0) {
              item.classList.add("is-visible");
            }
          });
        },
        { once: true }
      );
    }
  }

  /* Mobile CTA dock: hidden while the hero's own buttons are on screen ------ */

  var dock = document.querySelector("[data-mobile-dock]");
  var dockSentinel = document.querySelector("[data-dock-sentinel]");

  if (dock && dockSentinel && "IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      var entry = entries[0];
      dock.classList.toggle(
        "is-hidden",
        entry.isIntersecting || entry.boundingClientRect.top > window.innerHeight
      );
    }).observe(dockSentinel);
  }

  /* Hero "paste a recipe link" hand-off to the web app ---------------------- */

  all("[data-paste-form]").forEach(function (form) {
    var input = form.querySelector("input[name='url']");
    var status = form.querySelector("[data-paste-status]");
    var defaultHint = status ? status.textContent : "";

    if (!input) {
      return;
    }

    // Let people paste "example.com/recipe" without typing https:// first.
    form.noValidate = true;

    var showError = function (message) {
      if (status) {
        status.textContent = message;
        status.classList.add("error");
      }

      input.setAttribute("aria-invalid", "true");
      input.focus();
    };

    input.addEventListener("input", function () {
      if (status && status.classList.contains("error")) {
        status.textContent = defaultHint;
        status.classList.remove("error");
      }

      input.removeAttribute("aria-invalid");
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var raw = input.value.trim();
      var match = raw.match(/https?:\/\/[^\s<>"']+/i);
      var candidate = match ? match[0] : raw;

      if (!candidate) {
        showError("Paste a recipe link first, like a page from your favorite food site.");
        return;
      }

      if (!/^https?:\/\//i.test(candidate)) {
        candidate = "https://" + candidate;
      }

      var target;

      try {
        target = new URL(candidate);
      } catch (_error) {
        target = null;
      }

      if (!target || target.hostname.indexOf(".") === -1 || /\s/.test(candidate)) {
        showError("That doesn't look like a link. Copy the page address and paste it here.");
        return;
      }

      var params = new URLSearchParams();
      params.set("url", target.href);
      all("input[type='hidden']", form).forEach(function (hidden) {
        params.set(hidden.name, hidden.value);
      });

      track("marketing_web_app_clicked", {
        cta: "hero-import",
        source_host: target.hostname.replace(/^www\./, "").slice(0, 120)
      });

      window.location.assign(form.action + "?" + params.toString());
    });
  });

  /* Pricing: monthly / yearly toggle (monthly without JavaScript) ------------ */

  all("[data-pricing]").forEach(function (section) {
    var options = all("[data-period-option]", section);

    var setPeriod = function (period) {
      section.setAttribute("data-period", period);
      options.forEach(function (option) {
        option.setAttribute(
          "aria-pressed",
          String(option.getAttribute("data-period-option") === period)
        );
      });
      all("[data-price-monthly]", section).forEach(function (node) {
        node.hidden = period !== "monthly";
      });
      all("[data-price-yearly]", section).forEach(function (node) {
        node.hidden = period !== "yearly";
      });
    };

    options.forEach(function (option) {
      option.addEventListener("click", function () {
        setPeriod(option.getAttribute("data-period-option"));
      });
    });
  });

  /* Shared JSON form submission ---------------------------------------------- */

  function postJson(url, payload) {
    return fetch(url, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST"
    }).then(
      function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { body: body, ok: response.ok, status: response.status };
          });
      },
      function () {
        // fetch only rejects when the request never got a response (offline, blocked).
        return { body: {}, network: true, ok: false, status: 0 };
      }
    );
  }

  function setStatus(node, message, type, withEmail) {
    node.className = "form-status" + (type ? " " + type : "");
    node.textContent = message;

    if (withEmail) {
      var link = document.createElement("a");
      link.href = "mailto:" + supportEmail;
      link.textContent = supportEmail;
      node.appendChild(document.createTextNode(" "));
      node.appendChild(link);
      node.appendChild(document.createTextNode("."));
    }
  }

  /* iPhone waitlist -------------------------------------------------------------- */

  all("[data-waitlist-form]").forEach(function (form) {
    var status = form.querySelector("[data-waitlist-status]");
    var button = form.querySelector("button[type='submit']");

    if (!status || !button) {
      return;
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      if (!form.reportValidity()) {
        return;
      }

      var data = new FormData(form);
      var source = String(data.get("source") || "website");

      button.disabled = true;
      setStatus(status, "Adding you to the list…", "");

      postJson(form.action, { email: String(data.get("email") || "").trim(), source: source })
        .then(function (result) {
          if (result.ok) {
            form.reset();
            setStatus(
              status,
              result.body && result.body.alreadyJoined
                ? "You're already on the list. We'll email you when the iPhone app is ready."
                : "You're on the list. We'll email you when the iPhone app is ready.",
              "success"
            );
            track("marketing_ios_waitlist_submitted", {
              already_joined: Boolean(result.body && result.body.alreadyJoined),
              source: source
            });
            return;
          }

          if (result.network) {
            setStatus(
              status,
              "We couldn't reach LinkDish. Check your connection and try again, or email",
              "error",
              true
            );
            return;
          }

          setStatus(
            status,
            result.status === 400
              ? "Check the email address and try again."
              : (result.body && result.body.message) || "Something went wrong. Please try again.",
            "error"
          );
        })
        .finally(function () {
          button.disabled = false;
        });
    });
  });

  /* Support ticket form ----------------------------------------------------------- */

  var supportForm = document.querySelector("[data-support-form]");
  var supportStatus = document.querySelector("[data-support-status]");

  if (supportForm && supportStatus) {
    supportForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (!supportForm.reportValidity()) {
        return;
      }

      var submitButton = supportForm.querySelector("button[type='submit']");
      var payload = {};

      new FormData(supportForm).forEach(function (value, key) {
        payload[key] = typeof value === "string" ? value : "";
      });

      submitButton.disabled = true;
      setStatus(supportStatus, "Sending your ticket…", "");

      postJson(supportForm.action, payload)
        .then(function (result) {
          if (result.ok) {
            supportForm.reset();
            setStatus(
              supportStatus,
              "Thanks, ticket " +
                ((result.body && result.body.ticketId) || "received") +
                " is in. We'll reply by email.",
              "success"
            );
            return;
          }

          if (result.network) {
            setStatus(
              supportStatus,
              "We couldn't reach LinkDish support. Check your connection and try again, or email",
              "error",
              true
            );
            return;
          }

          setStatus(
            supportStatus,
            ((result.body && result.body.message) || "The ticket didn't go through.") +
              " You can also email",
            "error",
            true
          );
        })
        .finally(function () {
          submitButton.disabled = false;
        });
    });
  }
})();
