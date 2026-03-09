const https = require("https");
const fs = require("fs");
const path = require("path");

const ORG = "keploy";
const OPEN_CSV = path.resolve(__dirname, "../data/new-issues.csv");
const CLOSED_CSV = path.resolve(__dirname, "../data/closed-issues.csv");
const DELAY_MS = 300;
const PER_PAGE = 100;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const OPEN_HEADER = "issue_number,repo_name,title,state,created_at,updated_at,author,issue_url\n";
const CLOSED_HEADER = "issue_number,repo_name,title,state,created_at,closed_at,author,issue_url\n";

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
        "User-Agent": "keploy-issues-tracker/1.0",
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
          const resetTime = reset ? new Date(parseInt(reset) * 1000).toISOString() : "unknown";
          return reject(new Error(`403 Rate limit hit. Resets at: ${resetTime}`));
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

async function fetchRepoIssues(repoName, state) {
  const issues = [];
  let page = 1;

  while (true) {
    const { data } = await githubGet(
      `/repos/${ORG}/${repoName}/issues?state=${state}&per_page=${PER_PAGE}&page=${page}&filter=all`
    );
    if (!data || data.length === 0) break;

    const realIssues = data.filter((item) => !item.pull_request);
    issues.push(...realIssues);

    process.stdout.write(
      `\r   [${state}] Fetching page ${page}… (${issues.length} issues so far)`
    );

    if (data.length < PER_PAGE) break;
    page++;
    await sleep(DELAY_MS);
  }

  if (issues.length > 0) process.stdout.write("\n");
  return issues;
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
      const issueNum = cols[0].replace(/^"|"$/g, "");
      const repoName = cols[1].replace(/^"|"$/g, "");
      if (issueNum && repoName) keys.add(`${repoName}::${issueNum}`);
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
  console.log("🚀  Keploy Issues Tracker starting…\n");
  const startTime = Date.now();

  ensureCSV(OPEN_CSV, OPEN_HEADER);
  ensureCSV(CLOSED_CSV, CLOSED_HEADER);

  const openKeys = loadExistingKeys(OPEN_CSV);
  const closedKeys = loadExistingKeys(CLOSED_CSV);
  console.log(`🗂   Existing open issues loaded   : ${openKeys.size}`);
  console.log(`🗂   Existing closed issues loaded : ${closedKeys.size}\n`);

  const newOpenList = [];
  const newClosedList = [];
  let skipped = 0;

  const repos = await fetchOrgRepos();

  for (const repo of repos) {
    const repoName = repo.name;
    console.log(`\n🔍  ${repoName}  (open: ${repo.open_issues_count})`);

    let openIssues = [];
    try {
      openIssues = await fetchRepoIssues(repoName, "open");
      console.log(`   ✅  ${openIssues.length} open issues`);
    } catch (err) {
      console.warn(`   ⚠️  Could not fetch open issues: ${err.message}`);
    }

    for (const issue of openIssues) {
      const key = `${repoName}::${issue.number}`;
      if (openKeys.has(key)) { skipped++; continue; }
      newOpenList.push({ issue, repoName });
      openKeys.add(key);
    }

    await sleep(DELAY_MS);

    let closedIssues = [];
    try {
      closedIssues = await fetchRepoIssues(repoName, "closed");
      console.log(`   ✅  ${closedIssues.length} closed issues`);
    } catch (err) {
      console.warn(`   ⚠️  Could not fetch closed issues: ${err.message}`);
    }

    for (const issue of closedIssues) {
      const key = `${repoName}::${issue.number}`;
      if (closedKeys.has(key)) { skipped++; continue; }
      newClosedList.push({ issue, repoName });
      closedKeys.add(key);
    }

    await sleep(DELAY_MS);
  }

  // Sort by date before writing
  newOpenList.sort((a, b) => new Date(a.issue.created_at) - new Date(b.issue.created_at));
  newClosedList.sort((a, b) => new Date(a.issue.created_at) - new Date(b.issue.created_at));
  console.log(`\n📅  Sorted ${newOpenList.length} open issues by created_at`);
  console.log(`📅  Sorted ${newClosedList.length} closed issues by created_at`);

  const openStream = fs.createWriteStream(OPEN_CSV, { flags: "a", encoding: "utf8" });
  const closedStream = fs.createWriteStream(CLOSED_CSV, { flags: "a", encoding: "utf8" });

  for (const { issue, repoName } of newOpenList) {
    const row = [
      csvEscape(issue.number), csvEscape(repoName), csvEscape(issue.title),
      csvEscape(issue.state), csvEscape(issue.created_at), csvEscape(issue.updated_at),
      csvEscape(issue.user?.login || ""), csvEscape(issue.html_url),
    ].join(",");
    openStream.write(row + "\n");
  }

  for (const { issue, repoName } of newClosedList) {
    const row = [
      csvEscape(issue.number), csvEscape(repoName), csvEscape(issue.title),
      csvEscape(issue.state), csvEscape(issue.created_at), csvEscape(issue.closed_at || ""),
      csvEscape(issue.user?.login || ""), csvEscape(issue.html_url),
    ].join(",");
    closedStream.write(row + "\n");
  }

  await new Promise((resolve) => openStream.end(resolve));
  await new Promise((resolve) => closedStream.end(resolve));

  const newOpen = newOpenList.length;
  const newClosed = newClosedList.length;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`✅  Done in ${elapsed}s`);
  console.log(`   New open issues written   : ${newOpen}`);
  console.log(`   New closed issues written : ${newClosed}`);
  console.log(`   Rows skipped (duplicates) : ${skipped}`);
  console.log(`   Open CSV   : ${OPEN_CSV}`);
  console.log(`   Closed CSV : ${CLOSED_CSV}`);

  if (newOpen === 0 && newClosed === 0) {
    console.log("\nℹ️   No new issues — exiting with code 2 (workflow will skip commit).");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("\n💥  Fatal:", err.message);
  process.exit(1);
});
