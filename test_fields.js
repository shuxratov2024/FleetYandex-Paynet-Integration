require('dotenv').config();
const axios = require('axios');

// Sozlamalar (.env dan oladi)
const YANDEX_BASE_URL = 'https://fleet-api.taxi.yandex.net';
const PARK_ID = process.env.YANDEX_PARK_ID ? process.env.YANDEX_PARK_ID.trim().replace(/;/g, '') : "";
const API_KEY = process.env.YANDEX_API_KEY ? process.env.YANDEX_API_KEY.trim().replace(/;/g, '') : "";
const CLIENT_ID = process.env.YANDEX_CLIENT_ID ? process.env.YANDEX_CLIENT_ID.trim().replace(/;/g, '') : "";

const headers = {
    'X-Client-ID': CLIENT_ID,
    'X-API-Key': API_KEY,
};

async function checkPaymentField() {
    console.log("🚀 TEKSHIRUV BOSHLANDI...");
    console.log("--------------------------------------------------");

    try {
        // Yandexdan 5 ta haydovchini so'raymiz (bitta bo'lsa ham yetadi)
        // 'fields' yozmaymiz, hammasini bersin
        const response = await axios.post(`${YANDEX_BASE_URL}/v1/parks/driver-profiles/list`, {
            query: {
                park: { id: PARK_ID }
            },
            limit: 5 
        }, { headers });

        const drivers = response.data.driver_profiles;

        if (!drivers || drivers.length === 0) {
            console.log("❌ Parkda haydovchilar topilmadi.");
            return;
        }

        console.log(`📊 ${drivers.length} ta haydovchi yuklandi.`);
        console.log("--------------------------------------------------");

        // Butun javobni tekstga aylantiramiz
        const rawJson = JSON.stringify(drivers, null, 2);

        // QIDIRAMIZ: "payment_service_id" so'zi bormi?
        if (rawJson.includes("payment_service_id")) {
            console.log("✅ URA! 'payment_service_id' MAYDONI MAVJUD!");
            console.log("👉 Demak, biz uni ishlatsak bo'ladi.");
            
            // Misol uchun birinchi haydovchinikini ko'rsatamiz (agar bo'lsa)
            drivers.forEach(d => {
                if (d.driver_profile.payment_service_id) {
                    console.log(`   Haydovchi ID: ${d.driver_profile.id} -> Payment ID: ${d.driver_profile.payment_service_id}`);
                }
            });

        } else {
            console.log("❌ AFSUSKI, 'payment_service_id' KELMADI.");
            console.log("👉 Yandex API bu maydonni bermayapti.");
            console.log("👉 Biz faqat 'Pozivnoy' (callsign) yoki 'Tabel raqam' (personnel_number) ishlatishimiz kerak.");
        }
        
        console.log("--------------------------------------------------");
        console.log("🔍 SHUNINGDEK, HAYDOVCHILARNING ASL KO'RINISHI (NAMUNA):");
        // Birinchi haydovchini to'liq chiqarib beramiz, o'z ko'zingiz bilan ko'rish uchun
        console.log(JSON.stringify(drivers[0], null, 2));

    } catch (error) {
        console.error("⚠️ XATOLIK:", error.message);
        if (error.response) console.log(error.response.data);
    }
}

checkPaymentField();