import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { notifyFailure } from "./notifications.mjs";

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, "artifacts");
const RESULT_PATH = process.env.RESULT_PATH || path.join(ARTIFACT_DIR, "result.json");

const DEFAULT_TARGET_URL = "https://www.coze.cn/home";
const targetUrl = process.env.COZE_TARGET_URL || DEFAULT_TARGET_URL;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";

const DEFAULT_CLICK_TEXTS = [
  "领取",
  "签到",
  "免费积分",
  "每日",
  "去领取",
  "立即领取",
  "Get",
  "Claim"
];

async function main() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const results = [];
  let accounts = [];
  let browser;
  let fatalError;

  try {
    accounts = loadAccounts();

    const launchOptions = {
      headless: process.env.HEADLESS !== "false"
    };
    if (process.env.PLAYWRIGHT_CHANNEL) {
      launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
    }

    browser = await chromium.launch(launchOptions);

    for (const account of accounts) {
      results.push(await runAccount(browser, account));
    }
  } catch (error) {
    fatalError = error;
    console.error(error?.stack || error);

    for (const account of accounts) {
      if (!results.some((result) => result.name === account.name)) {
        results.push({
          name: account.name,
          success: false,
          message: error?.message || String(error),
          durationMs: 0
        });
      }
    }
  } finally {
    await browser?.close().catch(() => {});

    await writeResult({
      date: todayInShanghai(),
      startedAt,
      finishedAt: new Date().toISOString(),
      runUrl,
      accounts: results,
      ...(fatalError ? { error: fatalError?.message || String(fatalError) } : {})
    });

    if (fatalError) {
      process.exitCode = 1;
    }

    const failed = results.filter((result) => !result.success);
    if (fatalError || failed.length > 0) {
      process.exitCode = 1;
      await notifyFailure({
        title: "Coze每日签到失败",
        message: [
          "Coze 每日签到未全部成功。",
          ...results.map((result) => `${result.name}：${result.success ? "成功" : `失败（${result.message}）`}`),
          runUrl ? `运行记录：${runUrl}` : ""
        ].filter(Boolean).join("\n"),
        runUrl,
        repository: process.env.GITHUB_REPOSITORY
      });
    }
  }
}

function loadAccounts() {
  const names = (process.env.COZE_ACCOUNT_NAMES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const sources = [
    { secret: "COZE_COOKIES_JSON_1", value: process.env.COZE_COOKIES_JSON_1?.trim() },
    { secret: "COZE_COOKIES_JSON_2", value: process.env.COZE_COOKIES_JSON_2?.trim() }
  ];

  if (!sources[0].value && process.env.COZE_COOKIES_JSON?.trim()) {
    sources[0] = { secret: "COZE_COOKIES_JSON", value: process.env.COZE_COOKIES_JSON.trim() };
  }

  const accounts = sources
    .map((source, index) => ({
      index: index + 1,
      secret: source.secret,
      name: names[index] || `账号${index + 1}`,
      cookiesJson: source.value
    }))
    .filter((account) => account.cookiesJson);

  if (accounts.length === 0) {
    throw new Error("Missing COZE_COOKIES_JSON_1 or COZE_COOKIES_JSON_2 secret.");
  }

  return accounts;
}

async function runAccount(browser, account) {
  const statePath = path.join(ARTIFACT_DIR, `storage_state.account${account.index}.json`);
  const updatedStatePath = path.join(ARTIFACT_DIR, `storage_state.account${account.index}.updated.json`);
  const startedAt = Date.now();

  let context;
  try {
    await materializeStorageState(account.cookiesJson, statePath);

    context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      storageState: statePath
    });

    const page = await context.newPage();
    page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000));

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page);
    await assertLoggedIn(page);

    const clicked = await clickLikelyClaimControls(page);
    await settle(page);
    await assertLoggedIn(page);

    await context.storageState({ path: updatedStatePath });
    console.log(`[${account.name}] check-in completed${clicked ? ` (clicked: ${clicked})` : ""}`);

    return {
      name: account.name,
      success: true,
      message: clicked ? `已登录并点击「${clicked}」` : "已登录",
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    await captureFailure(context, account.index, error);
    console.error(`[${account.name}] check-in failed: ${error?.message || error}`);

    return {
      name: account.name,
      success: false,
      message: error?.message || String(error),
      durationMs: Date.now() - startedAt
    };
  } finally {
    await context?.close().catch(() => {});
  }
}

