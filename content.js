console.log("LectureAI ULTRA FAST reader started · Core v7");


// ============================================================
// LectureAI
// Content Script
// ============================================================

let vttUrl = null;
let transcriptSourceInFlight = false;
let transcriptSourceLastTry = 0;
let cues = [];
let lastCueIndex = -1;
let activeVideo = null;
let subtitleBox = null;
let currentCourse = "general";


// ============================================================
// Transcript
// ============================================================

const lectureTranscript = [];
const transcriptSeen = new Set();


// ============================================================
// Translation Cache
// ============================================================

const translationCache = new Map();
const pendingTranslations = new Map();


// ============================================================
// Configuration
// ============================================================

const CHECK_INTERVAL = 100;
const PREFETCH_COUNT = 3;


// ============================================================
// LectureAI UI
// ============================================================

let lectureAIButton = null;
let lectureAIMenu = null;

let summaryLanguage = "zh";
let translationLanguage = "zh";
let translationMode = "fast";
let translationEnabled = true;
let subtitleFontSize = 20;
let lectureContext = null;
let lastContextSyncCount = 0;
let lastGenerated = { summary: "", terms: [], quiz: [] };


// ============================================================
// Load Settings
// ============================================================

chrome.storage.local.get(
    [
        "course",
        "summaryLanguage",
        "language",
        "mode",
        "enabled",
        "fontSize"
    ],
    settings => {

        currentCourse =
            settings.course ||
            "general";

        summaryLanguage =
            settings.summaryLanguage ||
            settings.language ||
            "zh";

        translationLanguage =
            settings.language ||
            "zh";

        translationMode =
            settings.mode ||
            "fast";

        translationEnabled =
            settings.enabled !== false;

        subtitleFontSize =
            Number(settings.fontSize || 20);

        console.log(
            "🎓 Course:",
            currentCourse
        );

        console.log(
            "🌐 Summary Language:",
            summaryLanguage
        );

    }
);


// ============================================================
// Settings Listener
// ============================================================

chrome.storage.onChanged.addListener(
    (changes, area) => {

        if (
            area !== "local"
        ) {
            return;
        }

        if (
            changes.course
        ) {

            currentCourse =
                changes.course.newValue ||
                "general";

        }

        if (
            changes.summaryLanguage
        ) {

            summaryLanguage =
                changes.summaryLanguage.newValue ||
                "zh";

        }

        if (changes.language) {
            translationLanguage = changes.language.newValue || "zh";
            translationCache.clear();
            pendingTranslations.clear();
        }

        if (changes.mode) {
            translationMode = changes.mode.newValue || "fast";
        }

        if (changes.enabled) {
            translationEnabled = changes.enabled.newValue !== false;
            if (!translationEnabled && subtitleBox) subtitleBox.style.display = "none";
        }

        if (changes.fontSize) {
            subtitleFontSize = Number(changes.fontSize.newValue || 20);
            if (subtitleBox) subtitleBox.style.fontSize = `${subtitleFontSize}px`;
        }

    }
);


// ============================================================
// Find VTT
// ============================================================

function findVTT() {
    const now = Date.now();

    // 1) Native / network VTT sources.
    const resources = performance.getEntriesByType("resource") || [];
    for (const resource of resources) {
        const url = String(resource.name || "");
        const low = url.toLowerCase();
        if ((low.includes(".vtt") || low.includes("webvtt") || low.includes("captions") || low.includes("subtitle")) && url !== vttUrl) {
            vttUrl = url;
            console.log("[LectureAI] Found VTT:", url);
            loadVTT(url);
            return;
        }
    }

    // 2) Echo360 transcript-file API. Some Echo360 lessons expose a transcript
    // but no HTML5 <track>, so the API is the reliable fallback.
    if (!cues.length && !transcriptSourceInFlight && now - transcriptSourceLastTry > 2500) {
        transcriptSourceLastTry = now;
        fetchEcho360TranscriptVtt().catch(err => console.debug("[LectureAI] transcript source not ready:", err?.message || err));
    }
}

function uuidListFromText(value) {
    const out = new Set();
    const matches = String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || [];
    for (const id of matches) out.add(id.toLowerCase());
    return out;
}

function collectEcho360MediaIds() {
    const ids = new Set();
    const resources = performance.getEntriesByType("resource") || [];
    for (const r of resources) {
        const text = String(r.name || "");
        const m = text.match(/\/api\/ui\/interactive-media\/media\/([0-9a-f-]{36})(?:\/|$)/i);
        if (m) ids.add(m[1].toLowerCase());
        for (const id of uuidListFromText(text)) ids.add(id);
    }

    const videos = Array.from(document.querySelectorAll("video"));
    for (const video of videos) {
        try {
            for (const id of uuidListFromText(video.currentSrc)) ids.add(id);
            for (const id of uuidListFromText(video.src)) ids.add(id);
            for (const attr of Array.from(video.attributes || [])) {
                for (const id of uuidListFromText(attr.value)) ids.add(id);
            }
        } catch (_) {}
    }

    // React/Echo360 often keeps media UUIDs in internal fiber/props objects.
    for (const video of videos) {
        let node = video;
        for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
            try {
                for (const key of Reflect.ownKeys(node)) {
                    if (!/(react|fiber|props|state|echo|media|player)/i.test(String(key))) continue;
                    const value = node[key];
                    collectUuidsDeep(value, ids, 0, new WeakSet());
                }
            } catch (_) {}
        }
    }
    return Array.from(ids).filter(id => !String(getLessonId()).toLowerCase().includes(id));
}

function collectUuidsDeep(value, out, depth, seen) {
    if (out.size > 80 || depth > 4 || value == null) return;
    const type = typeof value;
    if (type === "string" || type === "number") {
        for (const id of uuidListFromText(value)) out.add(id);
        return;
    }
    if (type !== "object" && type !== "function") return;
    if (seen.has(value)) return;
    seen.add(value);
    let keys = [];
    try { keys = Reflect.ownKeys(value).slice(0, 80); } catch (_) { return; }
    for (const key of keys) {
        let next;
        try { next = value[key]; } catch (_) { continue; }
        collectUuidsDeep(next, out, depth + 1, seen);
    }
}

function getLessonId() {
    const path = String(location.pathname || "");
    const m = path.match(/\/lesson\/([^/]+)/i);
    if (m) return m[1];
    const q = new URLSearchParams(location.search);
    return q.get("lessonId") || q.get("lesson") || "";
}

function parseVttStatsLocal(text) {
    const parsed = parseVTT(text);
    return {
        cueCount: parsed.length,
        maxEnd: parsed.reduce((m, c) => Math.max(m, c.end), 0),
        ranges: parsed.map(c => [c.start, c.end])
    };
}

async function fetchEcho360TranscriptVtt() {
    const lessonId = getLessonId();
    const mediaIds = collectEcho360MediaIds();
    if (!lessonId || !mediaIds.length) return false;

    transcriptSourceInFlight = true;
    try {
        const video = getActiveVideo();
        const nowSec = Number(video?.currentTime || 0);
        let best = null;

        for (const mediaId of mediaIds.slice(0, 40)) {
            const url = `${location.origin}/api/ui/echoplayer/lessons/${encodeURIComponent(lessonId)}/medias/${encodeURIComponent(mediaId)}/transcript-file?format=vtt`;
            try {
                const resp = await fetch(url, { credentials: "include" });
                if (!resp.ok) continue;
                const text = await resp.text();
                if (!(text.trim().startsWith("WEBVTT") || text.includes("-->"))) continue;
                const stats = parseVttStatsLocal(text);
                if (!stats.cueCount) continue;
                const coversNow = stats.ranges.some(([a,b]) => nowSec >= a && nowSec <= b);
                const score = (coversNow ? 1000000 : 0) + stats.maxEnd * 100 + stats.cueCount;
                if (!best || score > best.score) best = { score, text, url, mediaId, stats, coversNow };
            } catch (_) {}
        }

        if (!best) return false;
        vttUrl = best.url;
        cues = parseVTT(best.text);
        lastCueIndex = -1;
        console.log("[LectureAI] Echo360 transcript-file VTT found:", best.url, "cues=", best.stats.cueCount, "coversNow=", best.coversNow);
        prefetchFrom(0);
        return true;
    } finally {
        transcriptSourceInFlight = false;
    }
}


// ============================================================
// Load VTT
// ============================================================

function loadVTT(url) {

    chrome.runtime.sendMessage(
        {
            type:
                "GET_VTT",

            url:
                url
        },
        response => {

            if (
                chrome.runtime.lastError
            ) {

                console.error(
                    "❌ VTT error:",
                    chrome.runtime
                        .lastError
                        .message
                );

                return;

            }

            if (
                !response ||
                !response.ok
            ) {

                console.error(
                    "❌ VTT failed:",
                    response?.error
                );

                return;

            }

            cues =
                parseVTT(
                    response.vtt
                );

            lastCueIndex =
                -1;

            console.log(
                "⚡ VTT:",
                cues.length,
                "cues"
            );

            prefetchFrom(0);

        }
    );

}


// ============================================================
// Parse Time
// ============================================================

function parseTime(time) {

    const value =
        time
            .replace(",", ".")
            .trim();

    const parts =
        value.split(":");

    if (
        parts.length === 3
    ) {

        return (
            Number(parts[0]) * 3600 +
            Number(parts[1]) * 60 +
            Number(parts[2])
        );

    }

    if (
        parts.length === 2
    ) {

        return (
            Number(parts[0]) * 60 +
            Number(parts[1])
        );

    }

    return Number(parts[0]);

}


