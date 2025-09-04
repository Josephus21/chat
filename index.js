import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import OpenAI from "openai";
import "dotenv/config";
import * as franc from "franc"; // fixed import
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ✅ ERP constants
const ERP_API = "http://sandboxgsuite.graphicstar.com.ph/api/get_sales_orders";
const TOKEN = process.env.ERP_TOKEN;
const LOCATION_PK = "00a18fc0-051d-11ea-8e35-aba492d8cb65";
const EMPL_PK = "ef0926b0-04ff-11ee-8114-5534a282e29b";

// ✅ OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🔹 Step 0: Call ERP API
async function callERP(payload) {
  const response = await fetch(ERP_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return response.json();
}

// 🔹 Step 1: GPT → ERP payload + intent
async function questionToQuery(question) {
  const systemPrompt = `
You are an ERP query builder. 
Given a user question about sales orders, return a JSON object:

{
  "intent": "count" | "total" | "breakdown" | "max" | "min" | "list",
  "payload": {
    "empl_pk": "${EMPL_PK}",
    "preparedBy": "System Administrator",
    "viewAll": 1,
    "searchKey": "",
    "customerPK": null,
    "departmentPK": null,
    "filterDate": {
      "filter": "between",
      "date1": { "hide": false, "date": "YYYY-MM-DD" },
      "date2": { "hide": false, "date": "YYYY-MM-DD" }
    },
    "limit": 500,
    "offset": 0,
    "locationPK": "${LOCATION_PK}",
    "salesRepPK": null
  }
}

Rules:
- Detect if user wants count, total, breakdown, max, min, or list.
- Parse any date range. Default: Jan 01, 2000 → Dec 31, 2099.
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

  return JSON.parse(completion.choices[0].message.content);
}

// 🔹 Step 2: Summarize Answer
async function summarizeAnswer(question, intent, erpData) {
  const soArray = Array.isArray(erpData.data?.[0]) ? erpData.data[0] : [];
  const totalSO = erpData.data?.[1] ?? soArray.length;

  const flattenedERPData = {
    soList: soArray.map(so => so.so_upk),
    total: totalSO,
    summary: soArray.map(so => ({
      so_upk: so.so_upk,
      Status_TransH: so.Status_TransH,
      TotalAmount_TransH: so.TotalAmount_TransH,
      Name_Cust: so.Name_Cust,
      DateCreated_TransH: so.DateCreated_TransH
    }))
  };

  // Detect language
  const langCode = franc.franc(question);
  let language = "English";
  if (langCode === "tgl") language = "Tagalog";
  else if (langCode === "ceb") language = "Bisaya";

  // Check for specific SO
  const soNumberMatch = question.match(/SO-\d+/i);
  if (soNumberMatch) {
    const requestedSO = soNumberMatch[0];
    const soObj = soArray.find(so => so.so_upk.toUpperCase() === requestedSO.toUpperCase());
    if (soObj) {
      if (language === "English") {
        return `Sales Order ${requestedSO} details:\n- Status: ${soObj.Status_TransH}\n- Total Amount: ${soObj.TotalAmount_TransH}\n- Customer: ${soObj.Name_Cust}\n- Date Created: ${soObj.DateCreated_TransH}`;
      } else if (language === "Tagalog") {
        return `Detalye ng Sales Order ${requestedSO}:\n- Status: ${soObj.Status_TransH}\n- Kabuuang Halaga: ${soObj.TotalAmount_TransH}\n- Customer: ${soObj.Name_Cust}\n- Petsa ng Paglikha: ${soObj.DateCreated_TransH}`;
      } else {
        return `Detalye sa Sales Order ${requestedSO}:\n- Status: ${soObj.Status_TransH}\n- Total Amount: ${soObj.TotalAmount_TransH}\n- Customer: ${soObj.Name_Cust}\n- Date Created: ${soObj.DateCreated_TransH}`;
      }
    } else {
      if (language === "English") return `Sales order ${requestedSO} was not found in the selected range.`;
      if (language === "Tagalog") return `Hindi natagpuan ang Sales Order ${requestedSO} sa piniling saklaw.`;
      return `Wala nasakpan ang Sales Order ${requestedSO} sa napiling range.`;
    }
  }

  // General / hybrid
  const systemPrompt = `
You are a helpful ERP assistant answering sales order questions.
Answer in the same language as the user question: ${language}.
ERP data contains: soList, total, summary.
Intent: count, list, total, max, min, breakdown.
Rules:
- count: return total SOs
- list: list SO numbers
- total: sum TotalAmount_TransH
- max: SO with highest TotalAmount_TransH
- min: SO with lowest TotalAmount_TransH
- breakdown: group by customer, department, or month
- If soList is empty, say "No sales orders found."
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Question: ${question}\nIntent: ${intent}\nERP Data: ${JSON.stringify(flattenedERPData)}` },
    ],
  });

  return completion.choices[0].message.content;
}

// 🔹 Chatbot endpoint
app.post("/chatbot", async (req, res) => {
  try {
    const { question } = req.body;
    console.log("💬 User asked:", question);

    const erpKeywords = /(SO-|sales order|customer|department|total|count|breakdown|max|min|list)/i;

    if (!erpKeywords.test(question)) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: question }],
        temperature: 0,
      });
      return res.json({
        question,
        intent: "general",
        answer: completion.choices[0].message.content,
      });
    }

    // Step 1: Parse question → GPT for ERP intent
    const { intent, payload } = await questionToQuery(question);
    console.log("➡️ Intent:", intent);

    // Step 2: Fetch ERP
    const erpData = await callERP(payload);

    // Step 3: Summarize / hybrid answer
    const answer = await summarizeAnswer(question, intent, erpData);

    res.json({ question, intent, answer });
  } catch (err) {
    console.error("❌ Chatbot error:", err);
    res.status(500).json({ error: "Chatbot failed" });
  }
});

app.listen(3000, () => {
  console.log("✅ Chatbot running on http://localhost:3000");
});
