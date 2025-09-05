import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import OpenAI from "openai";
import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const ERP_API = "http://gsuite.graphicstar.com.ph/api/get_sales_orders";
const TOKEN = process.env.ERP_TOKEN;
const LOCATION_PK = "00a18fc0-051d-11ea-8e35-aba492d8cb65";
const EMPL_PK = "c3f05940-066b-11ee-98e7-b92ca15f504a";
const PREPARED_BY = "Josephus Abatayo";
const DATA_FILE = process.env.RENDER
  ? path.join("/tmp", "erpData.json")    // ephemeral, works for updates while container runs
  : path.join(__dirname, "erpData.json"); // local persistent file

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory storage
let allERPData = [];

// Load existing ERP data from disk
if (fs.existsSync(DATA_FILE)) {
  allERPData = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  console.log(`✅ Loaded ${allERPData.length} ERP records from disk`);
}

// Utility
function formatPeso(amount) {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(amount);
}

// Fetch ERP API
async function callERP(payload) {
  try {
    const response = await fetch(ERP_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (err) {
    console.error("ERP API error:", err);
    return { data: [] };
  }
}

// Fetch all sales orders with pagination
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

// Summarize ERP data for filtering
function summarizeERPData(erpData) {
  return erpData.map((so) => ({
    ...so, // Keep all fields
    division: so.Name_Dept || "Unknown",
    salesRep: so.Name_Empl || "Unknown",
    amount: Number(so.TotalAmount_TransH || 0),
    gpRate: parseFloat((so.gpRate || "0").toString().replace("%", "").replace(",", "")),
    date: so.DateCreated_TransH,
  }));
}

// Merge new ERP data
function mergeNewData(newData) {
  const existingSO = new Set(allERPData.map(o => o.so_pk));
  const filteredNew = newData.filter(o => !existingSO.has(o.so_pk));
  if (filteredNew.length > 0) {
    allERPData.push(...filteredNew);
    fs.writeFileSync(DATA_FILE, JSON.stringify(allERPData, null, 2));
    console.log(`✅ Added ${filteredNew.length} new ERP records`);
  }
}

// Parse question with GPT
async function parseQuestionWithGPT(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `
You are an ERP assistant. Detect if this question is about ERP sales orders or general. 
Return JSON with intent, date, year, gpThreshold, customer, status, topN, requested fields. 
If it's a general question, return intent: "general".

Question: "${question}"

Return only JSON like:
{
  "intent": "count" | "list" | "sample" | "topCustomers" | "topDivision" | "topSales" | "general",
  "date": "YYYY-MM-DD" | null,
  "year": "YYYY" | null,
  "gpThreshold": { "operator": ">", "value": 55 } | null,
  "customer": "customer keyword" | null,
  "status": "BILLED" | "JO IN-PROCESS" | null,
  "topN": 1 | 2 | 3 | null,
  "fields": ["so_number","gp_rate"]
}`
        }
      ],
      temperature: 0
    });

    let content = completion.choices[0].message.content;
    content = content.replace(/```json|```/g, "").trim();
    let parsed = JSON.parse(content);
    if (!parsed.intent) parsed.intent = "general";
    if (!parsed.fields) parsed.fields = [];
    return parsed;
  } catch (err) {
    console.error("GPT JSON parse error:", err);
    return { intent: "general", date: null, gpThreshold: null, customer: null, status: null, fields: [], topN: null, year: null };
  }
}

// Filter ERP data
function filterOrders(orders, parsed) {
  let filtered = orders;

  if (parsed.customer) {
    const kw = parsed.customer.toLowerCase();
    filtered = filtered.filter(o =>
      (o.Name_Cust || "").toLowerCase().includes(kw) ||
      (o.ContractDescription_TransH || "").toLowerCase().includes(kw) ||
      (o.Memo_TransH || "").toLowerCase().includes(kw)
    );
  }

  if (parsed.gpThreshold) {
    const { operator, value } = parsed.gpThreshold;
    filtered = filtered.filter(o => {
      switch (operator) {
        case ">": return o.gpRate > value;
        case "<": return o.gpRate < value;
        case ">=": return o.gpRate >= value;
        case "<=": return o.gpRate <= value;
        case "=": return o.gpRate === value;
        default: return true;
      }
    });
  }

  if (parsed.date) filtered = filtered.filter(o => o.DateCreated_TransH === parsed.date);
  if (parsed.year) filtered = filtered.filter(o => o.DateCreated_TransH.startsWith(parsed.year));

  return filtered;
}