// ============================================================
// Format Time
// ============================================================

function formatTime(seconds) {

    const total =
        Math.max(
            0,
            Math.floor(
                Number(seconds) || 0
            )
        );

    const minutes =
        Math.floor(
            total / 60
        );

    const secs =
        total % 60;

    return (
        String(minutes)
            .padStart(2, "0") +
        ":" +
        String(secs)
            .padStart(2, "0")
    );

}


// ============================================================
// Parse VTT
// ============================================================

function parseVTT(vtt) {

    if (!vtt) {
        return [];
    }

    const blocks =
        vtt.split(
            /\n\s*\n/
        );

    const result = [];

    for (
        const block of blocks
    ) {

        const lines =
            block
                .split("\n")
                .map(
                    line =>
                        line.trim()
                )
                .filter(Boolean);

        const timeLine =
            lines.find(
                line =>
                    line.includes("-->")
            );

        if (!timeLine) {
            continue;
        }

        const parts =
            timeLine.split("-->");

        if (
            parts.length !== 2
        ) {
            continue;
        }

        const start =
            parseTime(
                parts[0]
            );

        const end =
            parseTime(
                parts[1]
            );

        if (
            !Number.isFinite(start) ||
            !Number.isFinite(end)
        ) {
            continue;
        }

        const text =
            lines
                .filter(
                    line =>
                        !line.includes("-->")
                )
                .filter(
                    line =>
                        !/^\d+$/.test(line)
                )
                .join(" ")
                .replace(
                    /<[^>]+>/g,
                    ""
                )
                .replace(
                    /\s+/g,
                    " "
                )
                .trim();

        if (!text) {
            continue;
        }

        result.push({
            start,
            end,
            text
        });

    }

    return result;

}


// ============================================================
// Active Video
// ============================================================

function getActiveVideo() {

    if (

        activeVideo &&

        document.contains(
            activeVideo
        ) &&

        activeVideo.readyState >= 2

    ) {

        const rect =
            activeVideo.getBoundingClientRect();

        if (
            rect.width > 100 &&
            rect.height > 80
        ) {

            return activeVideo;

        }

    }

    const videos =
        Array.from(
            document.querySelectorAll(
                "video"
            )
        );

    if (!videos.length) {
        return null;
    }

    const playingVideos =
        videos.filter(
            video =>
                !video.paused &&
                !video.ended &&
                video.readyState >= 2
        );

    if (
        playingVideos.length
    ) {

        let best =
            playingVideos[0];

        let bestArea =
            0;

        for (
            const video of playingVideos
        ) {

            const rect =
                video.getBoundingClientRect();

            const area =
                Math.max(
                    0,
                    rect.width
                ) *
                Math.max(
                    0,
                    rect.height
                );

            if (
                area > bestArea
            ) {

                best =
                    video;

                bestArea =
                    area;

            }

        }

        activeVideo =
            best;

        return best;

    }

    let bestVideo =
        null;

    let bestArea =
        0;

    for (
        const video of videos
    ) {

        if (
            video.readyState < 2
        ) {
            continue;
        }

        const rect =
            video.getBoundingClientRect();

        const area =
            Math.max(
                0,
                rect.width
            ) *
            Math.max(
                0,
                rect.height
            );

        if (
            area > bestArea
        ) {

            bestVideo =
                video;

            bestArea =
                area;

        }

    }

    if (bestVideo) {
        activeVideo =
            bestVideo;
    }

    return bestVideo;

}


// ============================================================
// Find Cue
// ============================================================

function findCueIndex(
    currentTime
) {

    if (!cues.length) {
        return -1;
    }

    if (

        lastCueIndex >= 0 &&

        lastCueIndex < cues.length

    ) {

        const current =
            cues[lastCueIndex];

        if (

            currentTime >=
                current.start &&

            currentTime <=
                current.end

        ) {

            return lastCueIndex;

        }

    }

    let left =
        0;

    let right =
        cues.length - 1;

    while (
        left <= right
    ) {

        const middle =
            (left + right) >> 1;

        const cue =
            cues[middle];

        if (
            currentTime <
            cue.start
        ) {

            right =
                middle - 1;

        }

        else if (
            currentTime >
            cue.end
        ) {

            left =
                middle + 1;

        }

        else {

            return middle;

        }

    }

    return -1;

}


// ============================================================
// Subtitle
// ============================================================

function createSubtitleBox() {

    if (

        subtitleBox &&

        document.contains(
            subtitleBox
        )

    ) {

        return subtitleBox;

    }

    subtitleBox =
        document.getElementById(
            "lectureai-chinese-subtitle"
        );

    if (subtitleBox) {
        return subtitleBox;
    }

    subtitleBox =
        document.createElement(
            "div"
        );

    subtitleBox.id =
        "lectureai-chinese-subtitle";

    Object.assign(
        subtitleBox.style,
        {

            position:
                "fixed",

            left:
                "50%",

            bottom:
                "8%",

            transform:
                "translateX(-50%)",

            maxWidth:
                "70%",

            padding:
                "7px 16px",

            background:
                "rgba(0,0,0,.72)",

            color:
                "#fff",

            fontSize:
                `${subtitleFontSize}px`,

            fontWeight:
                "500",

            lineHeight:
                "1.4",

            textAlign:
                "center",

            borderRadius:
                "5px",

            pointerEvents:
                "none",

            fontFamily:
                "Arial, Microsoft YaHei, sans-serif",

            whiteSpace:
                "normal",

            display:
                "none"

        }
    );

    subtitleBox.style.setProperty(
        "z-index",
        "2147483647",
        "important"
    );

    document.documentElement.appendChild(
        subtitleBox
    );

    return subtitleBox;

}


// ============================================================
// Fullscreen
// ============================================================

function getFullscreenElement() {

    return (
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        null
    );

}


// ============================================================
// Subtitle Position
// ============================================================

function updateSubtitlePosition() {

    const box =
        createSubtitleBox();

    const fullscreen =
        getFullscreenElement();

    if (fullscreen) {

        if (
            box.parentElement !==
            fullscreen
        ) {

            fullscreen.appendChild(
                box
            );

        }

        box.style.position =
            "absolute";

        box.style.left =
            "50%";

        box.style.bottom =
            "10%";

        box.style.transform =
            "translateX(-50%)";

    }

    else {

        if (
            box.parentElement !==
            document.documentElement
        ) {

            document.documentElement.appendChild(
                box
            );

        }

        box.style.position =
            "fixed";

        box.style.left =
            "50%";

        box.style.bottom =
            "8%";

        box.style.transform =
            "translateX(-50%)";

    }

    box.style.setProperty(
        "z-index",
        "2147483647",
        "important"
    );

}


// ============================================================
// Show Subtitle
// ============================================================

function showChineseSubtitle(
    text
) {

    const box =
        createSubtitleBox();

    updateSubtitlePosition();

    if (!text) {

        box.style.display =
            "none";

        return;

    }

    box.textContent =
        text;

    box.style.display =
        "block";

}


// ============================================================
// Transcript
// ============================================================

function recordLectureCue(
    cue
) {

    if (!cue) {
        return;
    }

    const key =
        `${cue.start}|${cue.end}|${cue.text}`;

    if (
        transcriptSeen.has(key)
    ) {
        return;
    }

    transcriptSeen.add(key);

    lectureTranscript.push({

        start:
            cue.start,

        end:
            cue.end,

        english:
            cue.text,

        chinese:
            translationCache.get(
                cue.text
            ) || ""

    });

}


// ============================================================
// Update Transcript Translation
// ============================================================

function updateTranscriptTranslation(
    english,
    chinese
) {

    if (
        !english ||
        !chinese
    ) {
        return;
    }

    for (
        const item of lectureTranscript
    ) {

        if (
            item.english ===
            english
        ) {

            item.chinese =
                chinese;
            item.translated =
                chinese;

        }

    }

}


// ============================================================
// Translation
// ============================================================

function requestTranslation(
    english
) {

    if (!english) {
        return Promise.resolve("");
    }

    const text =
        english
            .trim()
            .replace(
                /\s+/g,
                " "
            );

    if (
        translationCache.has(text)
    ) {

        return Promise.resolve(
            translationCache.get(text)
        );

    }

    if (
        pendingTranslations.has(text)
    ) {

        return pendingTranslations.get(text);

    }

    const promise =
        new Promise(
            resolve => {

                chrome.runtime.sendMessage(
                    {

                        type:
                            "TRANSLATE",

                        text:
                            text,

                        course:
                            currentCourse,

                        targetLanguage:
                            translationLanguage,

                        mode:
                            translationMode

                    },
                    response => {

                        if (
                            chrome.runtime.lastError
                        ) {

                            pendingTranslations.delete(
                                text
                            );

                            resolve("");

                            return;

                        }

                        if (
                            !response ||
                            !response.ok
                        ) {

                            pendingTranslations.delete(
                                text
                            );

                            resolve("");

                            return;

                        }

                        const chinese =
                            (
                                response.translation ||
                                ""
                            ).trim();

                        if (chinese) {

                            translationCache.set(
                                text,
                                chinese
                            );

                            updateTranscriptTranslation(
                                text,
                                chinese
                            );

                        }

                        pendingTranslations.delete(
                            text
                        );

                        resolve(
                            chinese
                        );

                    }
                );

            }
        );

    pendingTranslations.set(
        text,
        promise
    );

    return promise;

}


// ============================================================
// Prefetch
// ============================================================

