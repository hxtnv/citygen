// Takes the README screenshots: starts the demo's dev server, opens each shot headless, saves PNGs
// into docs/. Run: `bun run screenshots` (needs `bunx playwright install chromium` once).
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const only = process.argv.slice(2);
const shots = [
  { name: "hero", query: "seed=7&character=city&view=hero&width=560&depth=460", size: [1600, 900] },
  { name: "top-city", query: "seed=7&character=city&view=top&width=560&depth=460", size: [1200, 1200] },
  { name: "village", query: "seed=12&character=village&view=hero&width=420&depth=340", size: [1200, 800] },
  { name: "street", query: "seed=7&character=city&view=street&width=560&depth=460", size: [1200, 800] },
  { name: "demo", query: "seed=21&character=crossroads&view=angle", size: [1400, 850], gui: true },
  { name: "top-hill", query: "seed=5&character=hill&view=top&width=460&depth=400", size: [1200, 1200] },
];

const server = await createServer({ root: root + "demo", configFile: root + "demo/vite.config.ts", logLevel: "warn", server: { port: 5199 } });
await server.listen();
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  for (const shot of shots) {
    if (only.length && !only.includes(shot.name)) continue;
    const page = await browser.newPage({ viewport: { width: shot.size[0], height: shot.size[1] } });
    page.on("pageerror", (e) => console.error(shot.name, e.message));
    await page.goto(`http://localhost:5199/?${shot.gui ? "" : "shot&"}${shot.query}`);
    await page.waitForSelector("body[data-ready]", { timeout: 120000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${root}docs/${shot.name}.png` });
    console.log("saved", shot.name);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
