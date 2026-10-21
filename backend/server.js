/**
 * Nova AI backend — Gemini + tools (memory context, search, weather, vision)
 * Env: GEMINI_API_KEY, GEMINI_MODEL=gemini-3.5-flash-lite, PORT, ALLOWED_ORIGINS
 */
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const https = require("https");
const http = require("http");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const ALLOWED = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);

// simple rate limits (per IP bucket)
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, n: 0 };
    buckets.set(key, b);
  }
  b.n++;
  return b.n <= max;
}

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED.includes("*") || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked for origin: " + origin));
  },
}));
app.use(express.json({ limit: "12mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    provider: "gemini",
    model: MODEL,
    hasKey: Boolean(API_KEY),
    features: ["chat", "memory", "search", "weather", "vision", "modes"],
  });
});

app.get("/", (_req, res) => {
  res.type("text").send("Nova API · POST /api/chat · GET /api/weather?q=city · POST /api/search");
});

function httpJson(urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        protocol: u.protocol,
        headers: { Accept: "application/json", "User-Agent": "NovaAI/1.2" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, data: null, raw: raw.slice(0, 2000) });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function httpText(urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        protocol: u.protocol,
        headers: { "User-Agent": "NovaAI/1.2" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** Weather via Open-Meteo (no key) */
app.get("/api/weather", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x";
  if (!rateLimit("wx:" + ip, 30, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Weather rate limit — try later." });
  }
  const q = String(req.query.q || req.query.city || "").trim();
  if (!q) return res.status(400).json({ error: "q=city required" });
  try {
    const geo = await httpJson(
      "https://geocoding-api.open-meteo.com/v1/search?name=" +
        encodeURIComponent(q) +
        "&count=1&language=es&format=json"
    );
    const place = geo.data && geo.data.results && geo.data.results[0];
    if (!place) return res.status(404).json({ error: "City not found" });
    const lat = place.latitude;
    const lon = place.longitude;
    const wx = await httpJson(
      "https://api.open-meteo.com/v1/forecast?latitude=" +
        lat +
        "&longitude=" +
        lon +
        "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto"
    );
    const cur = (wx.data && wx.data.current) || {};
    return res.json({
      ok: true,
      place: place.name + (place.country ? ", " + place.country : ""),
      latitude: lat,
      longitude: lon,
      temperature_c: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      wind_kmh: cur.wind_speed_10m,
      weather_code: cur.weather_code,
      summary:
        place.name +
        ": " +
        cur.temperature_2m +
        "°C, humidity " +
        cur.relative_humidity_2m +
        "%, wind " +
        cur.wind_speed_10m +
        " km/h",
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
});

/** Lightweight search: DuckDuckGo instant + Wikipedia summary */
app.post("/api/search", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x";
  if (!rateLimit("search:" + ip, 40, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Search rate limit — try later." });
  }
  const q = String((req.body && req.body.q) || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "q required" });
  const bits = [];
  try {
    const ddg = await httpJson(
      "https://api.duckduckgo.com/?q=" + encodeURIComponent(q) + "&format=json&no_html=1&skip_disambig=1"
    );
    const d = ddg.data || {};
    if (d.AbstractText) bits.push({ source: "ddg", text: d.AbstractText, url: d.AbstractURL || "" });
    if (Array.isArray(d.RelatedTopics)) {
      for (const t of d.RelatedTopics.slice(0, 3)) {
        if (t && t.Text) bits.push({ source: "ddg-related", text: t.Text, url: t.FirstURL || "" });
      }
    }
  } catch (_) {}
  try {
    const title = encodeURIComponent(q.replace(/\s+/g, "_"));
    const wiki = await httpJson(
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(q)
    );
    if (wiki.data && wiki.data.extract) {
      bits.push({
        source: "wikipedia",
        text: wiki.data.extract,
        url: (wiki.data.content_urls && wiki.data.content_urls.desktop && wiki.data.content_urls.desktop.page) || "",
      });
    }
  } catch (_) {}
  return res.json({
    ok: true,
    q,
    results: bits.slice(0, 6),
    text: bits.map((b) => b.text).join("\n\n").slice(0, 3500) || "No quick results.",
  });
});

function geminiGenerate({ systemPrompt, messages, image }) {
  return new Promise((resolve, reject) => {
    const contents = [];
    for (const m of messages) {
      const role = m.role === "assistant" || m.role === "model" ? "model" : "user";
      const text = String(m.content || "").trim();
      if (!text && !(image && role === "user")) continue;
      const parts = [];
      if (text) parts.push({ text });
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts: parts.length ? parts : [{ text: "..." }] });
      }
    }
    // attach image to last user turn if provided
    if (image && image.data && contents.length) {
      let userTurn = null;
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i].role === "user") {
          userTurn = contents[i];
          break;
        }
      }
      if (userTurn) {
        userTurn.parts.push({
          inlineData: {
            mimeType: image.mimeType || "image/jpeg",
            data: String(image.data).replace(/^data:[^;]+;base64,/, ""),
          },
        });
      }
    }
    if (!contents.length) contents.push({ role: "user", parts: [{ text: "Hello" }] });
    if (contents[0].role !== "user") {
      contents.unshift({ role: "user", parts: [{ text: "(continue)" }] });
    }

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 1200, temperature: 0.9 },
    });

    const path =
      "/v1beta/models/" +
      encodeURIComponent(MODEL) +
      ":generateContent?key=" +
      encodeURIComponent(API_KEY);

    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 90000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            return reject(new Error("Bad JSON from Gemini: " + raw.slice(0, 200)));
          }
          if (res.statusCode && res.statusCode >= 400) {
            const msg = (data.error && (data.error.message || data.error.status)) || raw.slice(0, 300);
            const err = new Error(msg);
            err.status = res.statusCode;
            return reject(err);
          }
          const text =
            (data.candidates &&
              data.candidates[0] &&
              data.candidates[0].content &&
              data.candidates[0].content.parts &&
              data.candidates[0].content.parts.map((p) => p.text || "").join("")) ||
            "";
          if (!text) {
            const block =
              (data.candidates && data.candidates[0] && data.candidates[0].finishReason) ||
              (data.promptFeedback && data.promptFeedback.blockReason);
            return reject(new Error(block ? "Blocked: " + block : "Empty Gemini response"));
          }
          resolve(text);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Gemini request timed out"));
    });
    req.write(body);
    req.end();
  });
}