function prefetchFrom(
    startIndex
) {

    if (

        startIndex < 0 ||

        startIndex >= cues.length

    ) {

        return;

    }

    const endIndex =
        Math.min(
            cues.length,
            startIndex +
                PREFETCH_COUNT +
                1
        );

    for (
        let i = startIndex;
        i < endIndex;
        i++
    ) {

        const text =
            cues[i].text;

        if (!text) {
            continue;
        }

        if (
            translationCache.has(text)
        ) {
            continue;
        }

        if (
            pendingTranslations.has(text)
        ) {
            continue;
        }

        requestTranslation(text);

    }

}


// ============================================================
// Handle Cue
// ============================================================

function handleCue(
    index
) {

    if (!translationEnabled) {
        if (subtitleBox) subtitleBox.style.display = "none";
        return;
    }

    if (

        index < 0 ||

        index >= cues.length

    ) {

        return;

    }

    const cue =
        cues[index];

    if (
        index !== lastCueIndex
    ) {

        lastCueIndex =
            index;

        recordLectureCue(
            cue
        );

        if (lectureTranscript.length % 8 === 0) {
            syncLectureContext(true);
        }

        prefetchFrom(
            index
        );

    }

    if (
        translationCache.has(
            cue.text
        )
    ) {

        const chinese =
            translationCache.get(
                cue.text
            );

        updateTranscriptTranslation(
            cue.text,
            chinese
        );

        showChineseSubtitle(
            chinese
        );

        return;

    }

    requestTranslation(
        cue.text
    )
        .then(
            chinese => {

                if (!chinese) {
                    return;
                }

                const video =
                    getActiveVideo();

                if (!video) {
                    return;
                }

                const currentIndex =
                    findCueIndex(
                        video.currentTime
                    );

                if (
                    currentIndex ===
                    index
                ) {

                    showChineseSubtitle(
                        chinese
                    );

                }

            }
        );

}


// ============================================================
// Remove Old UI
// ============================================================

function removeOldUI() {

    const selectors = [

        "#lectureai-summary-floating-button",
        "#lectureai-summary-button",
        "#lectureai-old-summary",
        "#lectureai-video-summary-button",
        "#lectureai-main-button",
        "#lectureai-menu",
        "#lectureai-summary-panel",
        "#lectureai-coming-soon",
        ".lectureai-summary-floating",
        ".lectureai-summary-button",
        "[data-lectureai-summary]"

    ];

    selectors.forEach(
        selector => {

            document
                .querySelectorAll(
                    selector
                )
                .forEach(
                    element => {

                        element.remove();

                    }
                );

        }
    );

}


// ============================================================
// Create Main LectureAI Button
// ============================================================

function createLectureAIButton() {

    if (

        lectureAIButton &&

        document.contains(
            lectureAIButton
        )

    ) {

        return lectureAIButton;

    }


    lectureAIButton =
        document.createElement(
            "button"
        );


    lectureAIButton.id =
        "lectureai-main-button";


    lectureAIButton.type =
        "button";


    lectureAIButton.dataset.open =
        "false";


    lectureAIButton.innerHTML = `

        <span
            style="
                display:inline-flex;
                align-items:center;
                justify-content:center;
                width:18px;
                height:18px;
                margin-right:7px;
                font-size:14px;
                line-height:1;
            "
        >
            ✦
        </span>

        <span>
            LectureAI
        </span>

        <span
            class="lectureai-chevron"
            style="
                margin-left:7px;
                font-size:12px;
                opacity:.65;
                transition:
                    transform .2s ease;
            "
        >
            ⌄
        </span>

    `;


    Object.assign(
        lectureAIButton.style,
        {

            position:
                "fixed",

            display:
                "none",

            alignItems:
                "center",

            justifyContent:
                "center",

            height:
                "38px",

            padding:
                "0 15px",

            border:
                "1px solid rgba(255,255,255,.15)",

            borderRadius:
                "999px",

            background:
                "rgba(28,28,32,.84)",

            color:
                "#fff",

            fontFamily:
                "-apple-system, BlinkMacSystemFont, " +
                "\"SF Pro Display\", Arial, sans-serif",

            fontSize:
                "13px",

            fontWeight:
                "600",

            letterSpacing:
                "-.1px",

            cursor:
                "pointer",

            boxShadow:
                "0 8px 30px rgba(0,0,0,.30)",

            backdropFilter:
                "blur(18px) saturate(150%)",

            WebkitBackdropFilter:
                "blur(18px) saturate(150%)",

            transition:
                "transform .18s cubic-bezier(.2,.8,.2,1)," +
                "background .18s ease," +
                "box-shadow .18s ease",

            userSelect:
                "none",

            outline:
                "none",

            zIndex:
                "2147483646"

        }
    );


    // Hover
    lectureAIButton.addEventListener(
        "mouseenter",
        () => {

            lectureAIButton.style.background =
                "rgba(40,40,45,.94)";

            lectureAIButton.style.boxShadow =
                "0 12px 36px rgba(0,0,0,.36)";

            if (
                lectureAIButton.dataset.open !==
                "true"
            ) {

                lectureAIButton.style.transform =
                    "translateY(-1px) scale(1.025)";

            }

        }
    );


    // Leave
    lectureAIButton.addEventListener(
        "mouseleave",
        () => {

            lectureAIButton.style.background =
                "rgba(28,28,32,.84)";

            lectureAIButton.style.boxShadow =
                "0 8px 30px rgba(0,0,0,.30)";

            if (
                lectureAIButton.dataset.open !==
                "true"
            ) {

                lectureAIButton.style.transform =
                    "translateY(0) scale(1)";

            }

        }
    );


    // Press
    lectureAIButton.addEventListener(
        "mousedown",
        () => {

            lectureAIButton.style.transform =
                "scale(.96)";

        }
    );


    lectureAIButton.addEventListener(
        "mouseup",
        () => {

            if (
                lectureAIButton.dataset.open ===
                "true"
            ) {

                lectureAIButton.style.transform =
                    "scale(1)";

            }

            else {

                lectureAIButton.style.transform =
                    "translateY(-1px) scale(1.025)";

            }

        }
    );


    // Click
    lectureAIButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            event.stopPropagation();

            toggleLectureAIMenu();

        }
    );


    document.documentElement.appendChild(
        lectureAIButton
    );


    return lectureAIButton;

}


// ============================================================
// Create Menu
// ============================================================

function createLectureAIMenu() {

    if (

        lectureAIMenu &&

        document.contains(
            lectureAIMenu
        )

    ) {

        return lectureAIMenu;

    }


    lectureAIMenu =
        document.createElement(
            "div"
        );


    lectureAIMenu.id =
        "lectureai-menu";


    Object.assign(
        lectureAIMenu.style,
        {

            position:
                "fixed",

            display:
                "none",

            visibility:
                "hidden",

            pointerEvents:
                "none",

            width:
                "232px",

            padding:
                "7px",

            boxSizing:
                "border-box",

            border:
                "1px solid rgba(255,255,255,.12)",

            borderRadius:
                "17px",

            background:
                "rgba(28,28,32,.96)",

            color:
                "#fff",

            backdropFilter:
                "blur(28px) saturate(160%)",

            WebkitBackdropFilter:
                "blur(28px) saturate(160%)",

            boxShadow:
                "0 20px 70px rgba(0,0,0,.45)",

            zIndex:
                "2147483647",

            opacity:
                "0",

            transform:
                "translateY(-6px) scale(.97)",

            transformOrigin:
                "top right",

            transition:
                "opacity .18s ease," +
                "transform .18s cubic-bezier(.2,.8,.2,1)"

        }
    );


    const items = [

        {
            id: "subtitle",
            icon: "CC",
            title: "字幕翻译",
            subtitle: translationEnabled ? `已开启 · ${translationLanguage === "vi" ? "Tiếng Việt" : translationLanguage === "en" ? "English" : "简体中文"}` : "已关闭"
        },

        {
            id:
                "summary",

            icon:
                "✦",

            title:
                "Summary",

            subtitle:
                "本节课总结"

        },

        {
            id:
                "quiz",

            icon:
                "✓",

            title:
                "Quiz",

            subtitle:
                "课后练习"

        },

        {
            id:
                "terms",

            icon:
                "Aa",

            title:
                "Key Terms",

            subtitle:
                "关键技术词汇"

        },

        {
            id:
                "pdf",

            icon:
                "↓",

            title:
                "Download PDF",

            subtitle:
                "下载复习资料"

        }

    ];


    items.forEach(
        item => {

            const button =
                document.createElement(
                    "button"
                );


            button.type =
                "button";


            button.dataset.action =
                item.id;


            Object.assign(
                button.style,
                {

                    width:
                        "100%",

                    minHeight:
                        "54px",

                    padding:
                        "7px 9px",

                    border:
                        "0",

                    borderRadius:
                        "11px",

                    background:
                        "transparent",

                    color:
                        "#fff",

                    display:
                        "flex",

                    alignItems:
                        "center",

                    textAlign:
                        "left",

                    cursor:
                        "pointer",

                    transition:
                        "background .15s ease," +
                        "transform .15s ease",

                    outline:
                        "none"

                }
            );


            button.innerHTML = `

                <span
                    style="
                        width:34px;
                        height:34px;
                        margin-right:10px;
                        border-radius:9px;
                        display:flex;
                        align-items:center;
                        justify-content:center;
                        background:rgba(255,255,255,.075);
                        color:rgba(255,255,255,.88);
                        font-size:${item.id === "terms" ? "12px" : "15px"};
                        font-weight:600;
                        flex-shrink:0;
                    "
                >
                    ${item.icon}
                </span>

                <span
                    style="
                        display:flex;
                        flex-direction:column;
                        gap:2px;
                        min-width:0;
                    "
                >

                    <span
                        style="
                            font-size:13px;
                            font-weight:600;
                            letter-spacing:-.1px;
                        "
                    >
                        ${item.title}
                    </span>

                    <span
                        style="
                            font-size:11px;
                            color:rgba(255,255,255,.42);
                            font-weight:400;
                        "
                    >
                        ${item.subtitle}
                    </span>

                </span>

            `;


            button.addEventListener(
                "mouseenter",
                () => {

                    button.style.background =
                        "rgba(255,255,255,.085)";

                    button.style.transform =
                        "translateX(2px)";

                }
            );


            button.addEventListener(
                "mouseleave",
                () => {

                    button.style.background =
                        "transparent";

                    button.style.transform =
                        "translateX(0)";

                }
            );


            button.addEventListener(
                "mousedown",
                () => {

                    button.style.transform =
                        "scale(.98)";

                }
            );


            button.addEventListener(
                "mouseup",
                () => {

                    button.style.transform =
                        "translateX(2px)";

                }
            );


            button.addEventListener(
                "click",
                event => {

                    event.preventDefault();

                    event.stopPropagation();

                    handleLectureAIMenuAction(
                        item.id
                    );

                }
            );


            lectureAIMenu.appendChild(
                button
            );

        }
    );


    const subtitleControls = document.createElement("div");
    Object.assign(subtitleControls.style, {
        marginTop: "6px",
        padding: "8px 8px 6px",
        borderTop: "1px solid rgba(255,255,255,.08)"
    });
    subtitleControls.innerHTML = `<div style="font-size:10px;color:rgba(255,255,255,.45);margin-bottom:6px">字幕语言</div>`;
    const langRow = document.createElement("div");
    Object.assign(langRow.style,{display:"flex",gap:"5px"});
    [
      ["zh","中文"],["en","English"],["vi","Tiếng Việt"]
    ].forEach(([value,label])=>{
      const b=document.createElement("button");
      b.type="button"; b.dataset.lang=value; b.textContent=label;
      Object.assign(b.style,{flex:"1",minWidth:"0",padding:"6px 4px",border:"1px solid rgba(255,255,255,.10)",borderRadius:"8px",background:value===translationLanguage?"rgba(255,255,255,.14)":"rgba(255,255,255,.05)",color:"#fff",fontSize:"10px",cursor:"pointer"});
      b.onclick=(event)=>{
        event.preventDefault(); event.stopPropagation();
        translationLanguage=value; translationCache.clear(); pendingTranslations.clear();
        chrome.storage.local.set({language:value,summaryLanguage:value});
        langRow.querySelectorAll("button").forEach(x=>x.style.background=x.dataset.lang===value?"rgba(255,255,255,.14)":"rgba(255,255,255,.05)");
      };
      langRow.appendChild(b);
    });
    subtitleControls.appendChild(langRow);
    lectureAIMenu.appendChild(subtitleControls);

    document.documentElement.appendChild(
        lectureAIMenu
    );


    return lectureAIMenu;

}


