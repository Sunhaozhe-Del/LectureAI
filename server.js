require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY is not set. Add it to .env before generating AI content.");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static("public"));

const translationCache = new Map();
const lectureMemory = new Map();
const LANG = { zh: "Simplified Chinese", en: "English", vi: "Vietnamese" };

const SUBJECT_TERMS = {
  mathematics: "Use standard university mathematics/calculus terminology.",
  physics: "Use standard university physics terminology and preserve equations/units.",
  chemistry: "Use standard chemistry terminology, symbols, formulas and nomenclature.",
  biology: "Use standard university biology terminology and distinguish mechanisms carefully.",
  computer_science: "Use standard computer science terminology; preserve code and identifiers.",
  electrical_engineering: "Use standard electrical/electronic engineering terminology and preserve symbols/units.",
  engineering: "Use standard engineering terminology and preserve units, variables and equations.",
  statistics: "Use standard statistics/data-science terminology and preserve notation.",
  economics: "Use standard economics terminology and distinguish technical from everyday meanings.",
  business: "Use standard business/management terminology.",
  accounting_finance: "Use standard accounting/finance terminology and preserve financial notation.",
  law: "Use standard legal terminology and avoid inventing legal conclusions.",
  psychology: "Use standard psychology terminology and distinguish constructs carefully.",
  medicine: "Use standard medical/health terminology and preserve anatomical/clinical terms.",
  architecture_design: "Use standard architecture/design terminology.",
  general: "Use clear university-level terminology appropriate to the lecture."
};

function clean(text, max = 90000) { return String(text || "").trim().slice(0, max); }
function languageName(code) { return LANG[code] || LANG.zh; }
function key(obj) { return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }

async function ask(instructions, input) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY 未设置。请在 .env 中填写 API key，然后重新启动服务器。");
  const result = await client.responses.create({ model: process.env.LECTUREAI_MODEL || "gpt-5-mini", instructions, input });
  return (result.output_text || "").trim();
}

