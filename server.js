const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.use(express.json());

// ------------------------
// Health-check endpoint
// ------------------------
app.get("/", (req, res) => {
  res.send("Retell → Zendesk backend is running.");
});

// =====================================================
// Helpers (Zendesk API)
// =====================================================

function zendeskAuthHeader() {
  return (
    "Basic " +
    Buffer.from(
      `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
    ).toString("base64")
  );
}

function zendeskBaseUrl() {
  return `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
}

function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function buildTagsFromCall(call) {
  const tags = new Set([
    "retell_ai",
    "voice_bot",
    "ai_voice",
    "ai_call_review",
  ]);

  const agentName = safeStr(call?.agent_name || call?.agentName || "");
  const callType = safeStr(call?.call_type || "");
  const inVoicemail = call?.call_analysis?.in_voicemail;
  const sentiment = safeStr(call?.call_analysis?.user_sentiment || "");

  if (callType) tags.add(`calltype_${callType.toLowerCase()}`);
  if (typeof inVoicemail === "boolean")
    tags.add(inVoicemail ? "voicemail_yes" : "voicemail_no");
  if (sentiment) tags.add(`sentiment_${sentiment.toLowerCase()}`);

  if (agentName) tags.add("agent_present");

  // Detect transfer / escalation signals from tool calls (best-effort)
  const toolCalls =
    call?.tool_calls ||
    call?.call_analysis?.tool_calls ||
    call?.transcript_with_tool_calls ||
    [];

  const toolCallsStr = JSON.stringify(toolCalls).toLowerCase();
  const transferred =
    toolCallsStr.includes("transfer") ||
    toolCallsStr.includes("call_transfer") ||
    toolCallsStr.includes("transfer_call") ||
    toolCallsStr.includes("forward") ||
    toolCallsStr.includes("dial");

  if (transferred) {
    tags.add("ai_transferred");
    tags.add("ai_escalated");
  } else {
    tags.add("ai_not_transferred");
  }

  // If call_successful exists, tag it
  const callSuccessful = call?.call_analysis?.call_successful;
  if (typeof callSuccessful === "boolean") {
    tags.add(callSuccessful ? "ai_call_success" : "ai_call_failed");
  }

  // Resolution heuristic: if transferred -> escalated; else resolved
  if (transferred) {
    tags.add("ai_escalated");
  } else {
    tags.add("ai_resolved");
  }

  return Array.from(tags);
}

function buildInternalCommentBody(call) {
  const callId = safeStr(call?.call_id || "");
  const agentName = safeStr(call?.agent_name || "");
  const startTs = call?.start_timestamp;
  const endTs = call?.end_timestamp;
  const durationMs = call?.duration_ms;

  const transcript =
    safeStr(call?.transcript) ||
    safeStr(call?.call_analysis?.transcript) ||
    "";

  const structuredSummary =
    safeStr(call?.call_analysis?.call_summary) ||
    safeStr(call?.call_analysis?.summary) ||
    "";

  const variables = call?.collected_dynamic_variables || {};
  const varsPretty =
    variables && Object.keys(variables).length
      ? JSON.stringify(variables, null, 2)
      : "N/A";

  const durationSec =
    typeof durationMs === "number" ? Math.round(durationMs / 1000) : "N/A";

  const header = [
    "=== AI VOICE CALL REVIEW ===",
    `Call ID: ${callId || "N/A"}`,
    `Agent Name: ${agentName || "N/A"}`,
    `Call Type: ${safeStr(call?.call_type || "N/A")}`,
    `Duration (sec): ${durationSec}`,
    `Start timestamp: ${safeStr(startTs || "N/A")}`,
    `End timestamp: ${safeStr(endTs || "N/A")}`,
    "",
    "=== COLLECTED VARIABLES ===",
    varsPretty,
    "",
  ].join("\n");

  const summaryBlock = [
    "=== CALL SUMMARY (from Retell call_analysis) ===",
    structuredSummary || "N/A",
    "",
  ].join("\n");

  const transcriptBlock = [
    "=== FULL TRANSCRIPT ===",
    transcript ? transcript : "N/A",
    "",
  ].join("\n");

  return `${header}\n${summaryBlock}\n${transcriptBlock}`;
}

async function zendeskSearchTicketIdByExternalId(externalId) {
  if (!externalId) return null;

  const query = encodeURIComponent(`type:ticket external_id:${externalId}`);
  const url = `${zendeskBaseUrl()}/search.json?query=${query}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: zendeskAuthHeader(),
    },
  });

  const data = await resp.json();
  const first = data?.results?.[0];
  return first?.id || null;
}

async function zendeskCreateTicket(payload) {
  const resp = await fetch(`${zendeskBaseUrl()}/tickets.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: zendeskAuthHeader(),
    },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

async function zendeskUpdateTicket(ticketId, payload) {
  const resp = await fetch(`${zendeskBaseUrl()}/tickets/${ticketId}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: zendeskAuthHeader(),
    },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

// =====================================================
// 1) Створення тікета з Retell (ескалація під час дзвінка)
// =====================================================
app.post("/create-ticket", async (req, res) => {
  try {
    console.log("Incoming body from Retell (create-ticket):", JSON.stringify(req.body, null, 2));

    const raw = req.body || {};
    const args = raw.args || raw.arguments || raw.parameters || raw;

    const {
      name,
      email,
      issue_description,
      serial_number,
      car_model,
      call_id, // optional (if you decide to pass it later)
    } = args || {};

    const tags = new Set(["retell_ai", "voice_bot", "ai_voice", "ai_escalated", "ai_ticket_escalation"]);
    if (call_id) tags.add("has_call_id");

    const payload = {
      ticket: {
        subject: `AI Voice Escalation — ${safeStr(name, "Customer")}`,
        comment: {
          body:
            `Issue Description:\n${safeStr(issue_description)}\n\n` +
            `Customer Information:\n` +
            `- Name: ${safeStr(name)}\n` +
            `- Email: ${safeStr(email)}\n` +
            `- Serial Number: ${safeStr(serial_number, "N/A")}\n` +
            `- Car Model: ${safeStr(car_model, "N/A")}\n` +
            (call_id ? `\nCall ID: ${call_id}\n` : ""),
        },
        requester: {
          name: safeStr(name, "Customer"),
          email: safeStr(email),
        },
        tags: Array.from(tags),
      },
    };

    // Optional: use external_id if call_id provided (helps dedupe)
    if (call_id) payload.ticket.external_id = safeStr(call_id);

    const data = await zendeskCreateTicket(payload);
    const ticketId = data.ticket?.id;

    console.log("Zendesk escalation ticket created:", ticketId);

    res.json({
      success: true,
      ticket_id: ticketId,
      zendesk_response: data,
    });
  } catch (err) {
    console.error("Error in /create-ticket:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =====================================================
// 2) Webhook від Retell після дзвінка — ALWAYS create QA ticket
// =====================================================
app.post("/retell-webhook", async (req, res) => {
  try {
    console.log("Incoming Retell webhook RAW:", JSON.stringify(req.body));

    const body = req.body || {};
    const { event, call } = body;

    // We accept both call_ended and call_analyzed (and anything that contains call object)
    if (!call) {
      console.log("No call object in webhook payload");
      return res.json({ success: false, message: "no call object in webhook payload" });
    }

    const callId = safeStr(call.call_id || "");
    if (!callId) {
      console.log("Missing call_id in webhook payload");
      return res.json({ success: false, message: "missing call_id" });
    }

    const transcript =
      safeStr(call.transcript) ||
      safeStr(call.call_analysis?.transcript) ||
      "";

    const summary =
      safeStr(call.call_analysis?.call_summary) ||
      safeStr(call.call_analysis?.summary) ||
      "";

    // If it's call_ended and call_analysis isn't ready yet — allow creating ticket with transcript only.
    // If it's call_analyzed — we typically have summary + transcript.
    if (!transcript && !summary) {
      console.log("No transcript/summary in payload yet, skipping ticket write (event):", event);
      // Return 200 to avoid retries
      return res.json({ success: true, message: "no transcript/summary yet" });
    }

    // 1) Find existing ticket by external_id (call_id) to prevent duplicates
    const existingTicketId = await zendeskSearchTicketIdByExternalId(callId);

    const tags = buildTagsFromCall(call);
    const internalBody = buildInternalCommentBody(call);

    // Placeholder requester (internal QA ticket)
    const qaName = process.env.AI_REVIEW_NAME || "AI Call Review";
    const qaEmail = process.env.AI_REVIEW_EMAIL || "ai-review@eviqo.com";

    if (existingTicketId) {
      // Update existing ticket (append new internal comment + merge tags)
      console.log("Found existing QA ticket for call_id, updating:", existingTicketId);

      const updatePayload = {
        ticket: {
          comment: {
            body: internalBody,
            public: false,
          },
          tags, // Zendesk will merge/replace tags; sending full set is OK
        },
      };

      const data = await zendeskUpdateTicket(existingTicketId, updatePayload);

      console.log("QA ticket updated:", data.ticket?.id);

      return res.json({ success: true, updated_ticket_id: data.ticket?.id });
    }

    // 2) Create a new QA ticket
    console.log("No existing QA ticket found, creating new one for call_id:", callId);

    const createPayload = {
      ticket: {
        external_id: callId, // key for dedupe
        subject: `AI Voice Call Review — ${safeStr(call.agent_name, "Agent")} — ${callId}`,
        comment: {
          body: internalBody,
          public: false, // internal only
        },
        requester: {
          name: qaName,
          email: qaEmail,
        },
        tags,
      },
    };

    const data = await zendeskCreateTicket(createPayload);
    const newTicketId = data.ticket?.id;

    console.log("QA ticket created:", newTicketId);

    return res.json({ success: true, created_ticket_id: newTicketId });
  } catch (err) {
    console.error("Error in /retell-webhook:", err);
    // Return 200? Better 500 so you see it, but Retell may retry.
    // If you want to STOP retries, return 200 with error message instead.
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------
// Start server
// ------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
