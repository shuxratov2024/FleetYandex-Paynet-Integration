require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// --- SOZLAMALAR ---
const PORT = process.env.PORT || 7153;
const YANDEX_BASE_URL = 'https://fleet-api.taxi.yandex.net';

// .env dan ma'lumotlarni olish
const PARK_ID = process.env.YANDEX_PARK_ID;
const CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const API_KEY = process.env.YANDEX_API_KEY;

// MUHIM: Bu yerga boya konsolda chiqqan Kategoriya ID sini qo'ying
const YANDEX_CATEGORY_ID = "70000000000000000000000000000001"; 

const headers = { 
    'X-Client-ID': CLIENT_ID, 
    'X-API-Key': API_KEY,
    'Accept-Language': 'eng'
};

// =============================================================
// 1. AQLLI QIDIRUV (Pozivnoy yoki Tel oxirgi 5 tasi)
// =============================================================
async function findDriverSmart(searchText) {
    const queryID = String(searchText).trim();
    console.log(`\n🔍 Qidirilmoqda: [${queryID}]`);

    try {
        const response = await axios.post(`${YANDEX_BASE_URL}/v1/parks/driver-profiles/list`, {
            query: {
                park: { id: PARK_ID, driver_profile: { work_status: ['working'] } }
            },
            limit: 500 
        }, { headers });

        const drivers = response.data.driver_profiles;

        if (!drivers || drivers.length === 0) return null;

        const found = drivers.find(d => {
            const p = d.driver_profile;
            const callsign = p.callsign ? String(p.callsign).trim() : "";
            if (callsign === queryID) return true;

            const phone = (p.phones && p.phones[0]) ? p.phones[0].replace(/\D/g, '') : "";
            if (phone.endsWith(queryID)) return true;

            return false;
        });

        if (found) {
            const p = found.driver_profile;
            const person = found.person || {};

            // Ismni yig'ish
            let name = "Ismsiz haydovchi";
            if (person.full_name) {
                name = person.full_name;
            } else if (p.last_name || p.first_name) {
                name = `${p.last_name || ""} ${p.first_name || ""}`.trim();
            }

            const balance = found.account ? Number(found.account.balance) : 0;
            console.log(`✅ TOPILDI: ${name} | Balans: ${balance} so'm`);
            
            return { id: p.id, name, balance };
        }
        return null;
    } catch (error) {
        console.error("🔴 API Xatosi:", error.message);
        return null;
    }
}

// =============================================================
// 2. PAYNET RPC METODLARI
// =============================================================
app.post('/paynet/rpc', async (req, res) => {
    const { method, params, id } = req.body;

    // --- A) GetInformation (Haydovchini tekshirish) ---
    if (method === 'GetInformation') {
        const driver = await findDriverSmart(params.fields.account);
        
        if (!driver) {
            return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Haydovchi topilmadi" } });
        }

        return res.json({
            jsonrpc: "2.0", id,
            result: {
                status: "0",
                timestamp: new Date().toISOString(),
                fields: { name: driver.name, balance: driver.balance }
            }
        });
    }

    // --- B) PerformTransaction (Pul o'tkazish) ---
    if (method === 'PerformTransaction') {
        const driver = await findDriverSmart(params.fields.account);
        if (!driver) return res.json({ jsonrpc: "2.0", id, error: { code: 302, message: "Haydovchi topilmadi" } });

        try {
            const totalAmount = Number(params.amount) / 100; // Tiyindan so'mga
            const paynetFee = totalAmount * 0.045;           // 4.5% Paynet xizmat haqi
            const netAmount = totalAmount - paynetFee;       // Haydovchiga boradigan sof summa

            console.log(`\n💸 To'lov: ${totalAmount} so'm`);
            console.log(`🧾 Paynet 4.5%: -${paynetFee} so'm`);
            console.log(`🚀 Yandexga: ${netAmount} so'm`);

            // Yandex balansini to'ldirish
            await axios.post(`${YANDEX_BASE_URL}/v2/parks/transactions`, {
                park_id: PARK_ID,
                contractor_profile_id: driver.id,
                category_id: YANDEX_CATEGORY_ID,
                amount: String(netAmount),
                currency_code: "UZS",
                description: `Paynet ID: ${params.transactionId} (4.5% fee deducted)`
            }, { headers });

            return res.json({
                jsonrpc: "2.0", id,
                result: {
                    providerTrnId: String(Date.now()),
                    timestamp: new Date().toISOString(),
                    fields: { client_id: params.fields.account }
                }
            });
        } catch (e) {
            console.error("🔴 To'lovda xato:", e.response ? e.response.data : e.message);
            return res.json({ jsonrpc: "2.0", id, error: { code: 102, message: "Yandex qabul qilmadi" } });
        }
    }

    // --- C) CheckTransaction (Holatni tekshirish) ---
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

app.listen(PORT, () => console.log(`🚀 Park Pegas Serveri: http://localhost:${PORT}/paynet/rpc`));