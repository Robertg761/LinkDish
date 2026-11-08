// Run from repository root: node docs/release/ios-2.2.2/render-screenshots.cjs
// Composes genuine, unchanged iOS captures in editable SVG layouts.
const fs = require('node:fs');
const path = require('node:path');

const sharp = require('sharp');
const root = __dirname;
const shots = [
 ['01-cookbook','02-cookbook.png',['Your recipes.','Ready to cook.'],'Keep favorites together in your personal cookbook.'],
 ['02-cooking','04-cooking.png',['One step.','Then the next.'],'Stay focused with clear, step-by-step cooking.'],
 ['03-shopping','05-shopping.png',['Recipe to','shopping list.'],'Bring the ingredients you need, organized by aisle.'],
];
(async () => {
 fs.mkdirSync(path.join(root,'screenshots'), {recursive:true});
 fs.mkdirSync(path.join(root,'sources'), {recursive:true});
 const icon=fs.readFileSync('apps/mobile/assets/icon.png').toString('base64');
 for(const [name,raw,lines,subtitle] of shots){
 const capture=fs.readFileSync(path.join(root,'raw',raw)).toString('base64');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1206" height="2622" viewBox="0 0 1206 2622">
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
 fs.writeFileSync(path.join(root,'sources',name+'.svg'),svg);
 await sharp(Buffer.from(svg)).flatten({background:'#f7f4ec'}).png().toFile(path.join(root,'screenshots',name+'.png'));
 }
 await sharp({create:{width:1206,height:874,channels:3,background:'#f7f4ec'}}).composite(await Promise.all(shots.map(async ([name],i)=>({input:await sharp(path.join(root,'screenshots',name+'.png')).resize(402,874).toBuffer(),left:i*402,top:0})))).png().toFile(path.join(root,'screenshots','contact-sheet.png'));
 console.log('Created three 1206 × 2622 RGB screenshots, SVG sources, and contact sheet.');
})();
