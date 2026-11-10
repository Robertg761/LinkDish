// Run from repository root: node docs/release/ios-2.2.2/render-screenshots.cjs
// Composes genuine, unchanged iOS captures in editable SVG layouts.
const fs = require("node:fs");
const path = require("node:path");

const sharp = require("sharp");
const root = __dirname;
const shots = [
  [
    "01-import",
    "build39/01-import.png",
    ["Recipe links.", "With permission."],
    "Import from publicdomainrecipes.com."
  ],
  [
    "02-cookbook",
    "build38/02-cookbook.png",
    ["Your cookbook.", "In one place."],
    "Keep the recipes you want to make again."
  ],
  [
    "03-recipe",
    "build38/03-recipe.png",
    ["The recipe.", "Without clutter."],
    "Time, servings, ingredients and clear steps."
  ],
  [
    "04-ingredients",
    "build38/04-ingredients.png",
    ["Ingredients.", "At a glance."],
    "Keep the details close while you cook."
  ],
  [
    "05-cooking",
    "build38/05-cooking.png",
    ["One step.", "Then the next."],
    "Follow focused instructions at your own pace."
  ],
  [
    "06-add-shopping",
    "build38/06-add-shopping.png",
    ["Pick ingredients.", "Make your list."],
    "Choose what you need before you shop."
  ],
  [
    "07-shopping",
    "build38/07-shopping.png",
    ["Shopping.", "Sorted by aisle."],
    "Check off ingredients as you go."
  ],
  [
    "08-plan",
    "build38/08-plan.png",
    ["Plan your week.", "Enjoy your meals."],
    "Give your saved recipes a place on the calendar."
  ],
  [
    "09-favorites",
    "build38/09-favorites.png",
    ["Keep favorites.", "Find them fast."],
    "A shorter path to the recipes you love."
  ],
  [
    "10-servings",
    "build38/10-servings.png",
    ["More guests?", "Scale the recipe."],
    "Adjust ingredient amounts to suit your table."
  ]
];
(async () => {
  fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(root, "sources"), { recursive: true });
  const icon = fs.readFileSync("apps/mobile/assets/icon.png").toString("base64");
  for (const [name, raw, lines, subtitle] of shots) {
    const capture = fs.readFileSync(path.join(root, "raw", raw)).toString("base64");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1206" height="2622" viewBox="0 0 1206 2622">
 <defs><clipPath id="screen"><rect x="157" y="650" width="892" height="1939" rx="64"/></clipPath><clipPath id="icon"><rect x="1026" y="76" width="100" height="100" rx="24"/></clipPath></defs>
 <rect width="1206" height="2622" fill="#f7f4ec"/>
 <circle cx="1150" cy="2000" r="600" fill="#e3e9df"/><circle cx="15" cy="2630" r="500" fill="#eee2cf"/>
 <text x="80" y="144" font-family="Helvetica Neue,Arial,sans-serif" font-size="34" font-weight="700" letter-spacing="8" fill="#29483d">LINKDISH</text>
 <image href="data:image/png;base64,${icon}" x="1026" y="76" width="100" height="100" clip-path="url(#icon)"/>
 <text x="80" y="292" font-family="Helvetica Neue,Arial,sans-serif" font-size="102" font-weight="750" letter-spacing="-3" fill="#233a30">${lines[0]}</text>
 <text x="80" y="405" font-family="Helvetica Neue,Arial,sans-serif" font-size="102" font-weight="750" letter-spacing="-3" fill="#233a30">${lines[1]}</text>
 <text x="82" y="493" font-family="Helvetica Neue,Arial,sans-serif" font-size="37" fill="#59655c">${subtitle}</text>
 <rect x="143" y="643" width="920" height="1960" rx="80" fill="#9eab9d" opacity=".25"/>
 <rect x="145" y="638" width="916" height="1963" rx="77" fill="#25392f"/>
 <image href="data:image/png;base64,${capture}" x="157" y="650" width="892" height="1939" clip-path="url(#screen)"/>
 </svg>`;
    fs.writeFileSync(path.join(root, "sources", name + ".svg"), svg);
    await sharp(Buffer.from(svg))
      .flatten({ background: "#f7f4ec" })
      .png()
      .toFile(path.join(root, "screenshots", name + ".png"));
  }
  await sharp({ create: { width: 1500, height: 1304, channels: 3, background: "#f7f4ec" } })
    .composite(
      await Promise.all(
        shots.map(async ([name], i) => ({
          input: await sharp(path.join(root, "screenshots", name + ".png"))
            .resize(300, 652)
            .toBuffer(),
          left: (i % 5) * 300,
          top: Math.floor(i / 5) * 652
        }))
      )
    )
    .png()
    .toFile(path.join(root, "screenshots", "contact-sheet.png"));
  fs.writeFileSync(
    path.join(root, "screenshots", "upload-order.json"),
    JSON.stringify(
      shots.map(([name, raw], i) => ({ position: i + 1, file: name + ".png", capture: raw })),
      null,
      2
    ) + "\n"
  );
  console.log(
    "Created ten 1206 × 2622 RGB screenshots, SVG sources, contact sheet, and upload order."
  );
})();
