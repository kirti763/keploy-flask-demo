const https = require("https");
const fs = require("fs");
const path = require("path");

const OWNER = "keploy";
const REPO = "keploy";
const OUTPUT_FILE = path.resolve(__dirname, "../data/keploy-stargazers.csv");
const DELAY_MS = 300;
const PER_PAGE = 100;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const CSV_HEADER = "username,profile_url,timestamp\n";

if (!GITHUB_TOKEN) {
  console.error("❌  GITHUB_TOKEN is not set.");
  process.exit(1);
}


function githubGet(urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      method: "GET",
      headers: {
        "User-Agent": "keploy-stargazer-tracker/1.0",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 401)
          return reject(new Error("401 Unauthorized — check your GITHUB_TOKEN."));
        if (res.statusCode === 403) {
          const reset = res.headers["x-ratelimit-reset"];
          const resetTime = reset ? new Date(parseInt(reset) * 1000).toISOString() : "unknown";
          return reject(new Error(`403 Rate limit hit. Resets at: ${resetTime}`));
        }
        if (res.statusCode >= 400)
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          resolve({ data: JSON.parse(body), headers: res.headers });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value).trim();
  if (str.includes(",") || str.includes('"') || str.includes("\n"))
    return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function ensureOutputFile() {
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁  Created directory: ${dir}`);
  }
  if (!fs.existsSync(OUTPUT_FILE)) {
    fs.writeFileSync(OUTPUT_FILE, CSV_HEADER, "utf8");
    console.log(`📄  Created: ${OUTPUT_FILE}`);
  } else {
    console.log(`📄  Appending to: ${OUTPUT_FILE}`);
  }
}

function loadExistingUsernames() {
  const usernames = new Set();
  if (!fs.existsSync(OUTPUT_FILE)) return usernames;
  const lines = fs.readFileSync(OUTPUT_FILE, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const username = line.split(",")[0].replace(/^"|"$/g, "");
    if (username) usernames.add(username);
  }
  console.log(`🗂   ${usernames.size} existing records loaded for deduplication`);
  return usernames;
}

async function main() {
  console.log(`🚀  Keploy Stargazer Tracker — ${OWNER}/${REPO}\n`);
  const startTime = Date.now();

  ensureOutputFile();
  const existingUsernames = loadExistingUsernames();

  const { data: repoInfo } = await githubGet(`/repos/${OWNER}/${REPO}`);
  const totalStars = repoInfo.stargazers_count ?? 0;
  console.log(`📊  Current star count: ${totalStars}`);

  const stargazers = [];
  let page = 1;
  console.log(`\n⭐  Fetching stargazers…`);

  while (true) {
    const { data } = await githubGet(
      `/repos/${OWNER}/${REPO}/stargazers?per_page=${PER_PAGE}&page=${page}`,
      { Accept: "application/vnd.github.star+json" }
    );
    if (!data || data.length === 0) break;
    stargazers.push(...data);
    process.stdout.write(`\r   Fetched ${stargazers.length} stargazers (page ${page})…`);
    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }
  process.stdout.write("\n");
  console.log(`✅  Total fetched: ${stargazers.length}`);

  const writeStream = fs.createWriteStream(OUTPUT_FILE, { flags: "a", encoding: "utf8" });
  let newRows = 0;
  let skipped = 0;

  for (const entry of stargazers) {
    const username = entry.user?.login;
    if (!username) continue;
    if (existingUsernames.has(username)) { skipped++; continue; }

    const row = [
      csvEscape(username),
      csvEscape(entry.user?.html_url || `https://github.com/${username}`),
      csvEscape(entry.starred_at || ""),
    ].join(",");

    writeStream.write(row + "\n");
    existingUsernames.add(username);
    newRows++;
  }

  await new Promise((resolve) => writeStream.end(resolve));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`✅  Done in ${elapsed}s`);
  console.log(`   New rows written : ${newRows}`);
  console.log(`   Skipped          : ${skipped} (already in CSV)`);
  console.log(`   Output           : ${OUTPUT_FILE}`);

  if (newRows === 0) {
    console.log("\nℹ️   No new stargazers — exiting with code 2.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("\n💥  Fatal:", err.message);
  process.exit(1);
});
