const https = require("https");
const fs = require("fs");
const path = require("path");

const ORG = "keploy";
const OUTPUT_FILE = path.resolve(__dirname, "../data/stargazers.csv");
const DELAY_MS = 300;
const PER_PAGE = 100;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("❌  GITHUB_TOKEN environment variable is not set.");
  process.exit(1);
}

const CSV_HEADER = "repo_name,timestamp,username,profile_url,email,blog,twitter,total_stars_at_time\n";

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
        if (res.statusCode === 204) return resolve({ data: null, headers: res.headers });
        if (res.statusCode >= 400) {
          return reject(
            new Error(`GitHub API error ${res.statusCode} for ${urlPath}: ${body.slice(0, 200)}`)
          );
        }
        try {
          resolve({ data: JSON.parse(body), headers: res.headers });
        } catch (e) {
          reject(new Error(`JSON parse error for ${urlPath}: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOrgRepos() {
  console.log(`\n📦  Fetching repositories for org: ${ORG}`);
  const repos = [];
  let page = 1;

  while (true) {
    const { data } = await githubGet(
      `/orgs/${ORG}/repos?type=public&per_page=${PER_PAGE}&page=${page}`
    );
    if (!data || data.length === 0) break;

    repos.push(...data);
    console.log(`   Page ${page}: fetched ${data.length} repos (total so far: ${repos.length})`);

    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }

  console.log(`✅  Total repos found: ${repos.length}`);
  return repos;
}

async function fetchRepoStargazers(repoName) {
  const stargazers = [];
  let page = 1;

  while (true) {
    const { data } = await githubGet(
      `/repos/${ORG}/${repoName}/stargazers?per_page=${PER_PAGE}&page=${page}`,
      { Accept: "application/vnd.github.star+json" }
    );

    if (!data || data.length === 0) break;

    stargazers.push(...data);

    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }

  return stargazers;
}

async function fetchUserProfile(username) {
  const { data } = await githubGet(`/users/${username}`);
  return data || {};
}

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

  const content = fs.readFileSync(OUTPUT_FILE, "utf8");
  const lines = content.split("\n").slice(1); // skip header

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    if (cols.length >= 3) {
      const repoName = cols[0].replace(/^"|"$/g, "");
      const username = cols[2].replace(/^"|"$/g, "");
      if (repoName && username) keys.add(`${repoName}::${username}`);
    }
  }

  console.log(`🗂   Loaded ${keys.size} existing records for deduplication.`);
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
    console.log(`📄  Created new CSV file: ${OUTPUT_FILE}`);
  }
}


async function main() {
  console.log("🚀  Keploy Stargazer Tracker starting…\n");
  const startTime = Date.now();

  ensureOutputFile();
  const existingKeys = loadExistingKeys();

  const writeStream = fs.createWriteStream(OUTPUT_FILE, { flags: "a", encoding: "utf8" });

  let totalNew = 0;
  let totalSkipped = 0;

  const repos = await fetchOrgRepos();

  for (const repo of repos) {
    const repoName = repo.name;
    const totalStars = repo.stargazers_count;

    console.log(`\n⭐  Processing repo: ${repoName} (${totalStars} stars)`);

    let repoStargazers;
    try {
      repoStargazers = await fetchRepoStargazers(repoName);
    } catch (err) {
      console.warn(`   ⚠️  Skipping stargazers for ${repoName}: ${err.message}`);
      continue;
    }

    console.log(`   Found ${repoStargazers.length} stargazers`);

    for (const entry of repoStargazers) {
      const username = entry.user?.login;
      if (!username) continue;

      const dedupeKey = `${repoName}::${username}`;

      if (existingKeys.has(dedupeKey)) {
        totalSkipped++;
        continue;
      }

      let profile = {};
      try {
        await sleep(DELAY_MS);
        profile = await fetchUserProfile(username);
      } catch (err) {
        console.warn(`   ⚠️  Could not fetch profile for ${username}: ${err.message}`);
      }

      const row = [
        csvEscape(repoName),
        csvEscape(entry.starred_at || ""),
        csvEscape(username),
        csvEscape(entry.user?.html_url || `https://github.com/${username}`),
        csvEscape(profile.email || ""),
        csvEscape(profile.blog || ""),
        csvEscape(profile.twitter_username || ""),
        csvEscape(totalStars),
      ].join(",");

      writeStream.write(row + "\n");
      existingKeys.add(dedupeKey);
      totalNew++;
    }

    await sleep(DELAY_MS);
  }

  writeStream.end();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅  Done in ${elapsed}s`);
  console.log(`   New rows added : ${totalNew}`);
  console.log(`   Rows skipped   : ${totalSkipped}`);
  console.log(`   Output file    : ${OUTPUT_FILE}`);

  if (totalNew === 0) {
    console.log("\nℹ️   No new stargazers found. Exiting with code 2 (skip commit).");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("💥  Fatal error:", err.message);
  process.exit(1);
});
