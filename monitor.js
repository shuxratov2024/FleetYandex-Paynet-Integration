require('dotenv').config(); // Eng tepada turishi shart!
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

// --- SOZLAMALAR ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.ADMIN_CHAT_ID; // Bu yerda muammo bo'lgan
const YANDEX_PARK_ID = process.env.YANDEX_PARK_ID;
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;

const CHECK_INTERVAL = 60000; // 1 daqiqa (429 xatosini oldini oladi)

// --- TEKSHIRUV ---
if (!TOKEN) { console.error("❌ XATO: TELEGRAM_BOT_TOKEN topilmadi!"); process.exit(1); }
if (!CHAT_ID) { console.error("❌ XATO: ADMIN_CHAT_ID topilmadi! .env faylini tekshiring."); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
let knownDrivers = new Set();

// Bazani yuklash
if (fs.existsSync('./known_drivers.json')) {
    const data = JSON.parse(fs.readFileSync('./known_drivers.json', 'utf8'));
    knownDrivers = new Set(data);
}

console.log("✅ Monitor Bot ishga tushdi...");
bot.sendMessage(CHAT_ID, "🚀 Monitoring tizimi qayta ishga tushdi! Har 60 soniyada tekshiradi.").catch(err => console.log("Telegram xatosi:", err.message));

async function checkDrivers() {
    try {
        const response = await axios.post('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
            query: {
                park: { id: YANDEX_PARK_ID },
                driver_profile: { work_status: ['working', 'fired', 'not_working'] } // Hamma statuslarni tekshiramiz
            },
            limit: 1000,
            fields: { driver_profile: ['id', 'first_name', 'last_name', 'phones'] }
        }, {
            headers: {
                'X-Client-ID': YANDEX_CLIENT_ID,
                'X-API-Key': YANDEX_API_KEY,
            }
        });

        const drivers = response.data.driver_profiles;
        let newDriversCount = 0;

        drivers.forEach(driver => {
            const driverId = driver.driver_profile.id;

            if (!knownDrivers.has(driverId)) {
                // YANGI HAYDOVCHI TOPILDI!
                newDriversCount++;
                const name = `${driver.driver_profile.last_name || ''} ${driver.driver_profile.first_name || ''}`;
                const phone = driver.driver_profile.phones?.[0] || "No'malum";

                const message = `🔔 <b>YANGI HAYDOVCHI!</b>\n\n👤 <b>Ism:</b> ${name}\n📞 <b>Tel:</b> ${phone}\n🆔 <code>${driverId}</code>`;

                bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' })
                   .catch(err => console.error("Xabar yuborishda xato:", err.message));

                knownDrivers.add(driverId);
            }
        });

        if (newDriversCount > 0) {
            fs.writeFileSync('./known_drivers.json', JSON.stringify([...knownDrivers]));
        }

    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.log("⚠️ Juda ko'p so'rov (429). 1 daqiqa dam olamiz...");
        } else {
            console.error("❌ Tekshirishda xato:", error.message);
        }
    }
}

// Dastur yonishi bilan bir marta, keyin har daqiqada tekshiradi
checkDrivers();
setInterval(checkDrivers, CHECK_INTERVAL);