// Format response
async function formatResponse(orders, parsed, question) {
  if (parsed.intent === "general") {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
      temperature: 0
    });
    return completion.choices[0].message.content;
  }

  if (!orders.length) return "There are 0 sales orders matching your query.";

  const mapFields = (o) => {
    if (parsed.fields && parsed.fields.length) {
      return parsed.fields.map(f => {
        switch(f) {
          case "so_number": return `so_number: ${o.so_upk || "N/A"}`;
          case "gp_rate": return `gp_rate: ${o.gpRate != null ? o.gpRate : "N/A"}`;
          default: return `${f}: ${o[f] || "N/A"}`;
        }
      }).join(" - ");
    } else {
      // Default output: minimal
      return `so_number: ${o.so_upk || "N/A"} - gp_rate: ${o.gpRate != null ? o.gpRate : "N/A"}`;
    }
  };

  if (parsed.intent === "count") {
    const totalAmount = orders.reduce((sum, o) => sum + o.amount, 0);
    const highestGP = Math.max(...orders.map(o => o.gpRate));
    return `Total Sales Orders: ${orders.length}\nTotal Amount: ${formatPeso(totalAmount)}\nHighest GP Rate: ${highestGP.toFixed(2)}%`;
  }

  if (parsed.intent === "list") return orders.map(mapFields).join("\n");
  if (parsed.intent === "sample") return mapFields(orders[0]);

  if (parsed.intent === "topCustomers") {
    const customerMap = {};
    orders.forEach(o => { customerMap[o.Name_Cust] = (customerMap[o.Name_Cust] || 0) + o.amount; });
    const sorted = Object.entries(customerMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([cust, amt], i) => `Top ${i+1} Customer: ${cust} - Total Amount: ${formatPeso(amt)}`).join("\n");
  }

  if (parsed.intent === "topDivision") {
    const divisionMap = {};
    orders.forEach(o => { divisionMap[o.division] = (divisionMap[o.division] || 0) + o.amount; });
    const sorted = Object.entries(divisionMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([div, amt], i) => `Top ${i+1} Division: ${div} - Total Amount: ${formatPeso(amt)}`).join("\n");
  }

  if (parsed.intent === "topSales") {
    const salesMap = {};
    orders.forEach(o => { salesMap[o.salesRep] = (salesMap[o.salesRep] || 0) + o.amount; });
    const sorted = Object.entries(salesMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([rep, amt], i) => `Top ${i+1} Sales Personnel: ${rep} - Total Amount: ${formatPeso(amt)}`).join("\n");
  }

  return "Could not understand the question.";
}

// Preload ERP data year-by-year
async function preloadERPData() {
  const startYear = 2020;
  const endYear = new Date().getFullYear();
  for (let year = startYear; year <= endYear; year++) {
    console.log(`Fetching ERP data for year ${year}...`);
    const payload = {
      empl_pk: EMPL_PK,
      preparedBy: PREPARED_BY,
      viewAll: 1,
      searchKey: "",
      customerPK: null,
      departmentPK: null,
      filterDate: { filter: "range", date1: { hide: false, date: `${year}-01-01` }, date2: { hide: false, date: `${year}-12-31` } },
      limit: 500,
      offset: 0,
      locationPK: LOCATION_PK,
      salesRepPK: null,
      status: "",
    };
    const rawData = await fetchAllSalesOrders(payload);
    const summarized = summarizeERPData(rawData);
    mergeNewData(summarized);
    console.log(`✅ Completed loading year ${year} with ${summarized.length} records`);
  }
}

// Update ERP data every minute
setInterval(async () => {
  console.log("Updating ERP data...");
  await preloadERPData();
}, 60_000);

// Chatbot endpoint
app.post("/chatbot", async (req, res) => {
  try {
    const { question } = req.body;
    const parsed = await parseQuestionWithGPT(question);
    const filtered = filterOrders(allERPData, parsed);
    const answer = await formatResponse(filtered, parsed, question);
    res.json({ type: "text", data: answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chatbot failed" });
  }
});

// Reset memory
app.post("/reset-memory", (req, res) => res.json({ success: true }));

// Start server and preload data
app.listen(3000, async () => {
  console.log("✅ Chatbot running on http://localhost:3000");
  await preloadERPData();
});
	
