const https = require("https");
const fs = require("fs");
const path = require("path");

const ORG = "keploy";
const OPEN_CSV   = path.resolve(__dirname, "../data/open-prs.csv");
const MERGED_CSV = path.resolve(__dirname, "../data/merged-prs.csv");
const DELAY_MS   = 300;
const PER_PAGE   = 100;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const OPEN_HEADER   = "pr_number,repo_name,title,state,created_at,updated_at,author,pr_url\n";
const MERGED_HEADER = "pr_number,repo_name,title,state,created_at,merged_at,author,pr_url\n";


if (!GITHUB_TOKEN) {
  console.error("❌  GITHUB_TOKEN is not set.");
  process.exit(1);
}


function githubGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      method: "GET",
      headers: {
        "User-Agent": "keploy-pr-tracker/1.0",
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
          const reset = res.headers["x-ratelimit-reset"];
          const resetTime = reset
            ? new Date(parseInt(reset) * 1000).toISOString()
            : "unknown";
          return reject(new Error(`403 Rate limit hit. Resets at: ${resetTime}`));
        }

        if (res.statusCode >= 400)
          return reject(
            new Error(`HTTP ${res.statusCode} for ${urlPath}: ${body.slice(0, 200)}`)
          );

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  console.log(`✅  ${repos.length} repos found\n`);
  return repos;
}

async function fetchRepoPRs(repoName, state) {
  const prs = [];
  let page = 1;

  while (true) {
    const { data } = await githubGet(
      `/repos/${ORG}/${repoName}/pulls?state=${state}&per_page=${PER_PAGE}&page=${page}`
    );
    if (!data || data.length === 0) break;

    prs.push(...data);
    process.stdout.write(
      `\r   [${state}] Fetching page ${page}… (${prs.length} PRs so far)`
    );

    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }

  if (prs.length > 0) process.stdout.write("\n");
  return prs;
}


function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value).trim();
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function loadExistingKeys(filePath) {
  const keys = new Set();
  if (!fs.existsSync(filePath)) return keys;

  const lines = fs.readFileSync(filePath, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    if (cols.length >= 2) {
      const prNum  = cols[0].replace(/^"|"$/g, "");
      const repo   = cols[1].replace(/^"|"$/g, "");
      if (prNum && repo) keys.add(`${repo}::${prNum}`);
    }
  }
  return keys;
}

function ensureCSV(filePath, header) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁  Created directory: ${dir}`);
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header, "utf8");
    console.log(`📄  Created: ${filePath}`);
  } else {
    console.log(`📄  Appending to: ${filePath}`);
  }
}


async function main() {
  console.log("🚀  Keploy PR Tracker starting…\n");
  const startTime = Date.now();

  ensureCSV(OPEN_CSV,   OPEN_HEADER);
  ensureCSV(MERGED_CSV, MERGED_HEADER);

  const openKeys   = loadExistingKeys(OPEN_CSV);
  const mergedKeys = loadExistingKeys(MERGED_CSV);
  console.log(`🗂   Existing open PRs loaded   : ${openKeys.size}`);
  console.log(`🗂   Existing merged PRs loaded : ${mergedKeys.size}\n`);

  const newOpenList   = [];
  const newMergedList = [];
  let skipped = 0;

  const repos = await fetchOrgRepos();

  for (const repo of repos) {
    const repoName = repo.name;
    console.log(`\n🔀  ${repoName}`);

    let openPRs = [];
    try {
      openPRs = await fetchRepoPRs(repoName, "open");
      console.log(`   ✅  ${openPRs.length} open PRs`);
    } catch (err) {
      console.warn(`   ⚠️  Could not fetch open PRs: ${err.message}`);
    }

    for (const pr of openPRs) {
      const key = `${repoName}::${pr.number}`;
      if (openKeys.has(key)) { skipped++; continue; }
      newOpenList.push({ pr, repoName });
      openKeys.add(key);
    }

    await sleep(DELAY_MS);

    let closedPRs = [];
    try {
      closedPRs = await fetchRepoPRs(repoName, "closed");
      console.log(`   ✅  ${closedPRs.length} closed PRs fetched`);
    } catch (err) {
      console.warn(`   ⚠️  Could not fetch closed PRs: ${err.message}`);
    }

    const mergedPRs = closedPRs.filter((pr) => pr.merged_at !== null);
    console.log(`   🔀  ${mergedPRs.length} of those were merged`);

    for (const pr of mergedPRs) {
      const key = `${repoName}::${pr.number}`;
      if (mergedKeys.has(key)) { skipped++; continue; }
      newMergedList.push({ pr, repoName });
      mergedKeys.add(key);
    }

    await sleep(DELAY_MS);
  }

  // Sort by date before writing
  newOpenList.sort((a, b) => new Date(a.pr.created_at) - new Date(b.pr.created_at));
  newMergedList.sort((a, b) => new Date(a.pr.merged_at) - new Date(b.pr.merged_at));
  console.log(`\n📅  Sorted ${newOpenList.length} open PRs by created_at`);
  console.log(`📅  Sorted ${newMergedList.length} merged PRs by merged_at`);

  const openStream   = fs.createWriteStream(OPEN_CSV,   { flags: "a", encoding: "utf8" });
  const mergedStream = fs.createWriteStream(MERGED_CSV, { flags: "a", encoding: "utf8" });

  for (const { pr, repoName } of newOpenList) {
    const row = [
      csvEscape(pr.number), csvEscape(repoName), csvEscape(pr.title),
      csvEscape(pr.state), csvEscape(pr.created_at), csvEscape(pr.updated_at),
      csvEscape(pr.user?.login || ""), csvEscape(pr.html_url),
    ].join(",");
    openStream.write(row + "\n");
  }

  for (const { pr, repoName } of newMergedList) {
    const row = [
      csvEscape(pr.number), csvEscape(repoName), csvEscape(pr.title),
      csvEscape("merged"), csvEscape(pr.created_at), csvEscape(pr.merged_at),
      csvEscape(pr.user?.login || ""), csvEscape(pr.html_url),
    ].join(",");
    mergedStream.write(row + "\n");
  }

  await new Promise((resolve) => openStream.end(resolve));
  await new Promise((resolve) => mergedStream.end(resolve));

  const newOpen   = newOpenList.length;
  const newMerged = newMergedList.length;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`✅  Done in ${elapsed}s`);
  console.log(`   New open PRs written   : ${newOpen}`);
  console.log(`   New merged PRs written : ${newMerged}`);
  console.log(`   Rows skipped           : ${skipped} (duplicates)`);
  console.log(`   Open CSV   : ${OPEN_CSV}`);
  console.log(`   Merged CSV : ${MERGED_CSV}`);

  if (newOpen === 0 && newMerged === 0) {
    console.log("\nℹ️   No new PRs — exiting with code 2 (workflow will skip commit).");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("\n💥  Fatal:", err.message);
  process.exit(1);
});
