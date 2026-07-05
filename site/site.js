(function () {
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var extractionCopy = document.querySelector("[data-extraction-copy]");
  var assemblyCard = document.querySelector("[data-assembly-card]");
  var urlText = document.querySelector("[data-url-text]");
  var timerChip = document.querySelector("[data-timer-chip]");
  var extractionLines = [
    "Warming up the oven…",
    "Skimming off the ads…",
    "Chopping it down to the good stuff…",
    "Tasting for seasoning…",
    "Plating your recipe…"
  ];

  if (!reduceMotion.matches) {
    document.documentElement.classList.add("motion-ready");
  }

  var drawSquiggles = function () {
    var squiggles = Array.prototype.slice.call(document.querySelectorAll(".squiggle"));

    squiggles.forEach(function (squiggle) {
      var path = squiggle.querySelector("path");

      if (!path || typeof path.getTotalLength !== "function") {
        return;
      }

      squiggle.style.setProperty("--squiggle-length", Math.ceil(path.getTotalLength()));
    });

    window.setTimeout(function () {
      Array.prototype.slice
        .call(document.querySelectorAll(".hero .squiggle"))
        .forEach(function (squiggle) {
          squiggle.classList.add("is-drawn");
        });
    }, 420);
  };

  var formatTimer = function (seconds) {
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;

    return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  };

  if (reduceMotion.matches) {
    if (urlText) {
      urlText.textContent = urlText.dataset.fullUrl || urlText.textContent;
    }

    if (timerChip) {
      timerChip.textContent = "2:00:00";
    }

    if (assemblyCard) {
      assemblyCard.classList.add("is-assembled");
    }
  } else {
    drawSquiggles();
  }

  if ((urlText || extractionCopy || assemblyCard || timerChip) && !reduceMotion.matches) {
    var fullUrl = urlText ? urlText.dataset.fullUrl || urlText.textContent : "";
    var extractionIndex = 0;
    var timerInterval = 0;

    var swapExtraction = function (copy, delay) {
      window.setTimeout(function () {
        if (!extractionCopy) {
          return;
        }

        extractionCopy.classList.add("is-swapping");

        window.setTimeout(function () {
          extractionCopy.textContent = copy;
          extractionCopy.classList.remove("is-swapping");
        }, 250);
      }, delay);
    };

    var startCountdown = function () {
      if (!timerChip) {
        return;
      }

      var remaining = 7200;
      timerChip.textContent = formatTimer(remaining);
      window.clearInterval(timerInterval);
      timerInterval = window.setInterval(function () {
        remaining -= 1;
        timerChip.textContent = formatTimer(remaining);
      }, 1000);
    };

    var runLoop = function () {
      if (urlText) {
        urlText.textContent = "";
        urlText.classList.add("is-typing");
      }

      if (assemblyCard) {
        assemblyCard.classList.add("is-clearing");
        assemblyCard.classList.remove("is-assembled");
      }

      if (timerChip) {
        timerChip.textContent = "2:00:00";
      }

      if (extractionCopy) {
        extractionCopy.textContent = extractionLines[0];
      }

      window.clearInterval(timerInterval);

      var charIndex = 0;
      var typingInterval = window.setInterval(function () {
        charIndex += 1;

        if (urlText) {
          urlText.textContent = fullUrl.slice(0, charIndex);
        }

        if (charIndex >= fullUrl.length) {
          window.clearInterval(typingInterval);

          if (urlText) {
            urlText.classList.remove("is-typing");
          }
        }
      }, 28);

      swapExtraction(extractionLines[(extractionIndex + 1) % extractionLines.length], 3600);
      swapExtraction(extractionLines[(extractionIndex + 2) % extractionLines.length], 5050);
      extractionIndex = (extractionIndex + 2) % extractionLines.length;

      window.setTimeout(function () {
        if (!assemblyCard) {
          return;
        }

        assemblyCard.classList.remove("is-clearing");
        window.requestAnimationFrame(function () {
          assemblyCard.classList.add("is-assembled");
          startCountdown();
        });
      }, 4600);

      window.setTimeout(function () {
        if (assemblyCard) {
          assemblyCard.classList.add("is-clearing");
          assemblyCard.classList.remove("is-assembled");
        }
      }, 10600);
    };

    runLoop();
    window.setInterval(runLoop, 11000);
  }

  var revealItems = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));

  if (!revealItems.length) {
    return;
  }

  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    revealItems.forEach(function (item) {
      item.classList.add("is-visible");
    });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) {
          return;
        }

        var item = entry.target;
        item.style.setProperty(
          "--reveal-delay",
          Math.min(Number(item.dataset.revealIndex) * 60, 360) + "ms"
        );
        item.classList.add("is-visible");
        observer.unobserve(item);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.16 }
  );

  revealItems.forEach(function (item, index) {
    item.dataset.revealIndex = String(index);
    observer.observe(item);
  });

  // Safety net: content must never stay hidden if the observer misfires.
  window.setTimeout(function () {
    revealItems.forEach(function (item) {
      item.classList.add("is-visible");
    });
  }, 1400);
})();
