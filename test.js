const axios = require('axios');

// 1. O'ZINGIZDAGI MA'LUMOTLARNI SHU YERGA YOZING (Qo'shtirnoq ichiga)
// Diqqat: Bo'sh joylar qolib ketmasin!

const PARK_ID = "b4d4f6c26f8945c1925d4a2b897827a7"; // Faqat raqam
const CLIENT_ID = "taxi/park/b4d4f6c26f8945c1925d4a2b897827a7"; // Oldida taxi/park/ bilan
const API_KEY = "lxeGzAesNkemMIDDsRlRRYwGHfWnOshmGgn"; // Yangi olgan kalitingiz

async function checkConnection() {
    console.log("-----------------------------------------");
    console.log("📡 Yandexga to'g'ridan-to'g'ri ulanish...");
    console.log(`🆔 Park ID: ${PARK_ID}`);
    console.log(`🔑 Client ID: ${CLIENT_ID}`);
    console.log("-----------------------------------------");

    try {
        const response = await axios.post(
            'https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list',
            {
                query: {
                    park: { id: PARK_ID }
                },
                limit: 1,
                fields: {
                    driver_profile: ["id"],
                    person: ["full_name"]
                }
            },
            {
                headers: {
                    'X-Client-ID': CLIENT_ID,
                    'X-API-Key': API_KEY,
                }
            }
        );

        console.log("✅ ULANISH MUVAFFAQIYATLI!");
        console.log("Topilgan haydovchi:", response.data.driver_profiles[0] ? "Bor" : "Ro'yxat bo'sh, lekin ulandi");
    
    } catch (error) {
        console.log("❌ XATOLIK BO'LDI:");
        if (error.response) {
            console.log(`Kod: ${error.response.status}`);
            console.log("Xabar:", error.response.data);
        } else {
            console.log(error.message);
        }
    }
}

checkConnection();