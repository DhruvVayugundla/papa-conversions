import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "papaweb";
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const ENTRIES_PATH = path.join(DATA_DIR, "entries.json");
const VISITED_PATH = path.join(DATA_DIR, "visited.json");
const CACHE_PATH = path.join(DATA_DIR, "remedies-cache.json");

const COLLECTIONS = {
  en: "remedies-en",
  te: "remedies-te",
  hi: "remedies-hi",
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = URI ? new MongoClient(URI, { serverSelectionTimeoutMS: 8000 }) : null;
let db;
let cachedItems = [];
let visited = [];
let entries = [];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.copyFileSync(tmp, file);
  fs.unlinkSync(tmp);
}

function loadDiskState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const rawVisited = readJson(VISITED_PATH, []);
  visited = Array.isArray(rawVisited) ? rawVisited.map(String) : [];
  const rawEntries = readJson(ENTRIES_PATH, []);
  entries = Array.isArray(rawEntries) ? rawEntries : [];
  if (!fs.existsSync(VISITED_PATH)) writeJson(VISITED_PATH, visited);
  if (!fs.existsSync(ENTRIES_PATH)) writeJson(ENTRIES_PATH, entries);
}

function persistVisited() {
  writeJson(VISITED_PATH, visited);
}

function persistEntries() {
  writeJson(ENTRIES_PATH, entries);
}

function persistCache() {
  writeJson(CACHE_PATH, cachedItems);
}

function markVisited(oid) {
  if (!visited.includes(oid)) {
    visited.push(oid);
    persistVisited();
  }
}

function oidOf(doc) {
  return String(doc?._id ?? "");
}

async function loadJoined(force = false) {
  if (!force && cachedItems.length) return cachedItems;

  if (db) {
    try {
      const [en, te, hi] = await Promise.all([
        db.collection(COLLECTIONS.en).find({}).toArray(),
        db.collection(COLLECTIONS.te).find({}).toArray(),
        db.collection(COLLECTIONS.hi).find({}).toArray(),
      ]);

      const enMap = new Map(en.map((d) => [oidOf(d), d]));
      const hiMap = new Map(hi.map((d) => [oidOf(d), d]));

      cachedItems = te.map((teDoc) => {
        const oid = oidOf(teDoc);
        return {
          oid,
          name: teDoc.name || "",
          issue: teDoc.issue || "",
          en: enMap.get(oid) || null,
          te: teDoc,
          hi: hiMap.get(oid) || null,
        };
      });
      persistCache();
      return cachedItems;
    } catch (err) {
      console.error("Mongo load failed, using local cache if available", err);
    }
  }

  const cached = readJson(CACHE_PATH, []);
  if (Array.isArray(cached) && cached.length) {
    cachedItems = cached;
    return cachedItems;
  }

  throw new Error("No remedies available from MongoDB or local cache");
}

function stats(items) {
  return {
    remaining: items.filter((item) => !visited.includes(item.oid)).length,
    total: items.length,
    saved: entries.length,
    visited: visited.length,
  };
}

function uniqueIssues(items) {
  const seen = new Set();
  const issues = [];
  for (const item of items) {
    if (!item.issue || seen.has(item.issue)) continue;
    seen.add(item.issue);
    issues.push(item.issue);
  }
  return issues;
}

function scopedItems(items, issue) {
  if (!issue) return items;
  return items.filter((item) => item.issue === issue);
}

function nextUnvisited(items, afterOid = "", issue = "") {
  const pool = scopedItems(items, issue);
  const visitedSet = new Set(visited);
  const start = afterOid ? pool.findIndex((item) => item.oid === afterOid) + 1 : 0;
  for (let i = 0; i < pool.length; i += 1) {
    const item = pool[(start + i) % pool.length];
    if (!visitedSet.has(item.oid)) return item;
    if (i === pool.length - 1) break;
  }
  return pool.find((item) => !visitedSet.has(item.oid)) || null;
}

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const items = await loadJoined();
    const issues = uniqueIssues(items);
    const current = nextUnvisited(items);
    res.json({
      issues,
      current,
      ...stats(items),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load remedies" });
  }
});

app.get("/api/filter", async (req, res) => {
  try {
    const issue = String(req.query.issue || "");
    const items = await loadJoined();
    const current = nextUnvisited(items, "", issue);
    res.json({
      current,
      ...stats(scopedItems(items, issue)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to filter items" });
  }
});

app.post("/api/next", async (req, res) => {
  try {
    const oid = String(req.body?.oid || "");
    const issue = String(req.body?.issue ?? "");
    const text = String(req.body?.text ?? "");
    if (!oid) return res.status(400).json({ error: "oid is required" });

    entries.push({ oid, text });
    persistEntries();
    markVisited(oid);

    const items = await loadJoined();
    const current = nextUnvisited(items, oid, issue);
    res.json({
      current,
      ...stats(scopedItems(items, issue)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save next" });
  }
});

app.post("/api/ok", async (req, res) => {
  try {
    const oid = String(req.body?.oid || "");
    const issue = String(req.body?.issue ?? "");
    if (!oid) return res.status(400).json({ error: "oid is required" });

    markVisited(oid);

    const items = await loadJoined();
    const current = nextUnvisited(items, oid, issue);
    res.json({
      current,
      ...stats(scopedItems(items, issue)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to skip item" });
  }
});

app.get("/api/download", (_req, res) => {
  persistEntries();
  persistVisited();
  res.download(ENTRIES_PATH, "entries.json");
});

async function start() {
  loadDiskState();
  const cached = readJson(CACHE_PATH, []);
  if (Array.isArray(cached) && cached.length) cachedItems = cached;

  app.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT}`);
    console.log(`Visited: ${VISITED_PATH}`);
    console.log(`Entries: ${ENTRIES_PATH}`);
  });

  if (!client) {
    console.error("MONGODB_URI is missing; serving from local cache only");
    return;
  }

  try {
    await client.connect();
    db = client.db(DB_NAME);
    await loadJoined(true);
    console.log(`Loaded ${cachedItems.length} remedies from MongoDB`);
  } catch (err) {
    console.error("Could not connect to MongoDB; using local files if present", err);
  }
}

function shutdown() {
  persistEntries();
  persistVisited();
  if (client) client.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