async function writeResult(result) {
  await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");
  console.log(`Result written to ${RESULT_PATH}`);
}

async function materializeStorageState(cookiesJson, targetPath) {
  const rawCookies = JSON.parse(cookiesJson);

  if (!Array.isArray(rawCookies) && Array.isArray(rawCookies.cookies)) {
    const storageState = rawCookies;
    validateStorageState(storageState);
    await fs.writeFile(targetPath, JSON.stringify(storageState, null, 2), "utf8");
    return;
  }

  const cookies = Array.isArray(rawCookies) ? rawCookies : rawCookies.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("Cookie secret must be a non-empty cookie array or a storage state object with cookies.");
  }

  const normalizedCookies = cookies.map(normalizeCookie).filter((cookie) => cookie.name && cookie.value);
  if (normalizedCookies.length === 0) {
    throw new Error("Cookie secret did not contain usable cookies.");
  }

  const storageState = {
    cookies: normalizedCookies,
    origins: Array.isArray(rawCookies.origins) ? rawCookies.origins : []
  };
  await fs.writeFile(targetPath, JSON.stringify(storageState, null, 2), "utf8");
}

function validateStorageState(storageState) {
  if (!storageState || !Array.isArray(storageState.cookies) || storageState.cookies.length === 0) {
    throw new Error("Storage state must be a Playwright storage_state object with cookies.");
  }
}

function normalizeCookie(cookie) {
  const normalized = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: cookie.domain || ".coze.cn",
    path: cookie.path || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite)
  };

  if (typeof cookie.expires === "number") {
    normalized.expires = cookie.expires;
  } else if (typeof cookie.expirationDate === "number") {
    normalized.expires = cookie.expirationDate;
  }

  return normalized;
}

function normalizeSameSite(value) {
  if (["Strict", "Lax", "None"].includes(value)) {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "strict") return "Strict";
    if (lower === "lax") return "Lax";
    if (lower === "none" || lower === "no_restriction") return "None";
  }
  return "Lax";
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (/login|passport|sso|signin/i.test(url)) {
    throw new Error(`登录状态已失效，当前地址为 ${url}`);
  }

  const loginControls = await page
    .getByText(/登录|注册|Sign in|Log in/i)
    .count()
    .catch(() => 0);

  const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 2000);
  const hasLoggedOutHint = /请登录|未登录|登录后|Sign in|Log in/i.test(bodyText);
  if (loginControls > 0 && hasLoggedOutHint) {
    throw new Error("登录状态已失效，页面上检测到登录提示");
  }
}

async function clickLikelyClaimControls(page) {
  const configuredTexts = (process.env.COZE_CLICK_TEXTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const texts = configuredTexts.length ? configuredTexts : DEFAULT_CLICK_TEXTS;

  for (const text of texts) {
    const locator = page.getByText(text, { exact: false }).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;

    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    const clicked = await locator.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) continue;

    console.log(`Clicked possible claim control: ${text}`);
    return text;
  }

  console.log("No claim-like control found; page visit is treated as the daily action.");
  return null;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 5000));
}

async function captureFailure(context, accountIndex, error) {
  const page = context?.pages()?.[0];
  if (!page) return;

  const suffix = accountIndex ? `.account${accountIndex}` : "";
  await page.screenshot({ path: path.join(ARTIFACT_DIR, `failure${suffix}.png`), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(path.join(ARTIFACT_DIR, `failure${suffix}.html`), html, "utf8").catch(() => {});
  }
  console.error(error);
}

function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
