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

// ------------------------
// Створення тікета з Retell
// ------------------------
app.post("/create-ticket", async (req, res) => {
  try {
    // Подивитися, що саме приходить від Retell (можна потім видалити)
    console.log("Incoming body from Retell (create-ticket):", JSON.stringify(req.body, null, 2));

    // Працюємо з різними варіантами структури
    const raw = req.body || {};
    const args = raw.args || raw.arguments || raw.parameters || raw;

    const {
      name,
      email,
      issue_description,
      serial_number,
      car_model,
    } = args || {};

    const response = await fetch(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
            ).toString("base64"),
        },
        body: JSON.stringify({
          ticket: {
            subject: `AI Voice Bot Issue — ${name}`,
            comment: {
              body: `Issue Description:\n${issue_description}\n\nCustomer Information:\n- Name: ${name}\n- Email: ${email}\n- Serial Number: ${serial_number}\n- Car Model: ${car_model}`,
            },
            requester: {
              name: name,
              email: email,
            },
            tags: ["retell_ai", "voice_bot"],
          },
        }),
      }
    );

    const data = await response.json();
    const ticketId = data.ticket?.id;

    console.log("Zendesk ticket created:", ticketId);

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

// -------------------------------------------
// Webhook від Retell після дзвінка (транскрипт)
// -------------------------------------------
app.post("/retell-webhook", async (req, res) => {
  try {
    console.log("Incoming Retell webhook:", JSON.stringify(req.body, null, 2));

    const body = req.body || {};
    const call = body.call || {};

    // Якщо Retell шле різні типи подій, можна фільтрувати тільки фінальний аналіз
    // if (body.event && body.event !== "call_analyzed") {
    //   return res.json({ success: true, message: "Ignored non analyzed event" });
    // }

    // -----------------------------
    // 1) Дістаємо ticket_id
    // -----------------------------
    const variables =
      body.variables ||
      body.call_variables ||
      call.call_variables ||
      call.variables ||
      call.dynamic_variables ||
      call.metadata ||
      {};

    const ticket_id =
      variables.ticket_id ||
      body.ticket_id ||
      call.ticket_id ||
      null;

    // -----------------------------
    // 2) Дістаємо транскрипт
    // -----------------------------
    const transcript =
      body.transcript ||
      body.full_transcript ||
      call.transcript ||
      call.full_transcript ||
      body.text ||
      body.summary_text ||
      "";

    if (!ticket_id || !transcript) {
      console.log("Missing ticket_id or transcript in webhook payload", {
        ticket_id,
        hasTranscript: !!transcript,
      });
      // Відповідаємо 200, щоб Retell не спамив повторами
      return res.json({
        success: false,
        message: "ticket_id or transcript not found in webhook payload",
      });
    }

    console.log(`Appending transcript to ticket ${ticket_id} (length=${transcript.length})`);

    // Додаємо транскрипт як внутрішній коментар у вже створений тікет
    const response = await fetch(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
            ).toString("base64"),
        },
        body: JSON.stringify({
          ticket: {
            comment: {
              body: `Full call transcript:\n\n${transcript}`,
              public: false, // бачать тільки агенти
            },
          },
        }),
      }
    );

    const data = await response.json();
    console.log("Transcript appended to ticket:", data.ticket?.id);

    res.json({ success: true, zendesk_response: data });
  } catch (err) {
    console.error("Error in /retell-webhook:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// IMPORTANT: Render provides the PORT via environment variable
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
