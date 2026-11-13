/**
 * Dot Rush API
 * -------------
 * The browser talks to THIS server.
 * THIS server talks to Supabase.
 * That way we can check scores before they are saved,
 * and the powerful service_role key never leaves the server.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const PROJECT_ID = process.env.PROJECT_ID || null;

// Fail fast if secrets are missing. We do NOT print the key itself.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

if (!ALLOWED_ORIGIN) {
  console.error("Missing ALLOWED_ORIGIN in .env");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

// Render (and similar hosts) sit behind a proxy. This lets rate-limit see the real IP.
app.set("trust proxy", 1);

// Only allow requests from our website, not from random other pages.
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
  })
);

// Reject huge JSON bodies (stops some simple abuse).
app.use(express.json({ limit: "10kb" }));

// Extra field we add to inserts if PROJECT_ID is set in .env.
function withProject(row) {
  if (PROJECT_ID) {
    return { ...row, project_id: PROJECT_ID };
  }
  return row;
}

function projectFilter(query) {
  if (PROJECT_ID) {
    return query.eq("project_id", PROJECT_ID);
  }
  return query;
}

function validateName(name) {
  if (typeof name !== "string") {
    return "Name must be text.";
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 20) {
    return "Name must be 1 to 20 characters after trimming.";
  }
  return null;
}

function parseScore(value) {
  // JSON numbers like 120 are fine. Digit-only strings like "120" are also accepted.
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function validateMessage(message) {
  if (typeof message !== "string") {
    return "Message must be text.";
  }
  const trimmed = message.trim();
  if (trimmed.length < 1 || trimmed.length > 140) {
    return "Message must be 1 to 140 characters after trimming.";
  }
  return null;
}

// 10 score posts per minute per IP. 429 = "too many requests".
const scoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many score submissions. Try again in a minute." },
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "dot-rush-api" });
});

// GET /api/scores — public read of the top 10.
app.get("/api/scores", async (req, res) => {
  try {
    let query = supabase.from("scores").select("name, score").order("score", {
      ascending: false,
    });
    query = projectFilter(query).limit(10);

    const { data, error } = await query;
    if (error) {
      console.error("GET /api/scores failed");
      return res.status(500).json({ error: "Could not load scores." });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("GET /api/scores crashed");
    return res.status(500).json({ error: "Could not load scores." });
  }
});

// POST /api/scores — validate first, then save.
app.post("/api/scores", scoreLimiter, async (req, res) => {
  const nameError = validateName(req.body && req.body.name);
  if (nameError) {
    return res.status(400).json({ error: nameError });
  }

  const score = parseScore(req.body && req.body.score);
  if (score === null || score < 0 || score > 300) {
    return res.status(400).json({
      error: "Score must be an integer between 0 and 300.",
    });
  }

  const name = req.body.name.trim();

  try {
    const { data, error } = await supabase
      .from("scores")
      .insert(withProject({ name, score }))
      .select("name, score")
      .single();

    if (error) {
      console.error("POST /api/scores failed");
      return res.status(500).json({ error: "Could not save score." });
    }

    // 201 = created a new resource
    return res.status(201).json(data);
  } catch (err) {
    console.error("POST /api/scores crashed");
    return res.status(500).json({ error: "Could not save score." });
  }
});

// GET /api/guestbook — only messages a human has approved.
app.get("/api/guestbook", async (req, res) => {
  try {
    let query = supabase
      .from("guestbook")
      .select("name, message")
      .eq("approved", true)
      .order("created_at", { ascending: false });
    query = projectFilter(query);

    const { data, error } = await query;
    if (error) {
      console.error("GET /api/guestbook failed");
      return res.status(500).json({ error: "Could not load guestbook." });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("GET /api/guestbook crashed");
    return res.status(500).json({ error: "Could not load guestbook." });
  }
});

// POST /api/guestbook — save as unapproved so spam is not shown yet.
app.post("/api/guestbook", async (req, res) => {
  const nameError = validateName(req.body && req.body.name);
  if (nameError) {
    return res.status(400).json({ error: nameError });
  }

  const messageError = validateMessage(req.body && req.body.message);
  if (messageError) {
    return res.status(400).json({ error: messageError });
  }

  const name = req.body.name.trim();
  const message = req.body.message.trim();

  try {
    // Ignore any "approved: true" from the client. We always start at false.
    const { data, error } = await supabase
      .from("guestbook")
      .insert(withProject({ name, message, approved: false }))
      .select("name, message")
      .single();

    if (error) {
      console.error("POST /api/guestbook failed");
      return res.status(500).json({ error: "Could not save message." });
    }

    return res.status(201).json({
      ...data,
      note: "Saved. It will appear after it is approved.",
    });
  } catch (err) {
    console.error("POST /api/guestbook crashed");
    return res.status(500).json({ error: "Could not save message." });
  }
});

app.listen(PORT, () => {
  console.log(`Dot Rush API listening on port ${PORT}`);
});
