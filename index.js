require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 7153;
const YANDEX_BASE_URL = 'https://fleet-api.taxi.yandex.net';

const { YANDEX_PARK_ID, YANDEX_CLIENT_ID, YANDEX_API_KEY } = process.env;

// ⚠️ BU YERGA O'ZINGIZNING KATEGORIYA ID-INGIZNI QO'YING
const YANDEX_CATEGORY_ID = "70000000000000000000000000000001"; 

const headers = { 
    'X-Client-ID': YANDEX_CLIENT_ID, 
    'X-API-Key': YANDEX_API_KEY,
    'Accept-Language': 'ru'
};

// =============================================================
// 🔍 AQLLI QIDIRUV (POZIVNOY YOKI TEL OXIRGI 5 TASI)
// =============================================================
async function findDriver(queryID) {
    const search = String(queryID).trim();
    console.log(`\n🔍 Paynet qidiruvi: [${search}]`);

    try {
        const res = await axios.post(`${YANDEX_BASE_URL}/v1/parks/driver-profiles/list`, {
            query: { park: { id: YANDEX_PARK_ID, driver_profile: { work_status: ['working'] } } },
            limit: 500
        }, { headers });

        const drivers = res.data.driver_profiles;

        // Qidirish logikasi
        const found = drivers.find(d => {
            const p = d.driver_profile;
            const phone = (p.phones && p.phones[0]) ? p.phones[0].replace(/\D/g, '') : "";
            return (p.callsign === search || phone.endsWith(search));
        });

        if (found) {
            const p = found.driver_profile;
            const person = found.person || {};
            
            // F.I.SH yig'ish
            let fullName = person.full_name || `${p.last_name || ""} ${p.first_name || ""}`.trim();
            if (!fullName) fullName = "Haydovchi";

            console.log(`✅ TOPILDI: ${fullName}`);
            return { id: p.id, name: fullName };
        }

        console.log("❌ TOPILMADI.");
        return null;

    } catch (e) {
        console.error("🔴 API Xatosi:", e.message);
        return null;
    }
}

// =============================================================
// 🛰 PAYNET RPC INTERFEYSI
// =============================================================
app.post('/paynet/rpc', async (req, res) => {
    const { method, params, id } = req.body;

    // --- 1. GetInformation (Faqat ism chiqadi) ---
    if (method === 'GetInformation') {
        const driver = await findDriver(params.fields.account);
        if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Mijoz topilmadi" } });

        return res.json({
            jsonrpc: "2.0", id,
            result: {
                status: "0",
                timestamp: new Date().toISOString(),
                fields: {
                    name: driver.name  // Faqat ism yuboramiz
                }
            }
        });
    }

    // --- 2. PerformTransaction (Pulni tushirish) ---
    if (method === 'PerformTransaction') {
        const driver = await findDriver(params.fields.account);
        if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Mijoz topilmadi" } });

        try {
            const total = Number(params.amount) / 100;
            const netAmount = total - (total * 0.045); // 4.5% komissiya ayirish

            await axios.post(`${YANDEX_BASE_URL}/v2/parks/transactions`, {
                park_id: YANDEX_PARK_ID,
                contractor_profile_id: driver.id,
                category_id: YANDEX_CATEGORY_ID,
                amount: String(netAmount),
                currency_code: "UZS",
                description: `Paynet ID: ${params.transactionId}`
            }, { headers });

            console.log(`💰 To'ldirildi: +${netAmount} UZS (${driver.name})`);

            return res.json({
                jsonrpc: "2.0", id,
                result: {
                    providerTrnId: String(Date.now()),
                    timestamp: new Date().toISOString(),
                    fields: { client_id: params.fields.account }
                }
            });
        } catch (err) {
            console.error("❌ Xato:", err.response?.data || err.message);
            return res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "Yandex xatosi" } });
        }
    }

    // --- 3. CheckTransaction ---
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

app.listen(PORT, () => console.log(`🚀 Server http://localhost:${PORT}/paynet/rpc manzilda ishlamoqda.`));