// ============================================================
// Position Main Button
// ============================================================

function updateLectureAIButton() {

    const button =
        createLectureAIButton();

    const menu =
        createLectureAIMenu();

    const video =
        getActiveVideo();


    if (!video) {

        button.style.display =
            "none";

        closeLectureAIMenu();

        return;

    }


    const rect =
        video.getBoundingClientRect();


    if (

        rect.width < 100 ||

        rect.height < 80 ||

        rect.bottom < 0 ||

        rect.top >
            window.innerHeight ||

        rect.right < 0 ||

        rect.left >
            window.innerWidth

    ) {

        button.style.display =
            "none";

        closeLectureAIMenu();

        return;

    }


    button.style.display =
        "inline-flex";

    button.style.visibility =
        "hidden";


    const oldLeft =
        button.style.left;

    const oldTop =
        button.style.top;


    button.style.left =
        "0px";

    button.style.top =
        "0px";


    const buttonRect =
        button.getBoundingClientRect();


    const buttonWidth =
        buttonRect.width;

    const buttonHeight =
        buttonRect.height;


    const RIGHT_OFFSET =
        125;

    const TOP_GAP =
        14;


    let left =
        rect.right +
        RIGHT_OFFSET;


    let top =
        rect.top -
        buttonHeight -
        TOP_GAP;


    if (
        top < 92
    ) {

        top =
            rect.top -
            38;

    }


    top =
        Math.max(
            92,
            top
        );


    if (
        left +
        buttonWidth >
        window.innerWidth -
        18
    ) {

        left =
            window.innerWidth -
            buttonWidth -
            18;

    }


    left =
        Math.max(
            18,
            left
        );


    button.style.left =
        `${Math.round(left)}px`;

    button.style.top =
        `${Math.round(top)}px`;


    // ========================================================
    // Menu position
    // ========================================================

    const menuWidth =
        232;


    let menuLeft =
        left +
        buttonWidth -
        menuWidth;


    let menuTop =
        top +
        buttonHeight +
        9;


    // Prevent right overflow
    if (
        menuLeft +
        menuWidth >
        window.innerWidth -
        18
    ) {

        menuLeft =
            window.innerWidth -
            menuWidth -
            18;

    }


    // Prevent left overflow
    menuLeft =
        Math.max(
            18,
            menuLeft
        );


    // If menu would go too low,
    // place it above the button.
    if (
        menuTop +
        250 >
        window.innerHeight -
        18
    ) {

        menuTop =
            top -
            250 -
            9;

    }


    menu.style.left =
        `${Math.round(menuLeft)}px`;

    menu.style.top =
        `${Math.round(menuTop)}px`;


    button.style.visibility =
        "visible";

}


// ============================================================
// Open Menu
// ============================================================

function openLectureAIMenu() {

    const button =
        createLectureAIButton();

    const menu =
        createLectureAIMenu();


    // Make absolutely sure the menu is visible.
    menu.style.display =
        "block";

    menu.style.visibility =
        "visible";

    menu.style.pointerEvents =
        "auto";

    menu.style.zIndex =
        "2147483647";


    updateLectureAIButton();


    menu.style.display =
        "block";

    menu.style.visibility =
        "visible";

    menu.style.pointerEvents =
        "auto";

    menu.style.opacity =
        "0";

    menu.style.transform =
        "translateY(-6px) scale(.97)";


    requestAnimationFrame(
        () => {

            menu.style.opacity =
                "1";

            menu.style.transform =
                "translateY(0) scale(1)";

            button.dataset.open =
                "true";


            const chevron =
                button.querySelector(
                    ".lectureai-chevron"
                );


            if (chevron) {

                chevron.style.transform =
                    "rotate(180deg)";

            }

        }
    );

}


// ============================================================
// Close Menu
// ============================================================

function closeLectureAIMenu() {

    if (
        !lectureAIButton ||
        !lectureAIMenu
    ) {

        return;

    }


    lectureAIMenu.style.opacity =
        "0";

    lectureAIMenu.style.transform =
        "translateY(-6px) scale(.97)";

    lectureAIMenu.style.pointerEvents =
        "none";


    lectureAIButton.dataset.open =
        "false";


    const chevron =
        lectureAIButton.querySelector(
            ".lectureai-chevron"
        );


    if (chevron) {

        chevron.style.transform =
            "rotate(0deg)";

    }


    setTimeout(
        () => {

            if (
                lectureAIButton.dataset.open !==
                "true"
            ) {

                lectureAIMenu.style.display =
                    "none";

                lectureAIMenu.style.visibility =
                    "hidden";

            }

        },
        180
    );

}


// ============================================================
// Toggle Menu
// ============================================================

function toggleLectureAIMenu() {

    if (!lectureAIButton) {

        createLectureAIButton();

    }


    if (!lectureAIMenu) {

        createLectureAIMenu();

    }


    if (
        lectureAIButton.dataset.open ===
        "true"
    ) {

        closeLectureAIMenu();

    }

    else {

        openLectureAIMenu();

    }

}


// ============================================================
// Menu Actions
// ============================================================

function handleLectureAIMenuAction(
    action
) {

    closeLectureAIMenu();


    if (
        action ===
        "summary"
    ) {

        generateLectureSummary();

        return;

    }


    if (
        action ===
        "quiz"
    ) {

        openComingSoonPanel(
            "Quiz",
            "课后 Quiz 功能正在开发中。"
        );

        return;

    }


    if (
        action ===
        "terms"
    ) {

        openComingSoonPanel(
            "Key Terms",
            "关键技术词汇功能正在开发中。"
        );

        return;

    }


    if (
        action ===
        "pdf"
    ) {

        openComingSoonPanel(
            "Download PDF",
            "PDF 下载功能正在开发中。"
        );

        return;

    }

}


// ============================================================
// Coming Soon
// ============================================================

