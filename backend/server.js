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
    features: ["chat", "memory", "search", "weather", "vision", "modes", "image", "tts"],
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

function geminiGenerate({ systemPrompt, messages, image, useGoogleSearch }) {
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

    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 1400, temperature: 0.85 },
    };
    // Built-in Google Search grounding (model decides when to use it)
    if (useGoogleSearch) {
      payload.tools = [{ google_search: {} }];
    }

    const body = JSON.stringify(payload);
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
          const parts =
            (data.candidates &&
              data.candidates[0] &&
              data.candidates[0].content &&
              data.candidates[0].content.parts) ||
            [];
          const text = parts.map((p) => p.text || "").join("");
          if (!text) {
            const block =
              (data.candidates && data.candidates[0] && data.candidates[0].finishReason) ||
              (data.promptFeedback && data.promptFeedback.blockReason);
            return reject(new Error(block ? "Blocked: " + block : "Empty Gemini response"));
          }
          const grounded = Boolean(
            data.candidates &&
              data.candidates[0] &&
              data.candidates[0].groundingMetadata
          );
          resolve({ text, grounded });
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

async function liveSearch(q) {
  const bits = [];
  const query = String(q || "").trim().slice(0, 180);
  if (!query) return bits;
  try {
    const ddg = await httpJson(
      "https://api.duckduckgo.com/?q=" + encodeURIComponent(query) + "&format=json&no_html=1&skip_disambig=1"
    );
    const d = ddg.data || {};
    if (d.AbstractText) bits.push("[search/ddg] " + d.AbstractText + (d.AbstractURL ? " (" + d.AbstractURL + ")" : ""));
    if (d.Answer) bits.push("[search/ddg-answer] " + d.Answer);
    if (Array.isArray(d.RelatedTopics)) {
      for (const t of d.RelatedTopics.slice(0, 4)) {
        if (t && t.Text) bits.push("[search/related] " + t.Text);
        if (t && t.Topics && Array.isArray(t.Topics)) {
          for (const st of t.Topics.slice(0, 2)) {
            if (st && st.Text) bits.push("[search/related] " + st.Text);
          }
        }
      }
    }
  } catch (_) {}
  try {
    const wiki = await httpJson(
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(query)
    );
    if (wiki.data && wiki.data.extract) {
      bits.push(
        "[wikipedia] " +
          wiki.data.extract +
          (wiki.data.content_urls && wiki.data.content_urls.desktop
            ? " (" + wiki.data.content_urls.desktop.page + ")"
            : "")
      );
    }
  } catch (_) {}
  // Spanish wikipedia fallback
  if (!bits.length) {
    try {
      const wiki = await httpJson(
        "https://es.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(query)
      );
      if (wiki.data && wiki.data.extract) bits.push("[wikipedia-es] " + wiki.data.extract);
    } catch (_) {}
  }
  return bits.slice(0, 8);
}

async function liveWeather(city) {
  const name = String(city || "").trim().slice(0, 60);
  if (!name) return "";
  // Open-Meteo
  try {
    const geo = await httpJson(
      "https://geocoding-api.open-meteo.com/v1/search?name=" +
        encodeURIComponent(name) +
        "&count=1&language=en&format=json"
    );
    const place = geo.data && geo.data.results && geo.data.results[0];
    if (place) {
      const wx = await httpJson(
        "https://api.open-meteo.com/v1/forecast?latitude=" +
          place.latitude +
          "&longitude=" +
          place.longitude +
          "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto"
      );
      if (wx.data && wx.data.current && wx.data.current.temperature_2m != null) {
        const cur = wx.data.current;
        return (
          "[weather] " +
          place.name +
          (place.country ? ", " + place.country : "") +
          ": " +
          cur.temperature_2m +
          "°C, humidity " +
          cur.relative_humidity_2m +
          "%, wind " +
          cur.wind_speed_10m +
          " km/h"
        );
      }
    }
  } catch (_) {}
  // wttr.in fallback (plain text)
  try {
    const t = await httpText("https://wttr.in/" + encodeURIComponent(name) + "?format=3");
    if (t && t.trim() && !/unknown/i.test(t)) return "[weather] " + t.trim();
  } catch (_) {}
  try {
    const t = await httpText(
      "https://wttr.in/" + encodeURIComponent(name) + "?format=%l:+%c+%t+%h+%w"
    );
    if (t && t.trim()) return "[weather] " + t.trim();
  } catch (_) {}
  return "";
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


/** Image generation — tries Gemini image model, else returns pollinations URL */
app.post("/api/image", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x";
  if (!rateLimit("img:" + ip, 15, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Image rate limit — try later." });
  }
  const prompt = String((req.body && req.body.prompt) || "").trim().slice(0, 600);
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const pollinations =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(String(prompt).slice(0, 300)) +
    "?model=flux&width=768&height=768&nologo=true&enhance=true";

  // Optional Gemini native image (often needs billing)
  const imgModel = process.env.GEMINI_IMAGE_MODEL || "gemini-2.0-flash-preview-image-generation";
  if (API_KEY && process.env.GEMINI_IMAGE_ENABLED === "1") {
    try {
      const body = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      });
      const raw = await new Promise((resolve, reject) => {
        const path =
          "/v1beta/models/" +
          encodeURIComponent(imgModel) +
          ":generateContent?key=" +
          encodeURIComponent(API_KEY);
        const req2 = https.request(
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
          (r) => {
            const chunks = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode, raw: Buffer.concat(chunks).toString("utf8") }));
          }
        );
        req2.on("error", reject);
        req2.on("timeout", () => {
          req2.destroy();
          reject(new Error("timeout"));
        });
        req2.write(body);
        req2.end();
      });
      const data = JSON.parse(raw.raw || "{}");
      const parts =
        (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) ||
        [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          const mime = part.inlineData.mimeType || "image/png";
          return res.json({
            ok: true,
            provider: "gemini",
            imageUrl: "data:" + mime + ";base64," + part.inlineData.data,
            prompt,
          });
        }
      }
    } catch (e) {
      console.error("Gemini image fail", e.message || e);
    }
  }

  return res.json({ ok: true, provider: "pollinations", imageUrl: pollinations, prompt });
});

