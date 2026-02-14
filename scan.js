const https = require('https');

// Yandexning eng mashhur server IP manzillari
const candidates = [
    "213.180.204.225",
    "87.250.250.119",
    "93.158.134.119",
    "84.201.181.187",
    "87.250.251.46",
    "77.88.21.107",
    "5.255.255.5"
];

const agent = new https.Agent({ rejectUnauthorized: false });

console.log("---- QIDIRUV BOSHLANDI ----");

candidates.forEach(ip => {
    const req = https.request({
        hostname: ip, 
        path: '/v1/parks/driver-profiles/list', // Bu manzil faqat API da bor
        method: 'POST',
        headers: {
            'Host': 'fleet-api.yandex.net', // Biz "fleet-api" ni so'raymiz
            'Content-Type': 'application/json'
        },
        agent: agent,
        timeout: 5000
    }, (res) => {
        // Agar 401 (Auth Error) bersa - DEMAK BU API SERVER! (Chunki u kalit so'rayapti)
        if (res.statusCode === 401) {
            console.log(`\n✅✅✅ TOPILDI! OLTIN KALIT: ${ip}`);
            console.log(`Javob kodi: ${res.statusCode} (Bu to'g'ri!)`);
        } else if (res.statusCode === 404) {
            console.log(`❌ IP: ${ip} -> Xato joy (404 Not Found)`);
        } else {
            console.log(`⚠️ IP: ${ip} -> Javob: ${res.statusCode}`);
        }
    });

    req.on('error', (e) => {
        console.log(`💀 IP: ${ip} -> O'lik (Ulanib bo'lmadi)`);
    });

    req.end();
});