function openComingSoonPanel(
    title,
    message
) {

    let panel =
        document.getElementById(
            "lectureai-coming-soon"
        );


    if (!panel) {

        panel =
            document.createElement(
                "div"
            );


        panel.id =
            "lectureai-coming-soon";


        Object.assign(
            panel.style,
            {

                position:
                    "fixed",

                left:
                    "50%",

                top:
                    "50%",

                transform:
                    "translate(-50%, -50%)",

                width:
                    "360px",

                padding:
                    "28px",

                borderRadius:
                    "22px",

                background:
                    "rgba(25,25,29,.96)",

                border:
                    "1px solid rgba(255,255,255,.10)",

                boxShadow:
                    "0 30px 90px rgba(0,0,0,.50)",

                backdropFilter:
                    "blur(30px)",

                WebkitBackdropFilter:
                    "blur(30px)",

                color:
                    "#fff",

                zIndex:
                    "2147483647",

                textAlign:
                    "center",

                fontFamily:
                    "-apple-system, BlinkMacSystemFont, " +
                    "\"SF Pro Display\", Arial, sans-serif"

            }
        );


        document.documentElement.appendChild(
            panel
        );

    }


    panel.innerHTML = `

        <div
            style="
                font-size:18px;
                font-weight:700;
                margin-bottom:8px;
            "
        >
            ${title}
        </div>

        <div
            style="
                font-size:13px;
                line-height:1.6;
                color:rgba(255,255,255,.52);
            "
        >
            ${message}
        </div>

        <button
            id="lectureai-coming-soon-close"
            style="
                margin-top:22px;
                border:0;
                border-radius:10px;
                padding:9px 18px;
                background:#007aff;
                color:#fff;
                font-size:13px;
                font-weight:600;
                cursor:pointer;
            "
        >
            好
        </button>

    `;


    panel.style.display =
        "block";


    const close =
        document.getElementById(
            "lectureai-coming-soon-close"
        );


    close.addEventListener(
        "click",
        () => {

            panel.style.display =
                "none";

        }
    );

}


// ============================================================
// Summary Panel
// ============================================================

function createSummaryPanel() {

    let panel =
        document.getElementById(
            "lectureai-summary-panel"
        );


    if (panel) {
        return panel;
    }


    panel =
        document.createElement(
            "div"
        );


    panel.id =
        "lectureai-summary-panel";


    Object.assign(
        panel.style,
        {

            position:
                "fixed",

            top:
                "50%",

            left:
                "50%",

            transform:
                "translate(-50%, -50%)",

            width:
                "min(820px, 88vw)",

            maxHeight:
                "82vh",

            background:
                "rgba(20,20,24,.96)",

            color:
                "#fff",

            border:
                "1px solid rgba(255,255,255,.10)",

            borderRadius:
                "24px",

            boxShadow:
                "0 30px 100px rgba(0,0,0,.55)",

            zIndex:
                "2147483647",

            display:
                "none",

            flexDirection:
                "column",

            overflow:
                "hidden",

            fontFamily:
                "-apple-system, BlinkMacSystemFont, " +
                "\"SF Pro Display\", Arial, sans-serif",

            backdropFilter:
                "blur(30px) saturate(140%)",

            WebkitBackdropFilter:
                "blur(30px) saturate(140%)"

        }
    );


    // Header
    const header =
        document.createElement(
            "div"
        );


    Object.assign(
        header.style,
        {

            display:
                "flex",

            alignItems:
                "center",

            padding:
                "18px 20px",

            borderBottom:
                "1px solid rgba(255,255,255,.08)"

        }
    );


    const titleArea =
        document.createElement(
            "div"
        );


    titleArea.innerHTML = `

        <div
            style="
                font-size:19px;
                font-weight:700;
                letter-spacing:-.4px;
            "
        >
            本节课总结
        </div>

        <div
            style="
                margin-top:4px;
                font-size:11px;
                color:rgba(255,255,255,.45);
            "
        >
            LectureAI
        </div>

    `;


    header.appendChild(
        titleArea
    );


    // Language picker
    const languagePicker =
        document.createElement(
            "div"
        );


    Object.assign(
        languagePicker.style,
        {

            position:
                "relative",

            marginLeft:
                "auto",

            marginRight:
                "10px"

        }
    );


    const languageButton =
        document.createElement(
            "button"
        );


    languageButton.type =
        "button";


    Object.assign(
        languageButton.style,
        {

            height:
                "36px",

            minWidth:
                "138px",

            padding:
                "0 12px 0 14px",

            border:
                "1px solid rgba(255,255,255,.12)",

            borderRadius:
                "11px",

            background:
                "rgba(255,255,255,.075)",

            color:
                "#f5f5f7",

            fontSize:
                "13px",

            fontWeight:
                "500",

            display:
                "flex",

            alignItems:
                "center",

            justifyContent:
                "space-between",

            cursor:
                "pointer",

            outline:
                "none"

        }
    );


    const languageName =
        document.createElement(
            "span"
        );


    function getLanguageName(
        language
    ) {

        if (
            language === "en"
        ) {
            return "English";
        }

        if (
            language === "vi"
        ) {
            return "Tiếng Việt";
        }

        return "简体中文";

    }


    languageName.textContent =
        getLanguageName(
            summaryLanguage
        );


    const languageChevron =
        document.createElement(
            "span"
        );


    languageChevron.textContent =
        "⌄";


    languageButton.appendChild(
        languageName
    );

    languageButton.appendChild(
        languageChevron
    );


    const languageMenu =
        document.createElement(
            "div"
        );


    Object.assign(
        languageMenu.style,
        {

            position:
                "absolute",

            top:
                "44px",

            right:
                "0",

            width:
                "178px",

            padding:
                "6px",

            border:
                "1px solid rgba(255,255,255,.11)",

            borderRadius:
                "14px",

            background:
                "rgba(30,30,34,.96)",

            backdropFilter:
                "blur(24px)",

            WebkitBackdropFilter:
                "blur(24px)",

            boxShadow:
                "0 18px 50px rgba(0,0,0,.48)",

            display:
                "none",

            zIndex:
                "2147483647"

        }
    );


    const languages = [

        {
            value:
                "zh",

            label:
                "简体中文"
        },

        {
            value:
                "en",

            label:
                "English"
        },

        {
            value:
                "vi",

            label:
                "Tiếng Việt"
        }

    ];


    languages.forEach(
        language => {

            const option =
                document.createElement(
                    "button"
                );


            option.type =
                "button";


            option.dataset.value =
                language.value;


            Object.assign(
                option.style,
                {

                    width:
                        "100%",

                    height:
                        "38px",

                    border:
                        "0",

                    borderRadius:
                        "9px",

                    background:
                        "transparent",

                    color:
                        "#f5f5f7",

                    display:
                        "flex",

                    alignItems:
                        "center",

                    textAlign:
                        "left",

                    fontSize:
                        "13px",

                    cursor:
                        "pointer"

                }
            );


            option.innerHTML = `

                <span
                    style="
                        width:18px;
                        margin-right:7px;
                    "
                >
                    ${
                        language.value ===
                        summaryLanguage
                            ? "✓"
                            : ""
                    }
                </span>

                <span>
                    ${language.label}
                </span>

            `;


            option.addEventListener(
                "click",
                event => {

                    event.stopPropagation();


                    summaryLanguage =
                        language.value;


                    chrome.storage.local.set({

                        summaryLanguage:
                            summaryLanguage

                    });


                    languageName.textContent =
                        getLanguageName(
                            summaryLanguage
                        );


                    languageMenu.style.display =
                        "none";

                }
            );


            option.addEventListener(
                "mouseenter",
                () => {

                    option.style.background =
                        "rgba(255,255,255,.09)";

                }
            );


            option.addEventListener(
                "mouseleave",
                () => {

                    option.style.background =
                        "transparent";

                }
            );


            languageMenu.appendChild(
                option
            );

        }
    );


    languageButton.addEventListener(
        "click",
        event => {

            event.stopPropagation();


            languageMenu.style.display =
                languageMenu.style.display ===
                "block"
                    ? "none"
                    : "block";

        }
    );


    languagePicker.appendChild(
        languageButton
    );

    languagePicker.appendChild(
        languageMenu
    );


    header.appendChild(
        languagePicker
    );


    // Close
    const closeButton =
        document.createElement(
            "button"
        );


    closeButton.textContent =
        "×";


    Object.assign(
        closeButton.style,
        {

            width:
                "34px",

            height:
                "34px",

            border:
                "0",

            borderRadius:
                "50%",

            background:
                "rgba(255,255,255,.08)",

            color:
                "#fff",

            fontSize:
                "20px",

            cursor:
                "pointer"

        }
    );


    closeButton.addEventListener(
        "click",
        () => {

            panel.style.display =
                "none";

        }
    );


    header.appendChild(
        closeButton
    );


    panel.appendChild(
        header
    );


    // Content
    const content =
        document.createElement(
            "div"
        );


    content.id =
        "lectureai-summary-content";


    Object.assign(
        content.style,
        {

            padding:
                "28px",

            overflowY:
                "auto",

            whiteSpace:
                "pre-wrap",

            lineHeight:
                "1.75",

            fontSize:
                "15px",

            color:
                "#e9e9ed"

        }
    );


    content.textContent =
        "选择语言，然后生成本节课总结。";


    panel.appendChild(
        content
    );


    // Footer
    const footer =
        document.createElement(
            "div"
        );


    Object.assign(
        footer.style,
        {

            display:
                "flex",

            justifyContent:
                "flex-end",

            padding:
                "15px 20px",

            borderTop:
                "1px solid rgba(255,255,255,.08)"

        }
    );


    const generateButton =
        document.createElement(
            "button"
        );


    generateButton.id =
        "lectureai-generate-summary";


    generateButton.textContent =
        "生成总结";


    Object.assign(
        generateButton.style,
        {

            border:
                "0",

            borderRadius:
                "11px",

            padding:
                "10px 18px",

            background:
                "#007aff",

            color:
                "#fff",

            fontSize:
                "13px",

            fontWeight:
                "600",

            cursor:
                "pointer"

        }
    );


    generateButton.addEventListener(
        "click",
        generateLectureSummary
    );


    footer.appendChild(
        generateButton
    );


    panel.appendChild(
        footer
    );


    document.documentElement.appendChild(
        panel
    );


    return panel;

}