function jsonFrom(text) {
  const cleaned = String(text || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const starts = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter(x => x >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  return JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
}

function memoryFor(lectureId) {
  if (!lectureMemory.has(lectureId)) {
    lectureMemory.set(lectureId, { chunks: [], topics: [], concepts: [], terms: [], formulas: [], examples: [], examPoints: [] });
  }
  return lectureMemory.get(lectureId);
}

function mergeMemory(memory, data) {
  for (const field of ["topics", "concepts", "terms", "formulas", "examples", "examPoints"]) {
    const incoming = Array.isArray(data[field]) ? data[field] : [];
    const existing = Array.isArray(memory[field]) ? memory[field] : [];
    const values = [...existing, ...incoming].map(x => typeof x === "string" ? x.trim() : x).filter(Boolean);
    memory[field] = values.filter((v, i, a) => a.findIndex(x => JSON.stringify(x) === JSON.stringify(v)) === i).slice(-120);
  }
  return memory;
}

function contextText(memory) { return JSON.stringify(memory || {}).slice(-50000); }
function basePrompt({ course, lectureTitle, language, context }) {
  return `You are LectureAI, an AI study companion for a university lecture.
Course: ${course}. ${SUBJECT_TERMS[course] || SUBJECT_TERMS.general}
Lecture: ${lectureTitle}
Output language: ${languageName(language)}.
Be concise, structured and useful for revision. Do not invent material. Prefer the lecture transcript and context memory over generic knowledge.
Lecture Memory:\n${contextText(context)}`;
}

app.get("/api/status", (req, res) => res.json({
  ok: true,
  message: "LectureAI server is running",
  version: "7.0.0",
  port: PORT,
  model: process.env.LECTUREAI_MODEL || "gpt-5-mini",
  configured: Boolean(process.env.OPENAI_API_KEY)
}));

app.post("/api/translate", async (req, res) => {
  try {
    const text = clean(req.body.text, 4000);
    const course = req.body.course || "general";
    const target = req.body.targetLanguage || "zh";
    const mode = req.body.mode || "fast";
    const previous = clean(req.body.previousContext, 1800);
    if (!text) return res.status(400).json({ error: "没有收到字幕" });

    const cacheKey = key({ target, course, text });
    if (translationCache.has(cacheKey)) return res.json({ translation: translationCache.get(cacheKey), cached: true });

    const instructions = `You are LectureAI's real-time university lecture translator.
Target language: ${languageName(target)}.
Course mode: ${course}. ${SUBJECT_TERMS[course] || SUBJECT_TERMS.general}
Translation mode: ${mode === "accurate" ? "prioritize contextual accuracy over speed" : "prioritize concise low-latency output"}.
Translate the subtitle accurately and concisely. Use context-aware technical terminology.
Preserve formulas, symbols, numbers, names, units and mathematical relationships exactly.
Do not summarize, explain, add notes, or repeat the source.
If the sentence is incomplete, translate naturally without inventing missing content.
${previous ? `Recent lecture context (use only to resolve terminology):\n${previous}` : ""}
Return ONLY the translation.`;

    const translation = await ask(instructions, text);
    translationCache.set(cacheKey, translation);
    if (translationCache.size > 3000) translationCache.delete(translationCache.keys().next().value);
    res.json({ translation, cached: false });
  } catch (e) {
    console.error("Translation error:", e);
    res.status(500).json({ error: e.message || "Translation failed" });
  }
});

app.post("/api/context", async (req, res) => {
  try {
    const lectureId = clean(req.body.lectureId, 500);
    const course = req.body.course || "general";
    const transcript = clean(req.body.transcript, 18000);
    const language = req.body.language || "zh";
    if (!lectureId || !transcript) return res.status(400).json({ error: "缺少 lectureId 或 transcript" });

    const memory = memoryFor(lectureId);
    const previous = JSON.stringify(memory).slice(-22000);
    const instructions = `You are the LectureAI Context Engine.
Course: ${course}. ${SUBJECT_TERMS[course] || SUBJECT_TERMS.general}
Extract reliable classroom context from the new lecture segment. Do not invent facts. If uncertain, omit the item.
Return JSON only with this shape:
{"topic":"string","concepts":["..."],"terms":[{"term":"","definition":""}],"formulas":["..."],"examples":["..."],"examPoints":["..."]}
Keep it concise. Definitions may use ${languageName(language)}. Preserve technical English terms where useful.
Previous memory is context only; the new transcript is the source of truth.
Previous memory:\n${previous}`;

    const data = jsonFrom(await ask(instructions, `NEW LECTURE SEGMENT:\n${transcript}`));
    if (data.topic) memory.topics.push(data.topic);
    mergeMemory(memory, data);
    memory.chunks.push({ at: Date.now(), transcript: transcript.slice(-18000) });
    memory.chunks = memory.chunks.slice(-30);
    res.json({ context: { ...memory, currentTopic: data.topic || memory.topics.at(-1) || "" } });
  } catch (e) {
    console.error("Context error:", e);
    res.status(500).json({ error: e.message || "Context update failed" });
  }
});

app.post("/api/summary", async (req, res) => {
  try {
    const transcript = clean(req.body.transcript, 90000);
    const course = req.body.course || "general";
    const lectureTitle = req.body.lectureTitle || "University Lecture";
    const language = req.body.language || "zh";
    const context = req.body.context || null;
    if (!transcript) return res.status(400).json({ error: "没有收到 Transcript" });
    const instructions = basePrompt({ course, lectureTitle, language, context }) + `
Write a high-quality but reasonably concise lecture summary in ${languageName(language)}.
Use exactly these headings when relevant:
1. Core Concepts
2. Important Formulas / Methods
3. Worked Examples
4. Common Mistakes
5. Exam / Revision Focus
Do not repeat the transcript. Preserve formulas and technical terminology.`;
    res.json({ summary: await ask(instructions, `Lecture transcript:\n${transcript}`) });
  } catch (e) { console.error("Summary error:", e); res.status(500).json({ error: e.message || "Summary generation failed" }); }
});

app.post("/api/terms", async (req, res) => {
  try {
    const transcript = clean(req.body.transcript, 90000), course = req.body.course || "general", lectureTitle = req.body.lectureTitle || "University Lecture", language = req.body.language || "zh", context = req.body.context || null;
    if (!transcript) return res.status(400).json({ error: "没有收到 Transcript" });
    const instructions = basePrompt({ course, lectureTitle, language, context }) + `
Return JSON only: {"terms":[{"term":"technical term","translation":"translation","definition":"one concise lecture-grounded definition"}]}
Select 8-15 genuinely important technical terms. Do not include generic words. All translation/definition fields must be in ${languageName(language)}.`;
    const data = jsonFrom(await ask(instructions, `Lecture transcript:\n${transcript}`));
    res.json({ terms: Array.isArray(data.terms) ? data.terms : [] });
  } catch (e) { console.error("Terms error:", e); res.status(500).json({ error: e.message || "Key Terms generation failed" }); }
});

app.post("/api/quiz", async (req, res) => {
  try {
    const transcript = clean(req.body.transcript, 90000), course = req.body.course || "general", lectureTitle = req.body.lectureTitle || "University Lecture", language = req.body.language || "zh", context = req.body.context || null;
    if (!transcript) return res.status(400).json({ error: "没有收到 Transcript" });
    const instructions = basePrompt({ course, lectureTitle, language, context }) + `
Return JSON only: {"quiz":[{"question":"","options":["","","",""],"answer":"A","explanation":""}]}
Create 6 questions: 3 concept questions and 3 application/calculation questions when appropriate. Every question must be answerable from the lecture. Write questions, options and explanations in ${languageName(language)}.`;
    const data = jsonFrom(await ask(instructions, `Lecture transcript:\n${transcript}`));
    res.json({ quiz: Array.isArray(data.quiz) ? data.quiz : [] });
  } catch (e) { console.error("Quiz error:", e); res.status(500).json({ error: e.message || "Quiz generation failed" }); }
});

app.post("/api/revision", async (req, res) => {
  try {
    const transcript = clean(req.body.transcript, 90000), course = req.body.course || "general", lectureTitle = req.body.lectureTitle || "University Lecture", language = req.body.language || "zh", context = req.body.context || null;
    if (!transcript) return res.status(400).json({ error: "没有收到 Transcript" });
    const instructions = basePrompt({ course, lectureTitle, language, context }) + `
Return JSON only with:
{"overview":"","coreConcepts":[""],"formulas":[""],"keyTerms":[""],"examples":[""],"commonMistakes":[""],"examFocus":[""],"quiz":[{"question":"","options":["","","",""],"answer":"A","explanation":""}],"quickReview":""}
Make a polished revision pack in ${languageName(language)}. Keep it concise. Use formulas only when they actually occur in the lecture.`;
    const revision = jsonFrom(await ask(instructions, `Lecture transcript:\n${transcript}`));
    res.json({ revision });
  } catch (e) { console.error("Revision error:", e); res.status(500).json({ error: e.message || "Revision Pack generation failed" }); }
});

app.get("/", (req, res) => res.sendFile(require("path").join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 LectureAI Web is running on port ${PORT}`));
