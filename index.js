require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 7153;
const YANDEX_BASE_URL = 'https://fleet-api.taxi.yandex.net';

const PARK_ID = process.env.YANDEX_PARK_ID ? process.env.YANDEX_PARK_ID.trim().replace(/;/g, '') : "";
const CLIENT_ID = process.env.YANDEX_CLIENT_ID ? process.env.YANDEX_CLIENT_ID.trim().replace(/;/g, '') : "";
const API_KEY = process.env.YANDEX_API_KEY ? process.env.YANDEX_API_KEY.trim().replace(/;/g, '') : "";
const COMMISSION_PERCENT = 2;

const app = express();
app.use(bodyParser.json());

const headers = { 'X-Client-ID': CLIENT_ID, 'X-API-Key': API_KEY };

// =================================================================
// HAYDOVCHINI QIDIRISH (POZIVNOY / CALLSIGN BO'YICHA)
// =================================================================
async function findDriverById(searchVal) {
    const searchText = String(searchVal).trim();
    console.log(`🔍 QIDIRUV (Pozivnoy): "${searchText}"`);

    try {
        // 1. ANIQ SO'ROV: "callsign" filtrini ishlatamiz.
        // fields ni yozmaymiz (400 xatodan qochish uchun).
        const response = await axios.post(`${YANDEX_BASE_URL}/v1/parks/driver-profiles/list`, {
            query: {
                park: { 
                    id: PARK_ID,
                    driver_profile: { callsign: searchText } // <--- ENG MUHIM JOYI SHU!
                }
            },
            limit: 1
        }, { headers });

        const drivers = response.data.driver_profiles;

        // 2. TEKSHIRUV
        if (drivers && drivers.length > 0) {
            const d = drivers[0];
            
            // Yandex rostan ham shu pozivnoyli odamni berdimi?
            // Ba'zan kesh tufayli eski ma'lumot qolishi mumkin, shuning uchun tekshiramiz.
            if (d.driver_profile.callsign !== searchText) {
                console.log(`⚠️ XAVFLI: So'ralgan pozivnoy "${searchText}", lekin keldi "${d.driver_profile.callsign}"`);
                return null;
            }

            // Ismni yig'amiz
            let fullName = "Ismi Yo'q";
            if (d.person) {
                if (d.person.full_name) fullName = d.person.full_name;
                else if (d.person.first_name) fullName = `${d.person.last_name || ''} ${d.person.first_name}`.trim();
            }

            console.log(`✅ TOPILDI (Pozivnoy): ${fullName}`);
            console.log(`   ID: ${d.driver_profile.id}`);

            return {
                driver_profile: { id: d.driver_profile.id },
                person: { full_name: fullName },
                account: { balance: (d.account && d.account.balance) ? Number(d.account.balance) : 0 }
            };
        } 
        
        console.log("❌ Bu Pozivnoy bo'yicha hech kim topilmadi.");
        return null;

    } catch (error) {
        console.error("XATO:", error.message);
        if (error.response) console.error(JSON.stringify(error.response.data, null, 2));
        return null;
    }
}

// =================================================================
// 2. KATEGORIYA
// =================================================================
async function getTransactionCategoryId() {
    try {
        const res = await axios.post(`${YANDEX_BASE_URL}/v2/parks/transaction-categories/list`, {
            query: { park: { id: PARK_ID } }
        }, { headers });
        const target = res.data.transaction_categories.find(c => c.is_enabled && c.is_income); 
        return target ? target.id : null;
    } catch (e) { return null; }
}

const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const creds = Buffer.from(`${process.env.PAYNET_USER}:${process.env.PAYNET_PASSWORD}`).toString('base64');
    if (!authHeader || authHeader !== `Basic ${creds}`) return res.status(401).json({ error: "Unauthorized" });
    next();
};

// =================================================================
// 3. API YO'LLARI
// =================================================================
app.post('/paynet/rpc', authenticate, async (req, res) => {
    const { method, params, id } = req.body;
    
    if (params && params.fields) {
        console.log(`📥 Paynet: ${params.fields.account} (${method})`);
    }

    try {
        if (method === 'GetInformation') {
            const driver = await findDriverById(params.fields.account);
            if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Client not found" } });
            return res.json({ jsonrpc: "2.0", id, result: { status: "0", timestamp: new Date().toISOString(), fields: { name: driver.person.full_name, balance: driver.account.balance } } });
        } 
        else if (method === 'PerformTransaction') {
            const driver = await findDriverById(params.fields.account);
            if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Client not found" } });

            const amount = Number(params.amount) / 100;
            const finalAmount = amount - (amount * (COMMISSION_PERCENT / 100));
            const categoryId = await getTransactionCategoryId();
            if (!categoryId) return res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "Transaction Category Not Found" } });

            await axios.post(`${YANDEX_BASE_URL}/v2/parks/transactions`, {
                park_id: PARK_ID, contractor_profile_id: driver.driver_profile.id, category_id: categoryId, 
                amount: String(finalAmount), currency_code: 'UZS', description: `Paynet ID: ${params.transactionId}`
            }, { headers });

            return res.json({ jsonrpc: "2.0", id, result: { providerTrnId: Date.now(), timestamp: new Date().toISOString(), fields: { client_id: params.fields.account } }});
        }
        else if (method === 'CheckTransaction') return res.json({ jsonrpc: "2.0", id, result: { transactionState: 1, timestamp: new Date().toISOString(), providerTrnId: Date.now() }});
        
        res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });

    } catch (error) { console.error("XATO:", error.message); res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "System Error" } }); }
});

app.listen(PORT, () => console.log(`🚀 Server ishga tushdi: Port ${PORT}`));