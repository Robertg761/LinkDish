(function () {
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var extractionCopy = document.querySelector("[data-extraction-copy]");
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

  if (extractionCopy && !reduceMotion.matches) {
    var extractionIndex = 0;

    window.setInterval(function () {
      extractionCopy.classList.add("is-swapping");

      window.setTimeout(function () {
        extractionIndex = (extractionIndex + 1) % extractionLines.length;
        extractionCopy.textContent = extractionLines[extractionIndex];
        extractionCopy.classList.remove("is-swapping");
      }, 250);
    }, 1800);
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
