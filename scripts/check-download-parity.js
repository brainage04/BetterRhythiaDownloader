const { execFileSync, spawn } = require("child_process");
const { once } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CDP = require("chrome-remote-interface");

const root = path.resolve(__dirname, "..");
const targetUrl = process.env.RHYTHIA_MAPS_URL ||
  "https://www.rhythia.com/maps?filter=&status=RANKED&minStars=3&maxStars=5&author=&tags=&sort=newest&sortDirection=desc&page=2";
const viewport = {
  width: 1280,
  height: 900,
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

function dismissRhythiaModal() {
  const button = Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent.trim() === "Dismiss");

  if (button) button.click();
  return Boolean(button);
}

function installContentStyle(css) {
  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.append(style);
}

function hasInjectedDownloadButton() {
  return Boolean(document.querySelector('[data-brd-download-button]:not([data-brd-download-url=""])'));
}

function firstInjectedDownload() {
  const button = document.querySelector('[data-brd-download-button]:not([data-brd-download-url=""])');
  const card = button?.closest('a[href^="/maps/"], a[href^="https://www.rhythia.com/maps/"], a[href^="https://rhythia.com/maps/"]');

  if (!button || !card) return null;

  return {
    cardUrl: new URL(card.getAttribute("href"), location.origin).href,
    downloadUrl: button.dataset.brdDownloadUrl
  };
}

function hasNativeDownloadAnchor() {
  return Boolean(document.querySelector('a[href$=".sspm"], a[href*=".sspm?"]'));
}

function nativeDownloadUrl() {
  const link = document.querySelector('a[href$=".sspm"], a[href*=".sspm?"]');
  return link ? link.href : "";
}

async function pageClient(port) {
  const client = await CDP({ port });
  const { Emulation, Page, Runtime } = client;
  await Promise.all([Page.enable(), Runtime.enable()]);
  await Emulation.setDeviceMetricsOverride(viewport);
  return client;
}

async function main() {
  const chrome = findChrome();
  const port = 9400 + Math.floor(Math.random() * 1000);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "brd-check-"));
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
    client = await pageClient(port);

    const { Page, Runtime } = client;
    await Page.navigate({ url: targetUrl });
    await Page.loadEventFired().catch(() => {});
    await runInPage(Runtime, dismissRhythiaModal);

    const css = fs.readFileSync(path.join(root, "src", "content.css"), "utf8");
    const contentScript = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
    await runInPage(Runtime, installContentStyle, css);
    await Runtime.evaluate({
      expression: contentScript,
      awaitPromise: false
    });

    await waitFor(Runtime, hasInjectedDownloadButton, 20000);

    const injected = await runInPage(Runtime, firstInjectedDownload);
    if (!injected?.cardUrl || !injected.downloadUrl) {
      throw new Error("Could not read the injected card download URL.");
    }

    await Page.navigate({ url: injected.cardUrl });
    await Page.loadEventFired().catch(() => {});
    await waitFor(Runtime, hasNativeDownloadAnchor, 20000);

    const nativeUrl = await runInPage(Runtime, nativeDownloadUrl);
    const ok = injected.downloadUrl === nativeUrl;
    const result = {
      ok,
      cardUrl: injected.cardUrl,
      injectedDownloadUrl: injected.downloadUrl,
      nativeDownloadUrl: nativeUrl
    };

    console.log(JSON.stringify(result, null, 2));

    if (!ok) {
      process.exitCode = 1;
    }
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
  process.exit(1);
});
