require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json());

// --- SOZLAMALAR ---
const YANDEX_PARK_ID = (process.env.YANDEX_PARK_ID || "").trim();
const YANDEX_CLIENT_ID = (process.env.YANDEX_CLIENT_ID || "").trim();
const YANDEX_API_KEY = (process.env.YANDEX_API_KEY || "").trim();
const PAYNET_LOGIN = (process.env.PAYNET_LOGIN || "").trim();
const PAYNET_PASSWORD = (process.env.PAYNET_PASSWORD || "").trim();
const PORT = process.env.PORT || 7153;

// SERVICE ID
const ALLOWED_SERVICE_ID = "107721"; 

const COMMISSION_PERCENT = 4.5; 
const CATEGORY_ID = "partner_service_manual_4"; 

const URL_TRANSACTION = "https://fleet-api.taxi.yandex.net/v2/parks/driver-profiles/transactions";
const URL_DRIVERS = "https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let virtualDatabase = new Map();
let processedTransactions = new Map();

// --- VAQT FORMATLASH ---

// 1. STANDART (YYYY-MM-DD HH:mm:ss)
function formatDateStandard(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 2. MAXSUS (CheckTransaction uchun)
function formatDateCheck(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const dayName = days[d.getDay()];
    const monthName = months[d.getMonth()];
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    const year = d.getFullYear();
    
    return `${dayName} ${monthName} ${day} ${hours}:${minutes}:${seconds} UZT ${year}`;
}

// --- BAZANI YUKLASH ---
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

// --- AUTH ---
const authorize = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Auth required" });
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (auth[0] === PAYNET_LOGIN && auth[1] === PAYNET_PASSWORD) next();
    else res.status(401).json({ error: "Invalid credentials" });
};

// --- SYNC ---
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