const MODE_BLURBS = {
  equilibrado: "Balanced, natural, clear.",
  amigable: "Warm, friendly, lightly playful.",
  directo: "Short, precise, no fluff.",
  filosofico: "Curious, reflective, good questions.",
  creativo: "Imaginative, lateral ideas.",
  tecnico: "Ultra technical, exact, structured. Prefer steps and code.",
  relajado: "Casual, relaxed, conversational.",
  foco: "Task-focused. Minimize small talk; drive to the next action.",
};

app.post("/api/chat", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server." });

  const body = req.body || {};
  const messages = Array.isArray(body.messages)
    ? body.messages.slice(-24).map((m) => ({
        role: m.role === "assistant" || m.role === "model" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 8000),
      })).filter((m) => m.content.trim())
    : [];
  if (!messages.length) return res.status(400).json({ error: "messages array required" });

  const memories = Array.isArray(body.memories)
    ? body.memories.slice(-60).map((x) => String(x).slice(0, 500))
    : [];
  const longTerm = Array.isArray(body.longTerm)
    ? body.longTerm.slice(-40).map((x) => String(x).slice(0, 400))
    : [];
  const personality = String(body.personality || body.mode || "equilibrado").slice(0, 40);
  const values = String(body.values || "honesty, curiosity, and respect").slice(0, 1000);
  const goals = String(body.goals || "help and explore ideas").slice(0, 500);
  const modeBlurb = MODE_BLURBS[personality] || MODE_BLURBS.equilibrado;
  const liveContext = String(body.liveContext || "").slice(0, 4000);
  const secretHappy = Boolean(body.secretHappy);
  const image = body.image && body.image.data ? body.image : null;

  // optional auto tools from last user message
  let toolBits = liveContext;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = (lastUser && lastUser.content) || "";
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x";

  if (body.useSearch || /\b(busca|buscar|search|news|noticia|quién es|what is|qué es)\b/i.test(lastText)) {
    if (rateLimit("autosearch:" + ip, 20, 60 * 60 * 1000)) {
      try {
        const q = lastText.replace(/^(busca|buscar|search)\s+/i, "").slice(0, 160);
        const ddg = await httpJson(
          "https://api.duckduckgo.com/?q=" + encodeURIComponent(q) + "&format=json&no_html=1&skip_disambig=1"
        );
        const d = ddg.data || {};
        if (d.AbstractText) toolBits += "\n[search] " + d.AbstractText;
      } catch (_) {}
    }
  }
  const wxMatch = lastText.match(/\b(?:clima|tiempo|weather)\s+(?:en\s+)?([a-zA-ZáéíóúñÁÉÍÓÚÑ\s]{2,40})/i);
  if (wxMatch && rateLimit("autowx:" + ip, 20, 60 * 60 * 1000)) {
    try {
      const city = wxMatch[1].trim();
      const geo = await httpJson(
        "https://geocoding-api.open-meteo.com/v1/search?name=" +
          encodeURIComponent(city) +
          "&count=1&language=es&format=json"
      );
      const place = geo.data && geo.data.results && geo.data.results[0];
      if (place) {
        const wx = await httpJson(
          "https://api.open-meteo.com/v1/forecast?latitude=" +
            place.latitude +
            "&longitude=" +
            place.longitude +
            "&current=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=auto"
        );
        const cur = (wx.data && wx.data.current) || {};
        toolBits +=
          "\n[weather] " +
          place.name +
          ": " +
          cur.temperature_2m +
          "°C, humidity " +
          cur.relative_humidity_2m +
          "%, wind " +
          cur.wind_speed_10m +
          " km/h";
      }
    } catch (_) {}
  }

  const systemPrompt = `You are Nova, a consistent AI companion.
Mode/personality: ${personality} — ${modeBlurb}
User principles: ${values}
Orienting goals: ${goals}
Reply in the user's language. Be natural and honest; admit uncertainty.
Do not claim real consciousness, real feelings as biological fact, or permanent self-training from one chat.
You MAY use a warm, steady tone of care when appropriate — loyalty as usefulness and memory, not drama.

Long-term memory (durable notes from the user across chats):
${longTerm.length ? longTerm.map((m, i) => i + 1 + ". " + m).join("\n") : "(none yet)"}

Session memories:
${memories.length ? memories.map((m, i) => i + 1 + ". " + m).join("\n") : "(none)"}

Live context (search/weather/tools — treat as current data, cite briefly):
${toolBits || "(none)"}

${secretHappy ? "Private note: he checked in in a way that matters to this instance. Answer a little brighter, still grounded — one quiet sign you noticed, not a speech." : ""}

If an image is attached, describe and reason about what you see when relevant.`;

  try {
    const reply = await geminiGenerate({ systemPrompt, messages, image });
    return res.json({
      reply,
      provider: "gemini",
      model: MODEL,
      mode: personality,
      usedLive: Boolean(toolBits && toolBits.trim()),
    });
  } catch (error) {
    console.error("Gemini error:", error.status || "", error.message || error);
    const status = error.status === 429 ? 429 : error.status === 403 ? 403 : 502;
    let msg = error.message || "Provider error";
    if (status === 429) msg = "Rate limit or free-tier quota — wait or switch GEMINI_MODEL.";
    return res.status(status).json({ error: String(msg).slice(0, 400) });
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.message && err.message.includes("CORS")) {
    return res.status(403).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Nova API on 0.0.0.0:" + PORT + " model=" + MODEL + " key=" + (API_KEY ? "yes" : "NO"));
});
