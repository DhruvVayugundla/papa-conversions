import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient, ObjectId } from "mongodb";

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
const COLLECTIONS = {
  en: "remedies-en",
  te: "remedies-te",
  hi: "remedies-hi",
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = URI
  ? new MongoClient(URI, { serverSelectionTimeoutMS: 8000 })
  : null;
let db;
let visited = [];

async function markVisited(oid) {
  // Prefer updating the MongoDB document directly. If DB isn't available,
  // update the in-memory fallback list.
  if (!db) {
    if (!visited.includes(oid)) visited.push(oid);
    return;
  }
  try {
    const id = ObjectId.isValid(oid) ? new ObjectId(oid) : oid;
    await db
      .collection(COLLECTIONS.te)
      .updateOne({ _id: id }, { $set: { visited: true } });
    if (!visited.includes(oid)) visited.push(oid);
  } catch (err) {
    console.error("Failed to mark visited in DB", err);
  }
}

function oidOf(doc) {
  return String(doc?._id ?? "");
}

async function loadJoined() {
  if (!db) throw new Error("MongoDB connection is required");
  const [en, te, hi] = await Promise.all([
    db.collection(COLLECTIONS.en).find({}).toArray(),
    db.collection(COLLECTIONS.te).find({}).toArray(),
    db.collection(COLLECTIONS.hi).find({}).toArray(),
  ]);

  await db
    .collection(COLLECTIONS.te)
    .updateMany({ visited: { $exists: false } }, { $set: { visited: false } });

  const enMap = new Map(en.map((d) => [oidOf(d), d]));
  const hiMap = new Map(hi.map((d) => [oidOf(d), d]));

  // derive visited list from te docs' visited field when present
  visited = te.filter((t) => t && t.visited === true).map((t) => oidOf(t));

  const items = te.map((teDoc) => {
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
  return items;
}

function stats(items) {
  return {
    remaining: items.filter((item) => !visited.includes(item.oid)).length,
    total: items.length,
    saved: items.filter((item) => item.te && item.te.correction).length,
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
  const start = afterOid
    ? pool.findIndex((item) => item.oid === afterOid) + 1
    : 0;
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

// /api/next removed — Next button is no longer used.

app.post("/api/ok", async (req, res) => {
  try {
    const oid = String(req.body?.oid || "");
    const issue = String(req.body?.issue ?? "");
    const enDoc = req.body?.en;
    const teDoc = req.body?.te;
    const hiDoc = req.body?.hi;
    const correction = String(req.body?.correction ?? "").trim();
    if (!oid) return res.status(400).json({ error: "oid is required" });
    if (!db)
      return res.status(500).json({ error: "MongoDB required for saving" });
    const id = ObjectId.isValid(oid) ? new ObjectId(oid) : oid;
    // Update each language collection if a doc payload is present
    try {
      if (enDoc) {
        const set = {
          ...(enDoc.name ? { name: enDoc.name } : {}),
          ...(enDoc.issue ? { issue: enDoc.issue } : {}),
          ...(Array.isArray(enDoc.ingredients)
            ? { ingredients: enDoc.ingredients }
            : {}),
          ...(enDoc.procedure ? { procedure: enDoc.procedure } : {}),
          ...(enDoc.precautions ? { precautions: enDoc.precautions } : {}),
        };
        if (Object.keys(set).length)
          await db
            .collection(COLLECTIONS.en)
            .updateOne({ _id: id }, { $set: set }, { upsert: false });
      }
      if (teDoc) {
        const set = {
          ...(teDoc.name ? { name: teDoc.name } : {}),
          ...(teDoc.issue ? { issue: teDoc.issue } : {}),
          ...(Array.isArray(teDoc.ingredients)
            ? { ingredients: teDoc.ingredients }
            : {}),
          ...(teDoc.procedure ? { procedure: teDoc.procedure } : {}),
          ...(teDoc.precautions ? { precautions: teDoc.precautions } : {}),
        };
        if (correction) set.correction = correction;
        // ensure visited field is set
        set.visited = true;
        if (Object.keys(set).length)
          await db
            .collection(COLLECTIONS.te)
            .updateOne({ _id: id }, { $set: set }, { upsert: false });
      }
      if (!teDoc) {
        const set = { visited: true };
        if (correction) set.correction = correction;
        await db
          .collection(COLLECTIONS.te)
          .updateOne({ _id: id }, { $set: set }, { upsert: false });
      }
      if (hiDoc) {
        const set = {
          ...(hiDoc.name ? { name: hiDoc.name } : {}),
          ...(hiDoc.issue ? { issue: hiDoc.issue } : {}),
          ...(Array.isArray(hiDoc.ingredients)
            ? { ingredients: hiDoc.ingredients }
            : {}),
          ...(hiDoc.procedure ? { procedure: hiDoc.procedure } : {}),
          ...(hiDoc.precautions ? { precautions: hiDoc.precautions } : {}),
        };
        if (Object.keys(set).length)
          await db
            .collection(COLLECTIONS.hi)
            .updateOne({ _id: id }, { $set: set }, { upsert: false });
      }
    } catch (err) {
      console.error("Failed to update language docs", err);
      return res.status(500).json({ error: "Failed to update docs" });
    }

    await markVisited(oid);

    const items = await loadJoined();
    const current = nextUnvisited(items, oid, issue);
    res.json({ current, ...stats(scopedItems(items, issue)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to skip item" });
  }
});

// download endpoint removed — no local JSON exports.

async function start() {
  app.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT}`);
  });

  if (!client) {
    console.error("MONGODB_URI is missing; MongoDB is required");
    return;
  }

  try {
    await client.connect();
    db = client.db(DB_NAME);
    const items = await loadJoined();
    console.log(`Loaded ${items.length} remedies from MongoDB`);
  } catch (err) {
    console.error("Could not connect to MongoDB", err);
  }
}

function shutdown() {
  if (client) client.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