// --- API ---
app.post('/paynet/rpc', authorize, async (req, res) => {
    const { method, params, id } = req.body;

    // 1. SERVICE ID TEKSHIRUVI
    if (!params || !params.serviceId || String(params.serviceId) !== ALLOWED_SERVICE_ID) {
        return res.json({
            jsonrpc: "2.0",
            id: id,
            error: {
                code: 305,
                message: "Xizmat topilmadi" 
            }
        });
    }

    const transactionId = String(params.transactionId || params.transactionID || "");
    const account = String(params.fields?.account || params.fields?.client_id || "").trim();

    // ==========================================
    // 2. PERFORM TRANSACTION
    // ==========================================
    if (method === 'PerformTransaction') {
        // DUBLIKAT: Error 201
        if (processedTransactions.has(transactionId)) {
             return res.json({ 
                 jsonrpc: "2.0", 
                 id, 
                 error: { 
                     code: 201, 
                     message: "Транзакция уже существует" 
                 } 
            });
        }

        const driver = virtualDatabase.get(account);
        if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Клиент не найден" } });

        const rawAmount = Number(params.amount) / 100;
        const amountToDriver = (rawAmount * (1 - COMMISSION_PERCENT / 100)).toFixed(2);

        try {
            await axios.post(URL_TRANSACTION, {
                park_id: YANDEX_PARK_ID,
                driver_profile_id: driver.yandexId,
                amount: amountToDriver,
                currency_code: "UZS",
                description: "Пополнение баланса",
                category_id: CATEGORY_ID,
                data: {
                    kind: "partner_service_manual",
                    category_id: CATEGORY_ID,
                    description: "Пополнение баланса",
                    event_at: new Date().toISOString(),
                    fee_amount: "0.00"
                }
            }, { 
                headers: { 'X-Client-ID': YANDEX_CLIENT_ID, 'X-API-Key': YANDEX_API_KEY, 'X-Idempotency-Token': transactionId },
                httpsAgent: httpsAgent
            });

            const providerTrnId = Date.now(); 
            const timestamp = new Date().toISOString();
            
            processedTransactions.set(transactionId, { 
                status: 1, 
                time: timestamp, 
                providerTrnId, 
                amount: Number(params.amount),
                amountDriver: amountToDriver,
                account,
                yandexId: driver.yandexId 
            });
            fs.writeFileSync('./transactions_log.json', JSON.stringify(Object.fromEntries(processedTransactions)));

            return res.json({ 
                jsonrpc: "2.0", 
                id, 
                result: { 
                    timestamp: formatDateStandard(timestamp), 
                    providerTrnId: providerTrnId, 
                    fields: {
                        client_id: account 
                    }
                } 
            });
        } catch (err) {
            console.error("Yandex Error:", err.response?.data);
            return res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "System error" } });
        }
    }

    // ==========================================
    // 3. CHECK TRANSACTION
    // ==========================================
    if (method === 'CheckTransaction') {
        const trn = processedTransactions.get(transactionId);
        if (!trn) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Транзакция не найдена" } });
        
        // AGAR BEKOR QILINGAN (STATUS 2) BO'LSA -> 2 QAYTADI
        // Vaqt sifatida bekor qilingan vaqtni (cancelTime) oladi
        const finalTime = trn.status === 2 ? (trn.cancelTime || trn.time) : trn.time;

        return res.json({ 
            jsonrpc: "2.0", 
            id, 
            result: { 
                transactionState: Number(trn.status), // 1 yoki 2
                timestamp: formatDateCheck(finalTime), // Maxsus format
                providerTrnId: Number(trn.providerTrnId) 
            } 
        });
    }

    // ==========================================
    // 4. CANCEL TRANSACTION
    // ==========================================
    if (method === 'CancelTransaction') {
        const trn = processedTransactions.get(transactionId);
        if (!trn) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Транзакция не найдена" } });
        // Agar oldin bekor qilingan bo'lsa -> 202
        if (trn.status === 2) return res.json({ jsonrpc: "2.0", id, error: { code: 202, message: "Tранзакция уже отменена" } });

        try {
            const amountToDeduct = "-" + trn.amountDriver; 
            await axios.post(URL_TRANSACTION, {
                park_id: YANDEX_PARK_ID,
                driver_profile_id: trn.yandexId,
                amount: amountToDeduct,
                currency_code: "UZS",
                description: "Отмена транзакции (Paynet)",
                category_id: CATEGORY_ID,
                data: {
                    kind: "partner_service_manual",
                    category_id: CATEGORY_ID,
                    description: "Отмена транзакции (Paynet)",
                    event_at: new Date().toISOString(),
                    fee_amount: "0.00"
                }
            }, { 
                headers: { 'X-Client-ID': YANDEX_CLIENT_ID, 'X-API-Key': YANDEX_API_KEY, 'X-Idempotency-Token': `CANCEL_${transactionId}` },
                httpsAgent: httpsAgent
            });

            // STATUSNI 2 GA O'ZGARTIRAMIZ VA SAQLAYMIZ
            trn.status = 2;
            trn.cancelTime = new Date().toISOString();
            processedTransactions.set(transactionId, trn);
            fs.writeFileSync('./transactions_log.json', JSON.stringify(Object.fromEntries(processedTransactions)));

            return res.json({ 
                jsonrpc: "2.0", 
                id, 
                result: { 
                    transactionState: 2, 
                    timestamp: formatDateStandard(trn.cancelTime), 
                    providerTrnId: Number(trn.providerTrnId) 
                } 
            });

        } catch (err) {
            console.error("Cancel Error:", err.response?.data);
            return res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "Could not cancel transaction in Yandex" } });
        }
    }

    // ==========================================
    // 5. GET INFORMATION
    // ==========================================
    if (method === 'GetInformation') {
        const driver = virtualDatabase.get(account);
        if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Клиент не найден" } });
        
        return res.json({ 
            jsonrpc: "2.0", 
            id, 
            result: { 
                status: "0", // String
                timestamp: formatDateStandard(new Date().toISOString()), 
                fields: { name: driver.name } 
            } 
        });
    }

    // ==========================================
    // 6. GET STATEMENT (FAQAT SUCCESS)
    // ==========================================
    if (method === 'GetStatement') {
        const { dateFrom, dateTo } = params;
        const fromDate = new Date(dateFrom).getTime();
        const toDate = new Date(dateTo).getTime();
        
        let statements = [];

        for (let [key, val] of processedTransactions) {
            const trnTime = new Date(val.time).getTime();
            
            // FILTR: Status 1 bo'lishi SHART. (Bekor qilinganlar o'tmaydi)
            if (val.status === 1 && trnTime >= fromDate && trnTime <= toDate) {
                statements.push({
                    amount: Number(val.amount),
                    providerTrnId: Number(val.providerTrnId),
                    transactionId: Number(key),
                    timestamp: formatDateStandard(val.time)
                });
            }
        }

        return res.json({ jsonrpc: "2.0", id, result: { statements: statements } });
    }

    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

app.listen(PORT, () => console.log(`Paynet Server started on port ${PORT}`));
