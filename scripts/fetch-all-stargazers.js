
const https = require("https");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────

const ORG = "keploy";
const OUTPUT_FILE = path.resolve(__dirname, "../data/stargazers.csv");
const DELAY_MS = 300;
const PER_PAGE = 100;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const CSV_HEADER =
  "repo_name,timestamp,username,profile_url,email,blog,twitter,total_stars_at_time\n";

// ─── Token check ──────────────────────────────────────────────────────────────

if (!GITHUB_TOKEN) {
  console.error("❌  GITHUB_TOKEN is not set.");
  console.error("    Add it as a secret GH_PAT in your repo settings.");
  process.exit(1);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function githubGet(urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      method: "GET",
      headers: {
        "User-Agent": "keploy-stargazer-tracker/3.0",
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
        if (res.statusCode === 204) return resolve({ data: null, headers: res.headers });

        if (res.statusCode === 401) {
          return reject(new Error(
            "401 Unauthorized — token is invalid or expired.\n" +
            "Create a PAT at github.com/settings/tokens with scopes: public_repo + read:org\n" +
            "Then add it as repository secret GH_PAT and update the workflow to use secrets.GH_PAT"
          ));
        }

        if (res.statusCode === 403) {
          // Check if it's a rate limit
          const remaining = res.headers["x-ratelimit-remaining"];
          const reset = res.headers["x-ratelimit-reset"];
          const resetTime = reset ? new Date(parseInt(reset) * 1000).toISOString() : "unknown";
          return reject(new Error(
            `403 Rate limit hit. Remaining: ${remaining}. Resets at: ${resetTime}\n` +
            "Switch to a PAT token (GH_PAT) to get 5000 requests/hour instead of 60."
          ));
        }

        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} for ${urlPath}: ${body.slice(0, 200)}`));
        }

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

// ─── API wrappers ─────────────────────────────────────────────────────────────

async function fetchOrgRepos() {
  console.log(`\n📦  Fetching public repos for org: ${ORG}`);
  const repos = [];
  let page = 1;

  while (true) {
    const { data } = await githubGet(
      `/orgs/${ORG}/repos?type=public&per_page=${PER_PAGE}&page=${page}`
    );
    if (!data || data.length === 0) break;
    repos.push(...data);
    console.log(`   Page ${page}: ${data.length} repos (total: ${repos.length})`);
    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }

  console.log(`✅  ${repos.length} repos found`);
  return repos;
}

async function fetchRepoStargazers(repoName) {
  const stargazers = [];
  let page = 1;

  while (true) {
    const { data } = await githubGet(
      `/repos/${ORG}/${repoName}/stargazers?per_page=${PER_PAGE}&page=${page}`,
      { Accept: "application/vnd.github.star+json" }  // gives us starred_at timestamp
    );
    if (!data || data.length === 0) break;
    stargazers.push(...data);
    process.stdout.write(`\r   Fetching page ${page}… (${stargazers.length} so far)`);
    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }

  if (stargazers.length > 0) process.stdout.write("\n");
  return stargazers;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value).trim();
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function loadExistingKeys() {
  const keys = new Set();
  if (!fs.existsSync(OUTPUT_FILE)) return keys;

  const lines = fs.readFileSync(OUTPUT_FILE, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    if (cols.length >= 3) {
      const repo = cols[0].replace(/^"|"$/g, "");
      const user = cols[2].replace(/^"|"$/g, "");
      if (repo && user) keys.add(`${repo}::${user}`);
    }
  }

  console.log(`🗂   ${keys.size} existing records loaded for deduplication`);
  return keys;
}

function ensureOutputFile() {
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁  Created directory: ${dir}`);
  }
  if (!fs.existsSync(OUTPUT_FILE)) {
    fs.writeFileSync(OUTPUT_FILE, CSV_HEADER, "utf8");
    console.log(`📄  Created new CSV: ${OUTPUT_FILE}`);
  } else {
    console.log(`📄  Appending to: ${OUTPUT_FILE}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Keploy Stargazer Tracker v3 starting…");
  console.log("    (No per-user profile calls — fast mode)\n");
  const startTime = Date.now();

  ensureOutputFile();
  const existingKeys = loadExistingKeys();
  const writeStream = fs.createWriteStream(OUTPUT_FILE, { flags: "a", encoding: "utf8" });

  let totalNew = 0;
  let totalSkipped = 0;

  const repos = await fetchOrgRepos();

  for (const repo of repos) {
    const repoName = repo.name;
    const totalStars = repo.stargazers_count ?? 0;

    console.log(`\n⭐  ${repoName}  (${totalStars} stars)`);

    if (totalStars === 0) {
      console.log("   No stars — skipping.");
      continue;
    }

    let stargazers = [];
    try {
      stargazers = await fetchRepoStargazers(repoName);
    } catch (err) {
      console.warn(`   ⚠️  Skipping ${repoName}: ${err.message}`);
      continue;
    }

    console.log(`   ✅  ${stargazers.length} stargazers fetched`);

    for (const entry of stargazers) {
      const username = entry.user?.login;
      if (!username) continue;

      const key = `${repoName}::${username}`;
      if (existingKeys.has(key)) {
        totalSkipped++;
        continue;
      }

      // NOTE: email, blog, twitter are intentionally blank here.
      // The stargazers API doesn't return profile data — and fetching
      // /users/{username} for 16,000+ users causes rate limit errors.
      const row = [
        csvEscape(repoName),
        csvEscape(entry.starred_at || ""),
        csvEscape(username),
        csvEscape(entry.user?.html_url || `https://github.com/${username}`),
        "",   // email — not fetched (rate limit reasons)
        "",   // blog  — not fetched
        "",   // twitter — not fetched
        csvEscape(totalStars),
      ].join(",");

      writeStream.write(row + "\n");
      existingKeys.add(key);
      totalNew++;
    }

    await sleep(DELAY_MS);
  }

  await new Promise((resolve) => writeStream.end(resolve));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`✅  Done in ${elapsed}s`);
  console.log(`   New rows written : ${totalNew}`);
  console.log(`   Rows skipped     : ${totalSkipped} (duplicates)`);
  console.log(`   Output           : ${OUTPUT_FILE}`);

  if (totalNew === 0) {
    console.log("\nℹ️   No new data — exiting with code 2 (workflow will skip commit).");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("\n💥  Fatal:", err.message);
  process.exit(1);
});

