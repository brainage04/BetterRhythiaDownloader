const { execFileSync, spawn } = require("child_process");
const { once } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CDP = require("chrome-remote-interface");

const root = path.resolve(__dirname, "..");
const targetUrl = "https://www.rhythia.com/maps?filter=&status=RANKED&minStars=3&maxStars=5&author=&tags=&sort=newest&sortDirection=desc&page=2";
const captureDir = path.join(root, "store-assets", "rhythia-captures");
const captureLayout = {
  cardCount: 3,
  height: 760,
  leftPadding: 6,
  minCardSize: 100,
  rowTolerance: 20,
  scrollTopPadding: 88,
  topPadding: 54,
  visibleImageCount: 3,
  widthPadding: 12
};
const viewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false
};

const chromeCandidates = [
  process.env.CHROME_BIN,
  "google-chrome",
  "chromium",
  "chromium-browser"
].filter(Boolean);

function findChrome() {
  for (const candidate of chromeCandidates) {
    try {
      execFileSync("which", [candidate], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Could not find Chrome. Set CHROME_BIN to a Chrome or Chromium executable.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChrome(port, timeoutMs = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await CDP.Version({ port });
      return;
    } catch {
      await delay(100);
    }
  }

  throw new Error("Timed out waiting for Chrome remote debugging.");
}

async function waitForExit(process, timeoutMs = 5000) {
  if (process.exitCode !== null || process.signalCode !== null) return;

  await Promise.race([
    once(process, "exit"),
    delay(timeoutMs)
  ]);
}

async function evaluate(Runtime, expression) {
  const result = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
  }

  return result.result.value;
}

function pageCallExpression(fn, args) {
  const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(",");
  return `(${fn.toString()})(${serializedArgs})`;
}

async function runInPage(Runtime, fn, ...args) {
  return evaluate(Runtime, pageCallExpression(fn, args));
}

async function waitFor(Runtime, predicate, timeoutMs = 15000, ...args) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await runInPage(Runtime, predicate, ...args)) return;
    await delay(150);
  }

  throw new Error(`Timed out waiting for page predicate: ${predicate.name || "anonymous"}`);
}

function hasMapCards() {
  return document.querySelectorAll('a[href^="/maps/"]').length >= 10;
}

function dismissRhythiaModal() {
  const button = Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent.trim() === "Dismiss");

  if (button) button.click();
  return Boolean(button);
}

function scrollToCards(layout) {
  const firstCard = document.querySelector('a[href^="/maps/"]');
  if (!firstCard) return false;

  const y = firstCard.getBoundingClientRect().top + window.scrollY - layout.scrollTopPadding;
  window.scrollTo({ top: Math.max(0, y), left: 0, behavior: "instant" });
  return true;
}

function visibleCardImagesLoaded(layout) {
  const cards = Array.from(document.querySelectorAll('a[href^="/maps/"]'))
    .filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });

  const images = cards.flatMap((card) => Array.from(card.querySelectorAll("img")));
  return images.length >= layout.visibleImageCount &&
    images.slice(0, layout.visibleImageCount).every((image) => image.complete && image.naturalWidth > 0);
}

function getCardClip(layout) {
  const visibleCards = Array.from(document.querySelectorAll('a[href^="/maps/"]'))
    .map((card) => ({ rect: card.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > layout.minCardSize && rect.height > layout.minCardSize && rect.bottom > 0 && rect.top < window.innerHeight)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

  const firstRowTop = visibleCards[0]?.rect.top;
  const firstRow = visibleCards
    .filter(({ rect }) => Math.abs(rect.top - firstRowTop) < layout.rowTolerance)
    .sort((a, b) => a.rect.left - b.rect.left);

  const first = firstRow[0];
  const second = firstRow[1];
  if (!first || !second) return null;

  const firstRect = first.rect;
  const secondRect = second.rect;
  const gap = Math.max(0, secondRect.left - firstRect.right);
  const width = Math.round((firstRect.width * layout.cardCount) + (gap * (layout.cardCount - 1)) + layout.widthPadding);
  const top = Math.max(0, firstRect.top + window.scrollY - layout.topPadding);
  const left = Math.max(0, firstRect.left + window.scrollX - layout.leftPadding);

  return {
    x: Math.round(left),
    y: Math.round(top),
    width,
    height: layout.height,
    scale: 1
  };
}

function installContentStyle(css) {
  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.append(style);
}

function hasDownloadButtons() {
  return document.querySelectorAll("[data-brd-download-button]").length >= 10;
}

async function dismissModal(Runtime) {
  await runInPage(Runtime, dismissRhythiaModal);
  await delay(500);
}

async function focusCards(Runtime) {
  await runInPage(Runtime, scrollToCards, captureLayout);
  await delay(500);
}

async function waitForVisibleCardImages(Runtime) {
  await waitFor(Runtime, visibleCardImagesLoaded, 10000, captureLayout);
}

async function cardClip(Runtime) {
  return runInPage(Runtime, getCardClip, captureLayout);
}

async function capture(Page, Runtime, outputPath) {
  const clip = await cardClip(Runtime);
  if (!clip) throw new Error("Could not locate Rhythia map cards for screenshot capture.");

  const screenshot = await Page.captureScreenshot({
    format: "png",
    captureBeyondViewport: true,
    clip,
    fromSurface: true
  });

  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, "base64"));
}

async function main() {
  const chrome = findChrome();
  const port = 9300 + Math.floor(Math.random() * 1000);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "brd-chrome-"));
  const chromeProcess = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    "about:blank"
  ], {
    stdio: "ignore"
  });

  let client;

  try {
    await waitForChrome(port);
    client = await CDP({ port });

    const { Emulation, Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await Emulation.setDeviceMetricsOverride(viewport);

    await Page.navigate({ url: targetUrl });
    await Page.loadEventFired();
    await waitFor(Runtime, hasMapCards);
    await dismissModal(Runtime);
    await focusCards(Runtime);
    await waitForVisibleCardImages(Runtime);

    fs.mkdirSync(captureDir, { recursive: true });
    await capture(Page, Runtime, path.join(captureDir, "before.png"));

    const css = fs.readFileSync(path.join(root, "src", "content.css"), "utf8");
    const contentScript = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
    await runInPage(Runtime, installContentStyle, css);
    await Runtime.evaluate({
      expression: contentScript,
      awaitPromise: false
    });
    await waitFor(Runtime, hasDownloadButtons);
    await focusCards(Runtime);
    await waitForVisibleCardImages(Runtime);
    await delay(500);
    await capture(Page, Runtime, path.join(captureDir, "after.png"));
  } finally {
    if (client) {
      await client.Browser.close().catch(() => chromeProcess.kill());
      await client.close().catch(() => {});
    } else {
      chromeProcess.kill();
    }

    await waitForExit(chromeProcess);
    try {
      fs.rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
    } catch (error) {
      console.warn(`Could not remove temporary Chrome profile: ${profileDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
