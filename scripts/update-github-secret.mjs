import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const token = process.env.GH_PAT || "";
const repository = process.env.GITHUB_REPOSITORY || "";

async function main() {
  if (!token) {
    console.log("GH_PAT is not set; skipping GitHub secret update.");
    return;
  }
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is missing.");
  }

  const targets = parseTargets();
  if (targets.length === 0) {
    console.log("No refresh targets configured; skipping GitHub secret update.");
    return;
  }

  for (const target of targets) {
    const exists = await fs.access(target.path).then(() => true).catch(() => false);
    if (!exists) {
      console.log(`${target.path} does not exist; skipping ${target.secret}.`);
      continue;
    }

    const storageState = JSON.parse(await fs.readFile(target.path, "utf8"));
    const cookies = filterCookies(Array.isArray(storageState.cookies) ? storageState.cookies : []);
    if (cookies.length === 0) {
      console.log(`No usable cookies in ${target.path}; skipping ${target.secret}.`);
      continue;
    }

    await setSecretWithGh(target.secret, JSON.stringify(cookies), repository, token);
    console.log(`Updated repository secret ${target.secret}.`);
  }
}

function parseTargets() {
  const raw = (process.env.COZE_REFRESH_TARGETS || "").trim();
  if (!raw) return [];

  const targets = JSON.parse(raw);
  if (!Array.isArray(targets)) {
    throw new Error("COZE_REFRESH_TARGETS must be a JSON array.");
  }

  return targets
    .map((target) => ({
      secret: String(target.secret || "").trim(),
      path: String(target.path || "").trim()
    }))
    .filter((target) => target.secret && target.path);
}

function filterCookies(cookies) {
  return cookies.filter((cookie) => {
    const domain = String(cookie.domain || "");
    return /coze\.cn|volcengine\.com|volccloudidentity\.com/.test(domain);
  }).map((cookie) => ({
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: cookie.domain,
    path: cookie.path || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: cookie.sameSite || "Lax",
    ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {})
  }));
}

async function setSecretWithGh(name, value, repo, ghToken) {
  const ghPath = process.env.GH_CLI_PATH || "gh";
  const child = spawn(ghPath, ["secret", "set", name, "--repo", repo], {
    env: {
      ...process.env,
      GH_TOKEN: ghToken
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(value);

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (code !== 0) {
    throw new Error(`gh secret set failed with exit code ${code}: ${stderr || stdout}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
