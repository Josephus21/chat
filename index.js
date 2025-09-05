// ✅ server.js

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import OpenAI from "openai";
import "dotenv/config";
import * as franc from "franc";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ✅ ERP constants
const ERP_API = "http://gsuite.graphicstar.com.ph/api/get_sales_orders";
const TOKEN = process.env.ERP_TOKEN;
const LOCATION_PK = "00a18fc0-051d-11ea-8e35-aba492d8cb65";
const EMPL_PK = "c3f05940-066b-11ee-98e7-b92ca15f504a";
const PREPARED_BY = "Josephus Abatayo";

// ✅ OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Memory (cleared on refresh)
let memory = [];
let lastDateContext = null; // 🆕 track last used date

// Helper: Format PHP currency
function formatPeso(amount) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
  }).format(amount);
}

// 🔹 Call ERP API
async function callERP(payload) {
  try {
    const response = await fetch(ERP_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (err) {
    console.error("ERP API error:", err);
    return { data: [] };
  }
}

// 🔹 Fetch all sales orders with pagination
async function fetchAllSalesOrders(payload) {
  let allData = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const res = await callERP({ ...payload, limit, offset });
    const soList = res.data?.[0] || [];
    allData = allData.concat(soList);
    if (soList.length < limit) break;
    offset += limit;
  }

  return allData;
}

// 🔹 Parse question for date range
function getDateRangeFromQuestion(question) {
  const today = new Date();
  let start = null;
  let end = null;

  if (/yesterday/i.test(question)) {
    start = end = new Date(today.setDate(today.getDate() - 1));
  } else if (/last week/i.test(question)) {
    const day = today.getDay();
    start = new Date(today.setDate(today.getDate() - day - 7));
    end = new Date(today.setDate(today.getDate() - day - 1));
  } else if (/\d{4}-\d{2}-\d{2}/.test(question)) {
    const dates = question.match(/\d{4}-\d{2}-\d{2}/g);
    start = new Date(dates[0]);
    end = dates[1] ? new Date(dates[1]) : start;
  } else if (/september \d{1,2}, 2025/i.test(question)) {
    const day = question.match(/\d{1,2}/)[0];
    start = end = new Date(`2025-09-${day.padStart(2, "0")}`);
  }

  if (!start && lastDateContext) {
    // 🆕 fallback to last date if no new date detected
    return lastDateContext;
  }

  const format = (d) => d.toISOString().split("T")[0];
  const range = { date1: format(start), date2: format(end) };
  lastDateContext = range; // 🆕 update last context
  return range;
}

// 🔹 GPT → ERP payload + intent
async function questionToQuery(question) {
  const { date1, date2 } = getDateRangeFromQuestion(question);

  const systemPrompt = `
You are an ERP assistant. Given a user question about sales orders, return JSON:

{
  "intent": "count" | "total" | "breakdown" | "max" | "min" | "list",
  "payload": {
    "empl_pk": "${EMPL_PK}",
    "preparedBy": "${PREPARED_BY}",
    "viewAll": 1,
    "searchKey": "",
    "customerPK": null,
    "departmentPK": null,
    "filterDate": {
      "filter": "range",
      "date1": { "hide": false, "date": "${date1}" },
      "date2": { "hide": false, "date": "${date2}" }
    },
    "limit": 500,
    "offset": 0,
    "locationPK": "${LOCATION_PK}",
    "salesRepPK": null,
    "status": ""
  }
}

Rules:
- Detect intent from the question.
- Return JSON only.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0,
  });

  try {
    const content = completion.choices[0].message.content;
    const jsonStr = content.match(/\{[\s\S]*\}/)?.[0];
    return jsonStr ? JSON.parse(jsonStr) : { intent: "list", payload: {} };
  } catch (err) {
    console.error(
      "Failed to parse GPT output:",
      completion.choices[0].message.content
    );
    return { intent: "list", payload: {} };
  }
}

// 🔹 Pre-summarize ERP data
function summarizeERPData(erpData) {
  const totalsByCustomer = {};
  let totalAmount = 0;

  erpData.forEach((so) => {
    const amount = Number(so.TotalAmount_TransH || 0);
    if (isNaN(amount)) return;
    totalAmount += amount;
    const cust = so.Name_Cust || "Unknown";
    totalsByCustomer[cust] = (totalsByCustomer[cust] || 0) + amount;
  });

  const sortedCustomers = Object.entries(totalsByCustomer)
    .sort((a, b) => b[1] - a[1])
    .map(([name, amount]) => ({ name, amount }));

  return {
    totalAmount,
    totalSO: erpData.length,
    topCustomer: sortedCustomers[0]?.name || null,
    topAmount: sortedCustomers[0]?.amount || 0,
    rawOrders: erpData.map((so) => ({
      soNumber: so.so_upk,
      customer: so.Name_Cust,
      amount: Number(so.TotalAmount_TransH || 0),
      gpRate: Number(so.gpRate || 0),
      status: so.Status_TransH,
      date: so.DateCreated_TransH,
    })),
  };
}

// 🔹 Summarize Answer
async function summarizeAnswer(question, intent, summaryData) {
  const langCode = franc.franc(question) || "eng";
  let language =
    { eng: "English", tgl: "Tagalog", ceb: "Bisaya" }[langCode] || "English";

  const systemPrompt = `
You are a smart ERP assistant.
ERP summary data contains: totalSO, totalAmount, topCustomer, rawOrders.
Intent: count, list, total, max, min, breakdown.

Rules:
- count: return total SOs
- list: return list of SO numbers with their amounts and GP rates
- total: sum TotalAmount_TransH
- If rawOrders are provided, always include them when user asks for SO list or GP rate.
- Answer in ${language}.
- All amounts in ₱ (PHP).
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Question: ${question}\nIntent: ${intent}\nERP Summary Data: ${JSON.stringify(
          summaryData
        )}`,
      },
    ],
    temperature: 0,
  });

  return completion.choices[0].message.content;
}

// 🔹 Chatbot endpoint
app.post("/chatbot", async (req, res) => {
  try {
    const { question } = req.body;
    console.log("💬 User asked:", question);

    memory.push({ role: "user", content: question });

    const isERPQuestion = /(sales order|SO-|customer|amount|total|revenue|gp rate)/i.test(
      question
    );

    if (!isERPQuestion) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: memory,
        temperature: 0,
      });
      const answer = completion.choices[0].message.content;
      memory.push({ role: "assistant", content: answer });
      return res.json({ type: "text", data: answer });
    }

    // ERP Question → Process
    const { intent, payload } = await questionToQuery(question);
    const allSOData = await fetchAllSalesOrders(payload);
    const summaryData = summarizeERPData(allSOData);
    const answer = await summarizeAnswer(question, intent, summaryData);

    memory.push({ role: "assistant", content: answer });
    res.json({ type: "text", data: answer });
  } catch (err) {
    console.error("❌ Chatbot error:", err);
    res.status(500).json({ error: "Chatbot failed" });
  }
});

app.post("/reset-memory", (req, res) => {
  memory = [];
  lastDateContext = null;
  res.json({ success: true });
});

app.listen(3000, () =>
  console.log("✅ Chatbot running on http://localhost:3000")
);
