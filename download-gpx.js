#!/usr/bin/env node

/**
 * Strava GPX Downloader
 * Downloads all your Strava activities as GPX files.
 *
 * Usage:
 *   1. Fill in your CLIENT_ID and CLIENT_SECRET below
 *   2. Run: node download-gpx-v2.js
 *   3. Authorize in the browser that opens
 *   4. GPX files will be saved to ./gpx/
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

require('dotenv').config();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET
const REDIRECT_URI = "http://localhost:8080/callback";
const OUTPUT_DIR = "./gpx";
const DELAY_MS = 1000; // delay between API calls to respect rate limits
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_FILE = ".strava_token.json";

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

function loadToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  }
  return null;
}

async function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on("error", reject);
  });
}

async function httpsPost(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

function getAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get("code");
      if (code) {
        res.end("<h2>✅ Authorized! You can close this tab.</h2>");
        server.close();
        resolve(code);
      } else {
        res.end("<h2>❌ Authorization failed.</h2>");
        server.close();
        reject(new Error("No auth code received"));
      }
    });

    server.listen(8080, () => {
      const authUrl =
        `https://www.strava.com/oauth/authorize` +
        `?client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=activity:read_all`;

      console.log("\n🔗 Opening Strava authorization in your browser...");
      console.log("   If it doesn't open, visit:\n  ", authUrl, "\n");

      // Try to open browser cross-platform
      try {
        const cmd =
          process.platform === "darwin"
            ? `open "${authUrl}"`
            : process.platform === "win32"
            ? `start "" "${authUrl}"`
            : `xdg-open "${authUrl}"`;
        execSync(cmd);
      } catch {
        // User will open manually
      }
    });
  });
}

async function getAccessToken() {
  let token = loadToken();

  // Refresh if expired
  if (token && token.expires_at * 1000 < Date.now()) {
    console.log("🔄 Refreshing access token...");
    const res = await httpsPost("https://www.strava.com/oauth/token", {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });
    if (res.body.access_token) {
      token = res.body;
      saveToken(token);
    } else {
      token = null; // force re-auth
    }
  }

  if (!token) {
    const code = await getAuthCode();
    const res = await httpsPost("https://www.strava.com/oauth/token", {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    });
    if (!res.body.access_token) {
      throw new Error("Token exchange failed: " + JSON.stringify(res.body));
    }
    token = res.body;
    saveToken(token);
    console.log("✅ Authenticated as:", token.athlete?.firstname, token.athlete?.lastname);
  }

  return token.access_token;
}

// ── Strava API ────────────────────────────────────────────────────────────────

async function getAllActivities(accessToken) {
  const activities = [];
  let page = 1;

  console.log("\n📋 Fetching activity list...");

  while (true) {
    const url = `https://www.strava.com/api/v3/athlete/activities?per_page=100&page=${page}`;
    const res = await httpsGet(url, { Authorization: `Bearer ${accessToken}` });

    if (res.status !== 200) throw new Error(`API error: ${JSON.stringify(res.body)}`);
    if (!res.body.length) break;

    activities.push(...res.body);
    process.stdout.write(`\r   Found ${activities.length} activities...`);
    page++;
    await sleep(DELAY_MS);
  }

  console.log(`\n   Total: ${activities.length} activities\n`);
  return activities;
}

async function getActivityStreams(accessToken, activityId) {
  const url =
    `https://www.strava.com/api/v3/activities/${activityId}/streams` +
    `?keys=latlng,altitude,time,heartrate,cadence,velocity_smooth&key_by_type=true`;
  const res = await httpsGet(url, { Authorization: `Bearer ${accessToken}` });
  if (res.status !== 200) return null;
  return res.body;
}

// ── GPX Builder ───────────────────────────────────────────────────────────────

function buildGpx(activity, streams) {
  const name = (activity.name || "Activity").replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );
  const startTime = new Date(activity.start_date).toISOString();
  const actType = stravaTypeToGpx(activity.type);

  const latlng    = streams?.latlng?.data           || [];
  const altitude  = streams?.altitude?.data          || [];
  const time      = streams?.time?.data              || [];
  const heartrate = streams?.heartrate?.data         || [];
  const cadence   = streams?.cadence?.data           || [];
  const velocity  = streams?.velocity_smooth?.data   || [];
  const startEpoch = new Date(activity.start_date).getTime() / 1000;

  const trkpts = latlng
    .map((ll, i) => {
      const lat = ll[0].toFixed(7);
      const lon = ll[1].toFixed(7);
      const ele = altitude[i]  != null ? `\n      <ele>${altitude[i].toFixed(1)}</ele>` : "";
      const t   = time[i]      != null
        ? `\n      <time>${new Date((startEpoch + time[i]) * 1000).toISOString()}</time>`
        : "";

      // Garmin TrackPoint Extensions (hr, cadence, speed/pace)
      const hrTag  = heartrate[i] != null ? `\n          <gpxtpx:hr>${Math.round(heartrate[i])}</gpxtpx:hr>` : "";
      const cadTag = cadence[i]   != null ? `\n          <gpxtpx:cad>${Math.round(cadence[i])}</gpxtpx:cad>` : "";
      // velocity_smooth is m/s → store as speed (m/s); consuming apps convert to pace
      const spdTag = velocity[i]  != null ? `\n          <gpxtpx:speed>${velocity[i].toFixed(3)}</gpxtpx:speed>` : "";

      const hasExt = hrTag || cadTag || spdTag;
      const ext = hasExt
        ? `\n      <extensions>\n        <gpxtpx:TrackPointExtension>${hrTag}${cadTag}${spdTag}\n        </gpxtpx:TrackPointExtension>\n      </extensions>`
        : "";

      return `    <trkpt lat="${lat}" lon="${lon}">${ele}${t}${ext}\n    </trkpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="strava-gpx-downloader"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1
    http://www.topografix.com/GPX/1/1/gpx.xsd
    http://www.garmin.com/xmlschemas/TrackPointExtension/v1
    http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd">
  <metadata>
    <name>${name}</name>
    <time>${startTime}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <type>${actType}</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function stravaTypeToGpx(type) {
  const map = {
    Run: "running",
    Ride: "cycling",
    Swim: "swimming",
    Hike: "hiking",
    Walk: "walking",
    AlpineSki: "skiing",
    NordicSki: "skiing",
    Kayaking: "kayaking",
  };
  return map[type] || type.toLowerCase();
}

function safeFilename(activity) {
  const date = activity.start_date.slice(0, 10);
  const name = (activity.name || "activity")
    .replace(/[^a-zA-Z0-9\-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);
  return `${date}_${activity.id}_${name}.gpx`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (CLIENT_ID === "YOUR_CLIENT_ID") {
    console.error("❌ Please set your CLIENT_ID and CLIENT_SECRET in the script.");
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const accessToken = await getAccessToken();
  const activities = await getAllActivities(accessToken);

  let downloaded = 0;
  let skipped = 0;
  let noGps = 0;

  for (let i = 0; i < activities.length; i++) {
    const act = activities[i];
    const filename = safeFilename(act);
    const filepath = path.join(OUTPUT_DIR, filename);

    process.stdout.write(`\r[${i + 1}/${activities.length}] ${filename.slice(0, 60).padEnd(60)}`);

    if (fs.existsSync(filepath)) {
      skipped++;
      continue;
    }

    const streams = await getActivityStreams(accessToken, act.id);
    await sleep(DELAY_MS);

    if (!streams?.latlng?.data?.length) {
      noGps++;
      continue; // activity has no GPS data (e.g. indoor)
    }

    const gpx = buildGpx(act, streams);
    fs.writeFileSync(filepath, gpx, "utf8");
    downloaded++;
  }

  console.log(`\n\n✅ Done!`);
  console.log(`   Downloaded : ${downloaded}`);
  console.log(`   Skipped (already exist): ${skipped}`);
  console.log(`   No GPS data: ${noGps}`);
  console.log(`   Saved to   : ${path.resolve(OUTPUT_DIR)}`);
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});