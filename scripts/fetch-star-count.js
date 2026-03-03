require("dotenv").config();
const fs = require("fs");

const OWNER = "keploy";
const REPO = "keploy";

async function fetchStars() {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  const data = await res.json();

  if (!data.stargazers_count) {
    console.error("Error fetching stars:", data);
    return;
  }

  const stars = data.stargazers_count;
  const today = new Date().toISOString().split("T")[0];

  const line = `${today},${stars}\n`;

  if (!fs.existsSync("stars-history.csv")) {
    fs.writeFileSync("stars-history.csv", "date,total_stars\n");
  }

  fs.appendFileSync("stars-history.csv", line);

  console.log(`Saved ${stars} stars for ${today}`);
}

fetchStars();
