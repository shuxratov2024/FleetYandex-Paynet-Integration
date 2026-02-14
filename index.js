require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json());

// ENV ma'lumotlari
const YANDEX_PARK_ID = (process.env.YANDEX_PARK_ID || "").trim();
const YANDEX_CLIENT_ID = (process.env.YANDEX_CLIENT_ID || "").trim();
const YANDEX_API_KEY = (process.env.YANDEX_API_KEY || "").trim();
const PAYNET_LOGIN = (process.env.PAYNET_LOGIN || "").trim();
const PAYNET_PASSWORD = (process.env.PAYNET_PASSWORD || "").trim();
const PORT = process.env.PORT || 7153;

// --- SOZLAMALAR ---
const COMMISSION_PERCENT = 4.5; 
// DIQQAT: Rasmingizdagi URLda ko'ringan ID aynan shu (image_3ac50d.png)
const CATEGORY_ID = "partner_service_manual_4"; 
const URL_TRANSACTION = "https://fleet-api.taxi.yandex.net/v3/parks/driver-profiles/transactions";
const URL_DRIVERS = "https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let virtualDatabase = new Map();
let processedTransactions = new Map();

// Ma'lumotlarni yuklash
function loadData() {
    if (fs.existsSync('./drivers_mapping.json')) {
        try {
            const data = JSON.parse(fs.readFileSync('./drivers_mapping.json', 'utf8'));
            Object.keys(data).forEach(k => virtualDatabase.set(data[k].virtualId, { yandexId: k, name: data[k].name }));
        } catch (e) {}
    }
    if (fs.existsSync('./transactions_log.json')) {
        try {
            const data = JSON.parse(fs.readFileSync('./transactions_log.json', 'utf8'));
            processedTransactions = new Map(Object.entries(data));
        } catch (e) {}
    }
}
loadData();

// Auth Middleware
const authorize = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Auth required" });
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (auth[0] === PAYNET_LOGIN && auth[1] === PAYNET_PASSWORD) next();
    else res.status(401).json({ error: "Invalid credentials" });
};

// Driver Sync
async function syncDrivers() {
    try {
        const res = await axios.post(URL_DRIVERS, {
            query: { park: { id: YANDEX_PARK_ID }, driver_profile: { work_status: ['working'] } },
            limit: 1000
        }, { headers: { 'X-Client-ID': YANDEX_CLIENT_ID, 'X-API-Key': YANDEX_API_KEY }, httpsAgent });

        let mapping = fs.existsSync('./drivers_mapping.json') ? JSON.parse(fs.readFileSync('./drivers_mapping.json', 'utf8')) : {};
        let nextID = Object.values(mapping).length > 0 ? Math.max(...Object.values(mapping).map(v => parseInt(v.virtualId))) + 1 : 1000;

        res.data.driver_profiles.forEach(d => {
            if (!mapping[d.driver_profile.id]) {
                mapping[d.driver_profile.id] = { virtualId: nextID.toString(), name: `${d.driver_profile.last_name} ${d.driver_profile.first_name}` };
                nextID++;
            }
            virtualDatabase.set(mapping[d.driver_profile.id].virtualId, { yandexId: d.driver_profile.id, name: mapping[d.driver_profile.id].name });
        });
        fs.writeFileSync('./drivers_mapping.json', JSON.stringify(mapping, null, 2));
    } catch (e) {}
}
syncDrivers();
setInterval(syncDrivers, 600000);

// API PAYNET
app.post('/paynet/rpc', authorize, async (req, res) => {
    const { method, params, id } = req.body;
    const transactionId = String(params.transactionId || params.transactionID || "");
    const account = String(params.fields?.account || params.fields?.client_id || "").trim();

    // 1. GetInformation
    if (method === 'GetInformation') {
        const driver = virtualDatabase.get(account);
        if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Клиент не найден" } });
        return res.json({ jsonrpc: "2.0", id, result: { status: 0, timestamp: new Date().toISOString(), fields: { name: driver.name } } });
    }

    // 2. PerformTransaction
    if (method === 'PerformTransaction') {
        // DUPLICATE CHECK
        if (processedTransactions.has(transactionId)) {
            return res.json({
                jsonrpc: "2.0",
                id,
                error: { code: 201, message: "Tранзакция уже существует" }
            });
        }

        const driver = virtualDatabase.get(account);
        if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Клиент не найден" } });

        // KOMISSIYA 4.5% (Yashirin - Yandexda 0.00 bo'ladi)
        const rawAmount = Number(params.amount) / 100;
        const amountToDriver = (rawAmount * (1 - COMMISSION_PERCENT / 100)).toFixed(2);

        try {
            await axios.post(URL_TRANSACTION, {
                park_id: YANDEX_PARK_ID,
                contractor_profile_id: driver.yandexId,
                amount: amountToDriver,
                currency_code: "UZS",
                data: {
                    kind: "topup", 
                    category_id: CATEGORY_ID, // Paneldagi ID
                    description: "PAYNET",    // "Sharh" ustunida PAYNET chiqadi
                    event_at: new Date().toISOString(),
                    fee_amount: "0.00"
                }
            }, { 
                headers: { 
                    'X-Client-ID': YANDEX_CLIENT_ID, 
                    'X-API-Key': YANDEX_API_KEY,
                    'X-Idempotency-Token': transactionId
                },
                httpsAgent: httpsAgent
            });

            const providerTrnId = String(Date.now());
            const timestamp = new Date().toISOString();

            processedTransactions.set(transactionId, { status: 1, time: timestamp, providerTrnId, amount: rawAmount, account });
            fs.writeFileSync('./transactions_log.json', JSON.stringify(Object.fromEntries(processedTransactions)));

            return res.json({ jsonrpc: "2.0", id, result: { providerTrnId, timestamp, fields: { client_id: account } } });
        } catch (err) {
            return res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "System error" } });
        }
    }

    // 3. CheckTransaction
    if (method === 'CheckTransaction') {
        const trn = processedTransactions.get(transactionId);
        if (!trn) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Транзакция не найдена" } });
        return res.json({ jsonrpc: "2.0", id, result: { transactionState: trn.status, timestamp: trn.time, providerTrnId: trn.providerTrnId } });
    }

    // 4. CancelTransaction
    if (method === 'CancelTransaction') {
        const trn = processedTransactions.get(transactionId);
        if (!trn) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Транзакция не найдена" } });
        if (trn.status === 2) return res.json({ jsonrpc: "2.0", id, error: { code: 202, message: "Tранзакция уже отменена" } });

        trn.status = 2;
        processedTransactions.set(transactionId, trn);
        fs.writeFileSync('./transactions_log.json', JSON.stringify(Object.fromEntries(processedTransactions)));
        return res.json({ jsonrpc: "2.0", id, result: { transactionState: 2, timestamp: new Date().toISOString(), providerTrnId: trn.providerTrnId } });
    }

    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

app.listen(PORT, () => console.log(`Paynet Server ishladi. Port: ${PORT}`));