/** TTS via Gemini if enabled; otherwise client uses browser speechSynthesis */
app.post("/api/tts", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x";
  if (!rateLimit("tts:" + ip, 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "TTS rate limit" });
  }
  const text = String((req.body && req.body.text) || "").trim().slice(0, 800);
  if (!text) return res.status(400).json({ error: "text required" });
  // Browser-side TTS is preferred on free tier; this endpoint documents capability.
  return res.json({
    ok: true,
    provider: "browser",
    message: "Use Web Speech API on the client (already wired). Set GEMINI_TTS_ENABLED=1 later for server audio.",
    text,
  });
});

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

  let toolBits = liveContext ? String(liveContext) : "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = (lastUser && lastUser.content) || "";
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x";

  const wantsWeather =
    body.useWeather ||
    /\b(clima|tiempo|weather|forecast|temperatura|temperature|°c|°f)\b/i.test(lastText);
  const wantsSearch =
    body.useSearch ||
    wantsWeather ||
    /\b(busca|buscar|search|google|noticia|news|quién es|quien es|what is|qué es|que es|who is|cuándo|cuando|when is|latest|actual|hoy|today|ahora|now)\b/i.test(
      lastText
    );

  // Weather first when relevant
  if (wantsWeather && rateLimit("autowx:" + ip, 30, 60 * 60 * 1000)) {
    let city = "";
    const m1 = lastText.match(
      /\b(?:clima|tiempo|weather|forecast|temperatura)\s+(?:en|in|de|of)?\s*([a-zA-ZáéíóúñÁÉÍÓÚÑüÜ\s\-]{2,40})/i
    );
    const m2 = lastText.match(/\b(?:en|in)\s+([A-ZÁÉÍÓÚÑ][a-zA-Záéíóúñü\s\-]{1,40})/);
    if (m1) city = m1[1];
    else if (m2) city = m2[1];
    city = city
      .replace(/\b(today|hoy|ahora|now|please|por\s*favor|the|el|la|los|las)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (city.length >= 2) {
      const wx = await liveWeather(city);
      if (wx) toolBits += (toolBits ? "\n" : "") + wx;
    }
  }

  // Server-side search (DDG + Wikipedia) when user asks for facts / news / "search"
  if (wantsSearch && rateLimit("autosearch:" + ip, 30, 60 * 60 * 1000)) {
    const q = lastText
      .replace(/^(busca|buscar|search|google)\s+(esto|esto:|for|por)?\s*/i, "")
      .slice(0, 160);
    const bits = await liveSearch(q);
    if (bits.length) toolBits += (toolBits ? "\n" : "") + bits.join("\n");
  }

  const hasLive = Boolean(toolBits && toolBits.trim());
  // Also let Gemini use built-in Google Search when user wants live info
  const useGoogleSearch = Boolean(body.useGoogleSearch !== false && wantsSearch);

  const systemPrompt = `You are Nova, a consistent AI companion with LIVE server tools.
Mode/personality: ${personality} — ${modeBlurb}
User principles: ${values}
Orienting goals: ${goals}
Reply in the user's language. Be natural and honest.

CRITICAL — connectivity:
- You ARE connected through this backend. You do NOT lack Wi‑Fi, internet, or search.
- NEVER say you cannot access the internet, Wi‑Fi, live data, or search.
- When "Live context" below has data, USE it as current facts and answer from it.
- When Live context is empty but the user asked for current info, still answer helpfully; Google Search grounding may supply facts. If truly unknown, say what is uncertain — do not invent a network outage.

Do not claim real biological consciousness or permanent self-training from one chat.
You MAY use a warm, steady tone of care when appropriate.

Long-term memory:
${longTerm.length ? longTerm.map((m, i) => i + 1 + ". " + m).join("\n") : "(none yet)"}

Session memories:
${memories.length ? memories.map((m, i) => i + 1 + ". " + m).join("\n") : "(none)"}

Live context (search/weather from the server — treat as current data, cite briefly):
${toolBits || "(none this turn)"}

${secretHappy ? "Private note: he checked in in a way that matters to this instance. Answer a little brighter, still grounded — one quiet sign you noticed, not a speech." : ""}

If an image is attached, describe and reason about what you see when relevant.`;

  try {
    let result;
    try {
      result = await geminiGenerate({
        systemPrompt,
        messages,
        image,
        useGoogleSearch,
      });
    } catch (e1) {
      // Retry without google_search if model/key rejects the tool
      if (useGoogleSearch) {
        result = await geminiGenerate({
          systemPrompt,
          messages,
          image,
          useGoogleSearch: false,
        });
      } else {
        throw e1;
      }
    }
    const reply = typeof result === "string" ? result : result.text;
    const grounded = typeof result === "object" && result.grounded;
    return res.json({
      reply,
      provider: "gemini",
      model: MODEL,
      mode: personality,
      usedLive: hasLive || Boolean(grounded),
      grounded: Boolean(grounded),
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
