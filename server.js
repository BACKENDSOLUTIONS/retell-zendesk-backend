const express = require("express");
const fetch = require("node-fetch");
const app = express();

// ========================
// Body size limits (Fix 413 Payload Too Large)
// ========================
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ------------------------
// Config
// ------------------------
const EARLY_HANGUP_THRESHOLD_SEC = 20;

// Safety truncation for Zendesk comments
const MAX_TRANSCRIPT_CHARS = 20000;
const MAX_VARS_JSON_CHARS = 8000;
const MAX_SUMMARY_CHARS = 4000;

// ------------------------
// Health-check endpoint
// ------------------------
app.get("/", (req, res) => {
  res.send("Retell → Zendesk backend is running.");
});

// ------------------------
// Helpers
// ------------------------
function safeLower(x) {
  return (x || "").toString().toLowerCase();
}

function truncate(text, max) {
  const t = (text || "").toString();
  if (!t) return "";
  if (!max || t.length <= max) return t;
  return t.slice(0, max) + "\n\n[TRUNCATED]";
}

function didTransfer(call) {
  // 1) transcript_with_tool_calls often contains tool_call_invocation
  const twtc = call?.transcript_with_tool_calls;
  if (Array.isArray(twtc)) {
    const has = twtc.some(
      (e) =>
        e?.role === "tool_call_invocation" &&
        safeLower(e?.name).includes("transfer")
    );
    if (has) return true;
  }

  // 2) call.tool_calls — array with {name,type,...}
  const toolCalls = call?.tool_calls;
  if (Array.isArray(toolCalls)) {
    const has