// ============================================================
// Generate Summary
// ============================================================

function generateLectureSummary() {

    createSummaryPanel();


    const panel =
        document.getElementById(
            "lectureai-summary-panel"
        );


    const content =
        document.getElementById(
            "lectureai-summary-content"
        );


    const button =
        document.getElementById(
            "lectureai-generate-summary"
        );


    panel.style.display =
        "flex";


    if (
        !lectureTranscript.length
    ) {

        content.textContent =
            "目前还没有足够的课堂内容。\n\n" +
            "请先播放一段 Lecture，让 LectureAI 收集字幕。";

        return;

    }


    button.disabled =
        true;

    button.textContent =
        "正在生成…";


    const loadingText = {

        zh:
            "🧠 正在分析本节课…\n\n正在整理核心知识、公式、例题和考试重点。",

        en:
            "🧠 Analyzing this lecture…\n\nOrganizing the key concepts, formulas, examples and exam points.",

        vi:
            "🧠 Đang phân tích bài giảng…\n\nĐang整理 các khái niệm, công thức, ví dụ và nội dung quan trọng."

    };


    content.textContent =
        loadingText[
            summaryLanguage
        ] ||
        loadingText.zh;


    const transcriptText =
        lectureTranscript
            .map(
                item => {

                    const chinese =
                        item.chinese
                            ? `\nChinese: ${item.chinese}`
                            : "";

                    return (
                        `[${formatTime(item.start)}] ` +
                        `English: ${item.english}` +
                        chinese
                    );

                }
            )
            .join("\n\n");


    chrome.runtime.sendMessage(
        {

            type:
                "SUMMARY",

            transcript:
                transcriptText,

            course:
                currentCourse,

            lectureTitle:
                document.title ||
                "University Lecture",

            language:
                summaryLanguage

        },
        response => {

            if (
                chrome.runtime.lastError
            ) {

                content.textContent =
                    "❌ Summary 生成失败\n\n" +
                    chrome.runtime
                        .lastError
                        .message;

                button.disabled =
                    false;

                button.textContent =
                    "重新生成";

                return;

            }


            if (
                !response ||
                !response.ok
            ) {

                content.textContent =
                    "❌ Summary 生成失败\n\n" +
                    (
                        response?.error ||
                        "未知错误"
                    );

                button.disabled =
                    false;

                button.textContent =
                    "重新生成";

                return;

            }


            const summary =
                response.summary ||
                "";


            content.innerHTML =
                richTextHtml(summary || "AI 没有返回总结。");


            chrome.storage.local.set({

                lastLectureSummary:
                    summary,

                lastLectureSummaryTime:
                    Date.now(),

                lastLectureSummaryCourse:
                    currentCourse,

                lastLectureSummaryLanguage:
                    summaryLanguage

            });


            button.disabled =
                false;

            button.textContent =
                "✓ 已生成";

        }
    );

}


// ============================================================
// Main Loop
// ============================================================

function checkSubtitle() {

    findVTT();


    if (!cues.length) {

        updateLectureAIButton();

        return;

    }


    const video =
        getActiveVideo();


    if (!video) {

        updateLectureAIButton();

        return;

    }


    const currentTime =
        video.currentTime;


    const index =
        findCueIndex(
            currentTime
        );


    if (
        index !== -1
    ) {

        handleCue(
            index
        );

    }

    else {

        showChineseSubtitle("");

    }


    updateSubtitlePosition();

    updateLectureAIButton();

}


// ============================================================
// Scroll
// ============================================================

window.addEventListener(
    "scroll",
    () => {

        updateLectureAIButton();

    },
    {
        passive:
            true
    }
);


// ============================================================
// Resize
// ============================================================

window.addEventListener(
    "resize",
    () => {

        updateLectureAIButton();

        updateSubtitlePosition();

    },
    {
        passive:
            true
    }
);


// ============================================================
// Fullscreen
// ============================================================

document.addEventListener(
    "fullscreenchange",
    () => {

        updateSubtitlePosition();

        updateLectureAIButton();

    }
);


document.addEventListener(
    "webkitfullscreenchange",
    () => {

        updateSubtitlePosition();

        updateLectureAIButton();

    }
);


// ============================================================
// Mouse Move
// ============================================================

let lastButtonUpdate =
    0;


document.addEventListener(
    "mousemove",
    () => {

        const now =
            performance.now();


        if (
            now -
            lastButtonUpdate <
            100
        ) {

            return;

        }


        lastButtonUpdate =
            now;


        updateLectureAIButton();

    },
    {
        passive:
            true
    }
);


// ============================================================
// Click Outside
// ============================================================

document.addEventListener(
    "click",
    event => {

        if (
            !lectureAIButton ||
            !lectureAIMenu
        ) {

            return;

        }


        if (

            !lectureAIButton.contains(
                event.target
            ) &&

            !lectureAIMenu.contains(
                event.target
            )

        ) {

            closeLectureAIMenu();

        }

    }
);



// ============================================================
// Core v6 — Lecture Context Sync
// ============================================================

function getLectureId() {
    return [
        currentCourse || "general",
        location.origin,
        location.pathname
    ].join("|");
}

function getTranscriptText(limit = 28) {
    return lectureTranscript
        .slice(-limit)
        .map(item => `[${formatTime(item.start)}] ${item.english}`)
        .join("\n");
}

function syncLectureContext(force = false) {
    if (!lectureTranscript.length) return;
    if (!force && lectureTranscript.length - lastContextSyncCount < 8) return;
    lastContextSyncCount = lectureTranscript.length;

    chrome.runtime.sendMessage({
        type: "CONTEXT",
        lectureId: getLectureId(),
        course: currentCourse,
        lectureTitle: document.title || "University Lecture",
        transcript: getTranscriptText(28),
        language: translationLanguage
    }, response => {
        if (response && response.ok) {
            lectureContext = response.context || null;
        }
    });
}

function lectureSourcePayload(languageOverride = null) {
    return {
        lectureId: getLectureId(),
        course: currentCourse,
        lectureTitle: document.title || "University Lecture",
        transcript: lectureTranscript.map(item =>
            `[${formatTime(item.start)}] ${item.english}`
        ).join("\n"),
        language: languageOverride || summaryLanguage,
        context: lectureContext
    };
}

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
/*
 * LectureAI Local PDF Engine
 *
 * 不再打开新窗口
 * 不再跳转 Echo360
 * 不依赖 Cookie / Cross-site tracking
 * 直接在当前页面建立独立的打印层
 */

