"use strict";
 
const https = require("https");
const fs = require("fs");
const path = require("path");
 
// ─── Config ───────────────────────────────────────────────────────────────────
const ORG = "keploy";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OUTPUT_FILE = path.resolve(__dirname, "../data/contributors.csv");
const DELAY_MS = 300;
const PER_PAGE = 100;
 
// 3-month window
const now = new Date();
const threeMonthsAgo = new Date(now);
threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
const SINCE = threeMonthsAgo.toISOString();
const FETCHED_AT = now.toISOString();
const WINDOW = `${threeMonthsAgo.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`;
 
const CSV_HEADER = "repo_name,username,profile_url,contributions_count,fetched_at,window\n";
 
// ─── Guards ───────────────────────────────────────────────────────────────────
if (!GITHUB_TOKEN) {
  console.error("❌  GITHUB_TOKEN is not set.");
  console.error("    Create a PAT and add it as the REPORT_TOKEN secret,");
  console.error("    then configure your workflow to export it as GITHUB_TOKEN.");
  process.exit(1);
}
 
// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
 
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  let str = String(value).trim();
  if (/^[=+\-@]/.test(str)) str = "'" + str;
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
 
function githubGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      method: "GET",
      headers: {
        "User-Agent": "keploy-contributor-tracker/1.0",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
 
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 204) return resolve({ data: null });
 
        if (res.statusCode === 401)
          return reject(new Error("401 Unauthorized — check your GITHUB_TOKEN."));
 
        if (res.statusCode === 403) {
          const remaining = res.headers["x-ratelimit-remaining"];
          const reset = res.headers["x-ratelimit-reset"];
          const resetTime = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : "unknown";
          if (remaining === "0") {
            return reject(new Error(`403 Rate limit hit. Resets at: ${resetTime}`));
          }
          return reject(new Error(`403 Forbidden for ${urlPath}: ${body.slice(0, 200)}`));
        }
 
        if (res.statusCode >= 400)
          return reject(new Error(`HTTP ${res.statusCode} for ${urlPath}: ${body.slice(0, 200)}`));
 
        try {
          resolve({ data: JSON.parse(body) });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
 
    req.on("error", reject);
    req.end();
  });
}
 
// ─── Fetch all public repos ───────────────────────────────────────────────────
async function fetchAllRepos() {
  const repos = [];
  let page = 1;
  while (true) {
    const { data } = await githubGet(`/orgs/${ORG}/repos?type=public&per_page=${PER_PAGE}&page=${page}`);
    if (!data || data.length === 0) break;
    repos.push(...data.map((r) => r.name));
    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }
  return repos;
}
 
// ─── Fetch commits for a repo in the last 3 months ───────────────────────────
async function fetchRepoContributors(repoName) {
  const contributorMap = new Map(); // username -> count
  let page = 1;
 
  while (true) {
    const { data } = await githubGet(
      `/repos/${ORG}/${repoName}/commits?since=${SINCE}&per_page=${PER_PAGE}&page=${page}`
    );
    if (!data || data.length === 0) break;
 
    for (const commit of data) {
      const login = commit.author?.login;
      if (!login) continue;
      contributorMap.set(login, (contributorMap.get(login) || 0) + 1);
    }
 
    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }
 
  return contributorMap;
}
 
// ─── Ensure CSV exists ────────────────────────────────────────────────────────
function ensureCSV(filePath, header) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁  Created directory: ${dir}`);
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header, "utf8");
    console.log(`📄  Created: ${filePath}`);
  }
}
 
// ─── Load existing keys for dedup ─────────────────────────────────────────────
function loadExistingKeys(filePath) {
  const keys = new Set();
  const lines = fs.readFileSync(filePath, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    if (cols.length >= 2) {
      const repo = cols[0].replace(/^"|"$/g, "");
      const user = cols[1].replace(/^"|"$/g, "");
      const window = cols[5] ? cols[5].replace(/^"|"$/g, "") : "";
      if (repo && user) keys.add(`${repo}::${user}::${window}`);
    }
  }
  return keys;
}
 
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀  Keploy Contributor Tracker starting…");
  console.log(`📅  Window: ${WINDOW}\n`);
 
  ensureCSV(OUTPUT_FILE, CSV_HEADER);
  const existingKeys = loadExistingKeys(OUTPUT_FILE);
  console.log(`🗂   Existing records loaded for dedup: ${existingKeys.size}\n`);
 
  const repos = await fetchAllRepos();
  console.log(`✅  ${repos.length} public repos found\n`);
 
  const newRows = [];
 
  for (const repoName of repos) {
    process.stdout.write(`👥  ${repoName}… `);
    try {
      const contributorMap = await fetchRepoContributors(repoName);
      if (contributorMap.size === 0) {
        console.log(`no contributors in last 3 months`);
        continue;
      }
      console.log(`${contributorMap.size} contributors`);
 
      for (const [username, count] of contributorMap.entries()) {
        const key = `${repoName}::${username}::${WINDOW}`;
        if (existingKeys.has(key)) continue;
        newRows.push({
          repoName,
          username,
          profileUrl: `https://github.com/${username}`,
          count,
        });
      }
    } catch (err) {
      console.warn(`⚠️  Could not fetch ${repoName}: ${err.message}`);
    }
 
    await sleep(DELAY_MS);
  }
 
  if (newRows.length === 0) {
    console.log("\n✅  No new contributors to add.");
    process.exit(2);
  }
 
  // Sort by repo name then username
  newRows.sort((a, b) => a.repoName.localeCompare(b.repoName) || a.username.localeCompare(b.username));
 
  const stream = fs.createWriteStream(OUTPUT_FILE, { flags: "a" });
  for (const row of newRows) {
    const line = [
      csvEscape(row.repoName),
      csvEscape(row.username),
      csvEscape(row.profileUrl),
      csvEscape(row.count),
      csvEscape(FETCHED_AT),
      csvEscape(WINDOW),
    ].join(",");
    stream.write(line + "\n");
  }
  stream.end();
 
  console.log("\n──────────────────────────────────────────────────");
  console.log(`✅  Done`);
  console.log(`   New rows written : ${newRows.length}`);
  console.log(`   Output           : ${OUTPUT_FILE}`);
  process.exit(0);
}
 
main().catch((err) => {
  console.error("💥  Fatal:", err.message);
  process.exit(1);
});
 
