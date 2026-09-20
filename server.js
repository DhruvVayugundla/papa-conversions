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

const COLLECTIONS = {
  en: "remedies-en",
  te: "remedies-te",
  hi: "remedies-hi",
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = new MongoClient(URI);
let db;
let cachedItems = [];
let cacheLoadedAt = 0;
const CACHE_MS = 60_000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function getVisited() {
  const visited = readJson(VISITED_PATH, []);
  return Array.isArray(visited) ? visited.map(String) : [];
}

function getEntries() {
  const entries = readJson(ENTRIES_PATH, []);
  return Array.isArray(entries) ? entries : [];
}

function oidOf(doc) {
  return String(doc?._id ?? "");
}

async function loadJoined(force = false) {
  const now = Date.now();
  if (!force && cachedItems.length) {
    return cachedItems;
  }

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
      en: enMap.get(oid) || null,
      te: teDoc,
      hi: hiMap.get(oid) || null,
    };
  });
  cacheLoadedAt = now;
  return cachedItems;
}

function stats(items, visited, entries) {
  return {
    remaining: items.filter((item) => !visited.includes(item.oid)).length,
    total: items.length,
    saved: entries.length,
    visited: visited.length,
  };
}

function nextUnvisited(items, visited, afterOid = "") {
  const visitedSet = new Set(visited);
  const start = afterOid ? items.findIndex((item) => item.oid === afterOid) + 1 : 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[(start + i) % items.length];
    if (!visitedSet.has(item.oid)) return item;
    if (i === items.length - 1) break;
  }
  return items.find((item) => !visitedSet.has(item.oid)) || null;
}

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const items = await loadJoined();
    const visited = getVisited();
    const names = items.map((item) => ({ oid: item.oid, name: item.name }));
    const current = nextUnvisited(items, visited);
    res.json({
      names,
      current,
      ...stats(items, visited, getEntries()),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load remedies" });
  }
});

app.get("/api/item/:oid", async (req, res) => {
  try {
    const items = await loadJoined();
    const current = items.find((item) => item.oid === req.params.oid) || null;
    if (!current) return res.status(404).json({ error: "Not found" });
    res.json({ current });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load item" });
  }
});

app.post("/api/next", async (req, res) => {
  try {
    const oid = String(req.body?.oid || "");
    const text = String(req.body?.text ?? "");
    if (!oid) return res.status(400).json({ error: "oid is required" });

    const entries = getEntries();
    entries.push({ oid, text });
    writeJson(ENTRIES_PATH, entries);

    const visited = getVisited();
    if (!visited.includes(oid)) {
      visited.push(oid);
      writeJson(VISITED_PATH, visited);
    }

    const items = await loadJoined();
    const current = nextUnvisited(items, visited, oid);
    res.json({
      current,
      ...stats(items, visited, entries),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save next" });
  }
});

app.post("/api/ok", async (req, res) => {
  try {
    const oid = String(req.body?.oid || "");
    if (!oid) return res.status(400).json({ error: "oid is required" });

    const visited = getVisited();
    if (!visited.includes(oid)) {
      visited.push(oid);
      writeJson(VISITED_PATH, visited);
    }

    const items = await loadJoined();
    const current = nextUnvisited(items, visited, oid);
    res.json({
      current,
      ...stats(items, visited, getEntries()),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to skip item" });
  }
});

app.get("/api/download", (_req, res) => {
  if (!fs.existsSync(ENTRIES_PATH)) writeJson(ENTRIES_PATH, []);
  res.download(ENTRIES_PATH, "entries.json");
});

async function start() {
  if (!URI) {
    console.error("MONGODB_URI is missing");
    process.exit(1);
  }
  await client.connect();
  db = client.db(DB_NAME);
  await loadJoined(true);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ENTRIES_PATH)) writeJson(ENTRIES_PATH, []);
  if (!fs.existsSync(VISITED_PATH)) writeJson(VISITED_PATH, []);
  app.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
