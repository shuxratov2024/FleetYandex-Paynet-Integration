require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

// .env fayldan ma'lumotlarni yuklash
const { YANDEX_PARK_ID, YANDEX_CLIENT_ID, YANDEX_API_KEY } = process.env;

// ⚠️ DIQQAT: O'zingizning to'lov kategoriya ID-ingizni bu yerga yozing
const YANDEX_CATEGORY_ID = "70000000000000000000000000000001"; 

const MAPPING_FILE = './drivers_mapping.json';
const PORT = process.env.PORT || 7153;

let virtualDatabase = new Map(); // Xotiradagi tezkor baza

const headers = { 
    'X-Client-ID': YANDEX_CLIENT_ID, 
    'X-API-Key': YANDEX_API_KEY,
    'Accept-Language': 'ru'
};

// =============================================================
// 🔄 TIZIMNI SINXRONIZATSIYA QILISH (Raqamlarni muzlatish)
// =============================================================
async function syncDrivers() {
    try {
        console.log("♻️ Haydovchilar ro'yxati tekshirilmoqda...");
        
        // 1. Fayldan saqlangan raqamlarni yuklash
        let savedMapping = {};
        if (fs.existsSync(MAPPING_FILE)) {
            savedMapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
        }

        // 2. Yandex'dan joriy haydovchilarni olish
        const res = await axios.post(`https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list`, {
            query: { park: { id: YANDEX_PARK_ID, driver_profile: { work_status: ['working'] } } },
            limit: 1000
        }, { headers });

        const drivers = res.data.driver_profiles;
        virtualDatabase.clear();

        // 3. Maksimal band qilingan raqamni aniqlash
        let usedIDs = Object.values(savedMapping).map(v => parseInt(v.virtualId));
        let nextID = usedIDs.length > 0 ? Math.max(...usedIDs) + 1 : 1000;

        drivers.forEach(d => {
            const p = d.driver_profile;
            const yandexId = p.id;
            const fullName = `${p.last_name || ""} ${p.first_name || ""}`.trim();

            let virtualId;

            // Agar haydovchi faylda bo'lsa - eski raqamini tiklaymiz
            if (savedMapping[yandexId]) {
                virtualId = savedMapping[yandexId].virtualId;
            } else {
                // Yangi haydovchi bo'lsa - yangi raqam beramiz
                virtualId = nextID.toString();
                savedMapping[yandexId] = { virtualId, name: fullName };
                nextID++;
            }

            virtualDatabase.set(virtualId, { yandexId, name: fullName });
        });

        // 4. Yangilangan xaritani faylga yozish
        fs.writeFileSync(MAPPING_FILE, JSON.stringify(savedMapping, null, 2));
        
        console.log(`✅ Jami ${virtualDatabase.size} ta haydovchi bazaga ulandi. Raqamlar saqlandi.`);
    } catch (e) {
        console.error("🔴 Sinxronizatsiya xatosi:", e.message);
    }
}

// Server yonganda va har 30 daqiqada yangilash
syncDrivers();
setInterval(syncDrivers, 30 * 60 * 1000);

// =============================================================
// 🛰 PAYNET RPC METODLARI
// =============================================================

app.post('/paynet/rpc', async (req, res) => {
    const { method, params, id } = req.body;
    const account = String(params.fields?.account || "").trim();

    // Virtual bazadan qidirish
    const driver = virtualDatabase.get(account);

    // --- 1. GetInformation (Haydovchini topish) ---
    if (method === 'GetInformation') {
        if (!driver) {
            return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Mijoz topilmadi" } });
        }

        console.log(`🔎 So'rov: [${account}] -> ${driver.name}`);
        return res.json({
            jsonrpc: "2.0", id,
            result: {
                status: "0",
                timestamp: new Date().toISOString(),
                fields: { name: driver.name }
            }
        });
    }

    // --- 2. PerformTransaction (Pul o'tkazish) ---
    if (method === 'PerformTransaction') {
        if (!driver) {
            return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Mijoz topilmadi" } });
        }

        try {
            const amountInSoums = Number(params.amount) / 100;
            const commission = amountInSoums * 0.045; // 4.5% komissiya
            const netAmount = amountInSoums - commission;

            // Yandex Fleet API orqali balansni to'ldirish
            await axios.post(`https://fleet-api.taxi.yandex.net/v2/parks/transactions`, {
                park_id: YANDEX_PARK_ID,
                contractor_profile_id: driver.yandexId,
                category_id: YANDEX_CATEGORY_ID,
                amount: String(netAmount.toFixed(2)),
                currency_code: "UZS",
                description: `Paynet ID: ${params.transactionId} (Virtual ID: ${account})`
            }, { headers });

            console.log(`💰 To'lov bajarildi: +${netAmount} UZS -> ${driver.name}`);

            return res.json({
                jsonrpc: "2.0", id,
                result: {
                    providerTrnId: String(Date.now()),
                    timestamp: new Date().toISOString(),
                    fields: { client_id: account }
                }
            });
        } catch (err) {
            console.error("❌ To'lov xatosi:", err.response?.data || err.message);
            return res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "Yandex to'lovni rad etdi" } });
        }
    }

    // --- 3. CheckTransaction (Statusni tekshirish) ---
    if (method === 'CheckTransaction') {
        return res.json({
            jsonrpc: "2.0", id,
            result: {
                transactionState: 1,
                timestamp: new Date().toISOString(),
                providerTrnId: String(Date.now())
            }
        });
    }

    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

app.listen(PORT, () => console.log(`🚀 PARK PEGAS Paynet server http://localhost:${PORT}/paynet/rpc manzilda ishlamoqda.`));