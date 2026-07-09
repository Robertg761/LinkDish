(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var header = document.querySelector("[data-header]");
  var menuToggle = document.querySelector("[data-menu-toggle]");
  var siteNav = document.querySelector("[data-site-nav]");

  if (!reduceMotion.matches) {
    root.classList.add("motion-ready");
  }

  window.requestAnimationFrame(function () {
    window.requestAnimationFrame(function () {
      root.classList.add("is-ready");
    });
  });

  Array.prototype.slice
    .call(document.querySelectorAll("[data-current-year]"))
    .forEach(function (year) {
      year.textContent = String(new Date().getFullYear());
    });

  if (header) {
    var updateHeader = function () {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };

    updateHeader();
    window.addEventListener("scroll", updateHeader, { passive: true });
  }

  if (header && menuToggle && siteNav) {
    var closeMenu = function () {
      header.classList.remove("is-menu-open");
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.querySelector(".sr-only").textContent = "Open navigation";
    };

    menuToggle.addEventListener("click", function () {
      var willOpen = menuToggle.getAttribute("aria-expanded") !== "true";
      header.classList.toggle("is-menu-open", willOpen);
      menuToggle.setAttribute("aria-expanded", String(willOpen));
      menuToggle.querySelector(".sr-only").textContent = willOpen
        ? "Close navigation"
        : "Open navigation";
    });

    siteNav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeMenu();
        menuToggle.focus();
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 760) {
        closeMenu();
      }
    });
  }

  var revealItems = Array.prototype.slice.call(
    document.querySelectorAll("[data-reveal]")
  );

  if (revealItems.length) {
    if (reduceMotion.matches || !("IntersectionObserver" in window)) {
      revealItems.forEach(function (item) {
        item.classList.add("is-visible");
      });
    } else {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) {
              return;
            }

            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          });
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
      );

      revealItems.forEach(function (item, index) {
        item.style.setProperty("--reveal-delay", Math.min(index % 3, 2) * 70 + "ms");
        observer.observe(item);
      });

      window.setTimeout(function () {
        revealItems.forEach(function (item) {
          item.classList.add("is-visible");
        });
      }, 1600);
    }
  }

  var stationTabs = Array.prototype.slice.call(
    document.querySelectorAll("[data-station-target]")
  );
  var stationPanels = Array.prototype.slice.call(
    document.querySelectorAll("[data-station-panel]")
  );

  if (stationTabs.length && stationPanels.length) {
    var activateStation = function (name, moveFocus) {
      stationTabs.forEach(function (tab) {
        var active = tab.dataset.stationTarget === name;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;

        if (active && moveFocus) {
          tab.focus();
        }
      });

      stationPanels.forEach(function (panel) {
        var active = panel.dataset.stationPanel === name;
        panel.hidden = !active;
        panel.classList.toggle("is-active", active);
      });
    };

    stationTabs.forEach(function (tab, index) {
      tab.addEventListener("click", function () {
        activateStation(tab.dataset.stationTarget, false);
      });

      tab.addEventListener("keydown", function (event) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }

        event.preventDefault();
        var offset = event.key === "ArrowRight" ? 1 : -1;
        var nextIndex = (index + offset + stationTabs.length) % stationTabs.length;
        activateStation(stationTabs[nextIndex].dataset.stationTarget, true);
      });
    });
  }

  var supportForm = document.querySelector("[data-support-form]");
  var supportStatus = document.querySelector("[data-support-status]");

  if (supportForm && supportStatus) {
    var setSupportStatus = function (message, type) {
      supportStatus.className = "form-status" + (type ? " " + type : "");
      supportStatus.textContent = message;
    };

    supportForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (!supportForm.reportValidity()) {
        return;
      }

      var submitButton = supportForm.querySelector("button[type='submit']");
      var payload = Object.fromEntries(new FormData(supportForm).entries());

      submitButton.disabled = true;
      setSupportStatus("Submitting your support ticket…", "");

      fetch(supportForm.action, {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              if (!response.ok) {
                throw new Error(body.message || "Support ticket submission failed.");
              }

              return body;
            });
        })
        .then(function (body) {
          supportForm.reset();
          setSupportStatus(
            "Thanks — ticket " + (body.ticketId || "received") + " was submitted.",
            "success"
          );
        })
        .catch(function (error) {
          setSupportStatus(
            error instanceof Error
              ? error.message
              : "Support ticket submission failed. Please email support@linkdish.ca.",
            "error"
          );
        })
        .finally(function () {
          submitButton.disabled = false;
        });
    });
  }
})();
