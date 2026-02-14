require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');

// --- SOZLAMALAR ---
const YANDEX_PARK_ID = process.env.YANDEX_PARK_ID;
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Har 1 daqiqada (60000 ms) tekshiradi
const CHECK_INTERVAL = 60000; 
const URL_DRIVERS = "https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Haydovchilar bazasi fayli
const DB_FILE = './known_drivers.json';
let knownDrivers = new Set();

// 1. Dastur yonganda eski bazani yuklash
function loadDb() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            data.forEach(id => knownDrivers.add(id));
            console.log(`Bazada ${knownDrivers.size} ta haydovchi mavjud.`);
        } catch (e) {
            console.error("Bazani o'qishda xato:", e.message);
        }
    }
}
loadDb();

// 2. Asosiy tekshiruv funksiyasi
async function checkNewDrivers() {
    try {
        // Yandexdan barcha haydovchilarni olamiz
        const res = await axios.post(URL_DRIVERS, {
            query: { 
                park: { id: YANDEX_PARK_ID }, 
                driver_profile: { work_status: ['working', 'not_working'] } 
            },
            limit: 3000, 
            fields: {
                driver_profile: ["id", "first_name", "last_name", "phones", "created_date"]
            }
        }, { 
            headers: { 'X-Client-ID': YANDEX_CLIENT_ID, 'X-API-Key': YANDEX_API_KEY },
            httpsAgent: httpsAgent
        });

        const drivers = res.data.driver_profiles;
        let newDriversCount = 0;

        // Agar bu birinchi ishga tushish bo'lsa va baza bo'sh bo'lsa
        // Hammani "eski" deb belgilaymiz, xabar yubormaymiz (spam bo'lmasligi uchun)
        if (knownDrivers.size === 0 && drivers.length > 0) {
            drivers.forEach(d => knownDrivers.add(d.driver_profile.id));
            fs.writeFileSync(DB_FILE, JSON.stringify([...knownDrivers]));
            console.log(`Boshlang'ich baza yaratildi: ${drivers.length} ta haydovchi.`);
            bot.sendMessage(ADMIN_CHAT_ID, "🚀 Monitoring tizimi ishga tushdi! Hozircha yangi haydovchilar kuzatilmoqda.");
            return;
        }

        // Har bir haydovchini tekshiramiz
        for (const d of drivers) {
            const driverId = d.driver_profile.id;
            
            // Agar bu ID bizning bazada yo'q bo'lsa -> DEMAK YANGI!
            if (!knownDrivers.has(driverId)) {
                newDriversCount++;
                knownDrivers.add(driverId); // Bazaga qo'shamiz
                
                // Telegramga chiroyli xabar
                const name = `${d.driver_profile.last_name || ""} ${d.driver_profile.first_name || ""}`.trim();
                const phone = d.driver_profile.phones?.[0] || "Raqam yo'q";
                
                const message = `
🔔 <b>YANGI HAYDOVCHI QO'SHILDI!</b>

👤 <b>Ism:</b> ${name}
📞 <b>Tel:</b> ${phone}
🆔 <b>ID:</b> <code>${driverId}</code>

<i>Iltimos, haydovchi bilan bog'laning!</i>`;

                await bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: "HTML" });
                console.log(`Yangi haydovchi: ${name} (${phone})`);
            }
        }

        // Agar yangilar bo'lsa, bazani yangilab saqlaymiz
        if (newDriversCount > 0) {
            fs.writeFileSync(DB_FILE, JSON.stringify([...knownDrivers]));
        }

    } catch (e) {
        console.error("Tekshirishda xato:", e.message);
    }
}

// Har 1 daqiqada ishga tushadi
setInterval(checkNewDrivers, CHECK_INTERVAL);

// Dastur yonishi bilan darrov bir marta tekshirsin
checkNewDrivers();

console.log("Monitor Bot ishlayapti...");
