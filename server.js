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
    console.log("Incoming body from Retell:", JSON.stringify(req.body, null, 2));

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

    // Дуже важливо: повертаємо ticket_id в JSON,
    // Retell збереже це у call.retell_llm_dynamic_variables.ticket_id
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
    const { event, call } = body;

    if (!call) {
      console.log("No call object in webhook payload");
      return res.json({
        success: false,
        message: "no call object in webhook payload",
      });
    }

    // ticket_id, який повернула наша функція create_ticket,
    // Retell кладе в call.retell_llm_dynamic_variables
    const ticket_id =
      call.retell_llm_dynamic_variables?.ticket_id ||
      call.metadata?.ticket_id ||
      call.variables?.ticket_id;

    // Транскрипт дзвінка – за докою це call.transcript
    const transcript =
      call.transcript ||
      call.call_analysis?.transcript ||
      "";

    console.log("Parsed from webhook:", {
      ticket_id,
      hasTranscript: !!transcript,
    });

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

// ------------------------
// Start server
// ------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