function printPdfDocument(title, bodyHtml) {
    const popup = window.open("", "_blank", "width=980,height=900");
    if (!popup) {
        alert("浏览器阻止了 PDF 打印窗口。请允许当前网站打开新窗口后再点击一次导出 PDF。");
        return;
    }
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <style>
      @page{size:A4;margin:14mm 14mm}
      *{box-sizing:border-box} body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif;color:#111;background:#fff;line-height:1.65;font-size:13.5px}
      .toolbar{position:sticky;top:0;padding:12px 16px;background:#f6f6f8;border-bottom:1px solid #ddd;display:flex;justify-content:flex-end;gap:8px;z-index:5}
      button{border:0;border-radius:10px;padding:9px 15px;font-weight:600;cursor:pointer}.print{background:#007aff;color:#fff}.close{background:#fff;border:1px solid #ccc;color:#222}
      main{max-width:180mm;margin:0 auto;padding:10mm 0 14mm}h1{font-size:26px;line-height:1.2;margin:0 0 5px}h2{font-size:18px;margin:20px 0 8px}h3{font-size:15px;margin:16px 0 6px}.lectureai-print-meta{color:#666;font-size:11.5px;margin-bottom:12px}.lectureai-print-section{margin-bottom:18px;break-inside:auto}.lectureai-print-body{overflow-wrap:anywhere}.pdf-question{break-inside:avoid;margin:0 0 16px}.pdf-question h2{font-size:15px;margin:0 0 6px}.pdf-question p{margin:3px 0}.answer-key{border-top:2px solid #111;padding-top:12px}.pdf-answer{break-inside:avoid;margin:0 0 13px}.pdf-answer>div{margin-top:3px;color:#333}.math{font-family:Cambria,"Times New Roman",serif}
      @media print{.toolbar{display:none!important}main{padding:0;max-width:none}body{font-size:12.5px}}
    </style></head><body><div class="toolbar"><button class="close" id="close">关闭</button><button class="print" id="print">Save as PDF / 打印</button></div><main>${bodyHtml}</main><script>document.getElementById('print').onclick=()=>window.print();document.getElementById('close').onclick=()=>window.close();window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script></body></html>`;
    popup.document.open(); popup.document.write(html); popup.document.close();
}
function ensureSummaryDownloadButton() {
    const panel = document.getElementById("lectureai-summary-panel");
    if (!panel || panel.querySelector("[data-lectureai-pdf='summary']")) return;
    const footer = document.getElementById("lectureai-generate-summary")?.parentElement;
    if (!footer) return;
    const b = document.createElement("button");
    b.type = "button"; b.dataset.lectureaiPdf = "summary"; b.textContent = "↓ 导出 PDF";
    Object.assign(b.style,{border:"1px solid rgba(255,255,255,.14)",borderRadius:"11px",padding:"10px 16px",background:"rgba(255,255,255,.07)",color:"#fff",fontSize:"13px",fontWeight:"600",cursor:"pointer",marginRight:"8px"});
    b.onclick = () => {
      const text = document.getElementById("lectureai-summary-content")?.innerText || "";
      printPdfDocument("LectureAI — Summary", `<header><h1>LectureAI · Summary</h1><div class="lectureai-print-meta">${escapeHtml(currentCourse)} · ${escapeHtml(document.title || "University Lecture")}</div></header><section class="lectureai-print-section"><h2>Summary</h2><div class="lectureai-print-body">${richTextHtml(text)}</div></section>`);
    };
    footer.insertBefore(b, footer.firstChild);
}

let featureLanguage = { terms: "zh", quiz: "zh", revision: "zh" };

chrome.storage.local.get(["termsLanguage","quizLanguage","revisionLanguage"], s => {
    featureLanguage.terms = s.termsLanguage || summaryLanguage || "zh";
    featureLanguage.quiz = s.quizLanguage || summaryLanguage || "zh";
    featureLanguage.revision = s.revisionLanguage || summaryLanguage || "zh";
});

function getFeatureLanguage(kind) {
    return kind === "summary" ? summaryLanguage : (featureLanguage[kind] || summaryLanguage || "zh");
}

function openFeaturePanel(kind, title, subtitle) {
    const id = `lectureai-feature-${kind}`;
    let panel = document.getElementById(id);
    if (panel) {
        panel.style.display = "flex";
        return panel;
    }

    panel = document.createElement("div");
    panel.id = id;

    Object.assign(panel.style, {
        position: "fixed",
        left: kind === "quiz" ? "0" : "50%",
        top: kind === "quiz" ? "0" : "50%",
        transform: kind === "quiz" ? "none" : "translate(-50%,-50%)",
        width: kind === "quiz" ? "100vw" : "min(860px,92vw)",
        height: kind === "quiz" ? "100vh" : "min(760px,88vh)",
        zIndex: "2147483646",
        display: "flex",
        flexDirection: "column",
        background: kind === "quiz" ? "rgba(18,18,22,.985)" : "rgba(25,25,28,.97)",
        color: "#f5f5f7",
        border: "1px solid rgba(255,255,255,.12)",
        borderRadius: kind === "quiz" ? "0" : "24px",
        boxShadow: "0 30px 100px rgba(0,0,0,.55)",
        backdropFilter: "blur(28px)",
        overflow: "hidden",
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Arial, sans-serif'
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "22px 24px",
        borderBottom: "1px solid rgba(255,255,255,.09)"
    });

    const left = document.createElement("div");
    left.innerHTML = `
        <div style="font-size:24px;font-weight:700;letter-spacing:-.6px">
            ${escapeHtml(title)}
        </div>
        <div style="font-size:13px;color:#98989d;margin-top:4px">
            ${escapeHtml(subtitle)}
        </div>
    `;

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    Object.assign(close.style, {
        width: "36px",
        height: "36px",
        border: 0,
        borderRadius: "50%",
        background: "rgba(255,255,255,.08)",
        color: "white",
        fontSize: "22px",
        cursor: "pointer"
    });
    close.onclick = () => panel.style.display = "none";

    header.append(left, close);
    panel.appendChild(header);

    // ========================================================
    // Custom dark language dropdown
    // 不使用原生 <select>，避免 Windows / Chrome 原生菜单
    // 出现白底白字的问题。
    // ========================================================
    const languageRow = document.createElement("div");
    Object.assign(languageRow.style, {
        padding: "12px 24px",
        borderBottom: "1px solid rgba(255,255,255,.06)",
        display: "flex",
        justifyContent: "flex-end"
    });

    const languageWrap = document.createElement("div");
    Object.assign(languageWrap.style, {
        position: "relative",
        width: "178px"
    });

    const languageButton = document.createElement("button");
    languageButton.type = "button";
    Object.assign(languageButton.style, {
        width: "100%",
        height: "38px",
        padding: "0 12px 0 14px",
        border: "1px solid rgba(255,255,255,.14)",
        borderRadius: "11px",
        background: "rgba(255,255,255,.07)",
        color: "#f5f5f7",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "13px",
        fontWeight: "500",
        cursor: "pointer",
        outline: "none",
        boxSizing: "border-box"
    });

    const languageLabel = document.createElement("span");
    const languageArrow = document.createElement("span");
    languageArrow.textContent = "⌄";
    languageArrow.style.opacity = ".65";
    languageArrow.style.transition = "transform .18s ease";
    languageButton.append(languageLabel, languageArrow);

    const languageMenu = document.createElement("div");
    Object.assign(languageMenu.style, {
        position: "absolute",
        top: "44px",
        right: "0",
        width: "178px",
        padding: "6px",
        border: "1px solid rgba(255,255,255,.12)",
        borderRadius: "14px",
        background: "rgba(30,30,34,.98)",
        color: "#f5f5f7",
        boxShadow: "0 18px 50px rgba(0,0,0,.48)",
        backdropFilter: "blur(24px) saturate(150%)",
        WebkitBackdropFilter: "blur(24px) saturate(150%)",
        display: "none",
        zIndex: "2147483647",
        boxSizing: "border-box"
    });

    const featureLanguages = [
        { value: "zh", label: "简体中文" },
        { value: "en", label: "English" },
        { value: "vi", label: "Tiếng Việt" }
    ];

    const languageOptions = [];

    function updateFeatureLanguageUI() {
        const currentValue = getFeatureLanguage(kind);
        const current = featureLanguages.find(item => item.value === currentValue)
            || featureLanguages[0];
        languageLabel.textContent = current.label;
        languageOptions.forEach(option => {
            const selected = option.dataset.value === current.value;
            option.querySelector(".lectureai-language-check").textContent = selected ? "✓" : "";
            option.style.background = selected
                ? "rgba(255,255,255,.08)"
                : "transparent";
        });
    }

    featureLanguages.forEach(language => {
        const option = document.createElement("button");
        option.type = "button";
        option.dataset.value = language.value;
        Object.assign(option.style, {
            width: "100%",
            height: "38px",
            padding: "0 9px",
            border: 0,
            borderRadius: "9px",
            background: "transparent",
            color: "#f5f5f7",
            display: "flex",
            alignItems: "center",
            textAlign: "left",
            fontSize: "13px",
            cursor: "pointer",
            outline: "none",
            boxSizing: "border-box"
        });

        option.innerHTML = `
            <span class="lectureai-language-check" style="width:20px;color:#fff;font-weight:700"></span>
            <span>${escapeHtml(language.label)}</span>
        `;

        option.addEventListener("mouseenter", () => {
            option.style.background = "rgba(255,255,255,.09)";
        });

        option.addEventListener("mouseleave", () => {
            const selected = option.dataset.value === getFeatureLanguage(kind);
            option.style.background = selected
                ? "rgba(255,255,255,.08)"
                : "transparent";
        });

        option.addEventListener("click", event => {
            event.stopPropagation();
            if (kind === "summary") {
                summaryLanguage = language.value;
                chrome.storage.local.set({ summaryLanguage });
            } else {
                featureLanguage[kind] = language.value;
                const key = kind === "terms" ? "termsLanguage" : kind === "quiz" ? "quizLanguage" : "revisionLanguage";
                chrome.storage.local.set({ [key]: language.value });
            }
            updateFeatureLanguageUI();
            languageMenu.style.display = "none";
            languageArrow.style.transform = "rotate(0deg)";
        });

        languageOptions.push(option);
        languageMenu.appendChild(option);
    });

    languageButton.addEventListener("click", event => {
        event.stopPropagation();
        const open = languageMenu.style.display === "block";
        languageMenu.style.display = open ? "none" : "block";
        languageArrow.style.transform = open ? "rotate(0deg)" : "rotate(180deg)";
    });

    document.addEventListener("click", event => {
        if (!languageWrap.contains(event.target)) {
            languageMenu.style.display = "none";
            languageArrow.style.transform = "rotate(0deg)";
        }
    });

    languageWrap.append(languageButton, languageMenu);
    languageRow.appendChild(languageWrap);
    panel.appendChild(languageRow);
    updateFeatureLanguageUI();

    const content = document.createElement("div");
    content.id = `${id}-content`;
    Object.assign(content.style, {
        padding: "26px",
        overflowY: "auto",
        whiteSpace: "pre-wrap",
        lineHeight: "1.7",
        fontSize: "14px",
        color: "#e8e8ed"
    });
    content.textContent = "准备生成…";
    panel.appendChild(content);

    const footer = document.createElement("div");
    Object.assign(footer.style, {
        padding: "14px 20px",
        borderTop: "1px solid rgba(255,255,255,.08)",
        display: "flex",
        justifyContent: "flex-end",
        gap: "8px"
    });

    const pdf = document.createElement("button");
    pdf.type = "button";
    pdf.textContent = "↓ 导出 PDF";
    Object.assign(pdf.style, {
        border: "1px solid rgba(255,255,255,.14)",
        borderRadius: "11px",
        padding: "10px 16px",
        background: "rgba(255,255,255,.07)",
        color: "white",
        fontWeight: "600",
        cursor: "pointer"
    });
    pdf.onclick = () => exportFeaturePdf(kind, title, content.innerText);

    const gen = document.createElement("button");
    gen.type = "button";
    gen.textContent = "重新生成";
    Object.assign(gen.style, {
        border: 0,
        borderRadius: "11px",
        padding: "10px 18px",
        background: "#007aff",
        color: "white",
        fontWeight: "600",
        cursor: "pointer"
    });
    gen.onclick = () => generateFeature(kind, content, gen);

    footer.append(pdf, gen);
    panel.appendChild(footer);
    document.documentElement.appendChild(panel);
    return panel;
}

function exportFeaturePdf(kind,title,text) {
    const heading = kind === "terms" ? "Key Terms" : kind === "quiz" ? "Quiz" : "Revision Pack";
    if (kind === "quiz" && Array.isArray(lastGenerated.quiz) && lastGenerated.quiz.length) {
        const letters=["A","B","C","D"];
        const questions=lastGenerated.quiz.map((q,i)=>`<section class="pdf-question"><h2>${i+1}. ${richTextHtml(q.question||"")}</h2><div>${(q.options||[]).slice(0,4).map((o,j)=>`<p><b>${letters[j]}.</b> ${richTextHtml(o)}</p>`).join("")}</div></section>`).join("");
        const answers=lastGenerated.quiz.map((q,i)=>`<div class="pdf-answer"><b>${i+1}. ${escapeHtml(q.answer||"")}</b><div>${richTextHtml(q.explanation||"")}</div></div>`).join("");
        printPdfDocument("LectureAI — Quiz", `<header><h1>LectureAI · Quiz</h1><div class="lectureai-print-meta">${escapeHtml(currentCourse)} · ${escapeHtml(document.title || "University Lecture")}</div></header><section class="lectureai-print-section">${questions}</section><section class="lectureai-print-section answer-key"><h2>Answer Key & Explanations</h2>${answers}</section>`);
        return;
    }
    const body = `<header><h1>LectureAI · ${escapeHtml(heading)}</h1><div class="lectureai-print-meta">${escapeHtml(currentCourse)} · ${escapeHtml(document.title || "University Lecture")}</div></header><section class="lectureai-print-section"><div class="lectureai-print-body">${richTextHtml(text)}</div></section>`;
    printPdfDocument(`LectureAI — ${heading}`, body);
}

function generateFeature(kind, content, button) {
    if (!lectureTranscript.length) { content.textContent="目前还没有足够的课堂内容。请先播放 Lecture。"; return; }
    button.disabled=true; button.textContent="正在生成…";
    content.textContent="🧠 正在分析课堂内容…\n\n这次会优先使用 Lecture Memory，避免重新读取整节课。";
    const type = kind === "terms" ? "TERMS" : kind === "quiz" ? "QUIZ" : "REVISION";
    chrome.runtime.sendMessage({type,...lectureSourcePayload(getFeatureLanguage(kind))}, response => {
      button.disabled=false; button.textContent="重新生成";
      if (!response || !response.ok) { content.textContent=`❌ 生成失败\n\n${response?.error || "未知错误"}`; return; }
      if (kind === "terms") {
        lastGenerated.terms=response.terms||[];
        content.innerHTML=(response.terms||[]).map((t,i)=>`<div style="margin:0 0 18px"><strong>${i+1}. ${richTextHtml(t.term||"")}</strong><div style="margin-top:4px">${richTextHtml(t.translation||"")}</div><div style="margin-top:4px;color:#b8b8c0">${richTextHtml(t.definition||"")}</div></div>`).join("") || "没有返回 Key Terms。";
      } else if (kind === "quiz") {
        lastGenerated.quiz=response.quiz||[];
        content.innerHTML=quizHtml(response.quiz||[]);
        content.querySelectorAll(".lectureai-show-answer").forEach(btn=>btn.addEventListener("click",()=>{
          const box=btn.nextElementSibling;
          if (!box) return;
          const answer=btn.dataset.answer||"";
          const explanation=btn.dataset.explanation||"";
          box.hidden=false;
          box.innerHTML=`<div style="font-weight:700">✓ Answer: ${escapeHtml(answer)}</div><div style="margin-top:6px">${richTextHtml(explanation)}</div>`;
          btn.disabled=true; btn.textContent="已查看答案";
        }));
      } else {
        content.innerHTML=richTextHtml(formatRevision(response.revision||{}));
      }
    });
}

function formatTerms(terms) {
    return terms.map((t,i)=>`${i+1}. ${t.term || ""}\n   ${t.translation || ""}\n   ${t.definition || ""}`).join("\n\n") || "没有返回 Key Terms。";
}
function formatQuiz(items) {
    return items.map((q,i)=>`${i+1}. ${q.question || ""}\nA. ${q.options?.[0]||""}\nB. ${q.options?.[1]||""}\nC. ${q.options?.[2]||""}\nD. ${q.options?.[3]||""}\nAnswer: ${q.answer || ""}\nExplanation: ${q.explanation || ""}`).join("\n\n") || "没有返回 Quiz。";
}

function prettyMathText(value) {
    let s = String(value || "");
    const supers = {"0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","+":"⁺","-":"⁻","=":"⁼","(":"⁽",")":"⁾","n":"ⁿ","i":"ⁱ","x":"ˣ","y":"ʸ","θ":"ᶿ"};
    const subers = {"0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉","+":"₊","-":"₋","=":"₌","(":"₍",")":"₎","n":"ₙ","i":"ᵢ","x":"ₓ","y":"ᵧ"};
    const convertGroup = (text, map) => [...String(text)].map(ch => map[ch] || ch).join("");
    s = s.replace(/\^\{([^{}]+)\}/g, (_,g)=>convertGroup(g,supers));
    s = s.replace(/\^([A-Za-z0-9]+)/g, (_,g)=>convertGroup(g,supers));
    s = s.replace(/_\{([^{}]+)\}/g, (_,g)=>convertGroup(g,subers));
    s = s.replace(/_([A-Za-z0-9]+)/g, (_,g)=>convertGroup(g,subers));
    s = s.replace(/\\theta/g, "θ").replace(/\\pi/g, "π").replace(/\\infty/g, "∞").replace(/\\cdot/g, "·").replace(/\\pm/g, "±").replace(/\\leq/g, "≤").replace(/\\geq/g, "≥");
    s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1/$2)");
    return s;
}

function richTextHtml(value) {
    return escapeHtml(prettyMathText(value)).replace(/\n/g, "<br>");
}

function quizHtml(items) {
    if (!Array.isArray(items) || !items.length) return "<div>没有返回 Quiz。</div>";
    const letters = ["A","B","C","D"];
    return items.map((q,i)=>`<article class="lectureai-quiz-question" data-index="${i}">
      <div class="lectureai-quiz-q"><strong>${i+1}.</strong> ${richTextHtml(q.question || "")}</div>
      <div class="lectureai-quiz-options">${(q.options||[]).slice(0,4).map((opt,j)=>`<div class="lectureai-quiz-option"><b>${letters[j]}.</b> ${richTextHtml(opt)}</div>`).join("")}</div>
      <button type="button" class="lectureai-show-answer" data-answer="${escapeHtml(q.answer || "")}" data-explanation="${escapeHtml(q.explanation || "")}">查看答案</button>
      <div class="lectureai-answer-box" hidden></div>
    </article>`).join("");
}

function formatRevision(r) {
    return [r.overview&&`OVERVIEW\n${r.overview}`,r.coreConcepts&&`CORE CONCEPTS\n${r.coreConcepts.join("\n")}`,r.formulas&&`IMPORTANT FORMULAS\n${r.formulas.join("\n")}`,r.keyTerms&&`KEY TERMS\n${r.keyTerms.join("\n")}`,r.examples&&`WORKED EXAMPLES\n${r.examples.join("\n")}`,r.commonMistakes&&`COMMON MISTAKES\n${r.commonMistakes.join("\n")}`,r.examFocus&&`EXAM FOCUS\n${r.examFocus.join("\n")}`,r.quiz&&`QUIZ\n${formatQuiz(r.quiz)}`,r.quickReview&&`60-SECOND REVIEW\n${r.quickReview}`].filter(Boolean).join("\n\n────────────────────\n\n") || "没有返回 Revision Pack。";
}

function generateFeaturePanel(kind,title,subtitle) {
    const panel=openFeaturePanel(kind,title,subtitle);
    const content=document.getElementById(`lectureai-feature-${kind}-content`);
    const button=Array.from(panel.querySelectorAll("button")).find(b=>b.textContent.includes("重新生成"));
    generateFeature(kind,content,button);
}

function generateRevisionPack(){ generateFeaturePanel("revision","Revision Pack","完整课堂复习资料"); }

// Add PDF button to the existing Summary panel after it exists.
setInterval(() => { if (document.getElementById("lectureai-summary-panel")) ensureSummaryDownloadButton(); syncLectureContext(false); }, 30000);

// Core v7 unified menu actions.
function handleLectureAIMenuAction(action) {
    closeLectureAIMenu();
    if (action === "summary") { generateLectureSummary(); setTimeout(ensureSummaryDownloadButton,80); return; }
    if (action === "terms") { generateFeaturePanel("terms","Key Terms","专业词汇 · 课程上下文 · 简短解释"); return; }
    if (action === "quiz") { generateFeaturePanel("quiz","Quiz","基于本节课内容的练习题"); return; }
    if (action === "pdf" || action === "revision") { generateRevisionPack(); return; }
}

// ============================================================
// Initialize
// ============================================================

function initializeLectureAI() {

    removeOldUI();

    lectureAIButton =
        null;

    lectureAIMenu =
        null;


    createSubtitleBox();

    createSummaryPanel();

    createLectureAIButton();

    createLectureAIMenu();


    console.log(
        "⚡ LectureAI Core v7 ready"
    );

    console.log(
        "✦ Unified LectureAI menu ready"
    );


    checkSubtitle();

}


// ============================================================
// Start
// ============================================================

initializeLectureAI();


// ============================================================
// ULTRA FAST LOOP
// ============================================================

setInterval(
    checkSubtitle,
    CHECK_INTERVAL
);