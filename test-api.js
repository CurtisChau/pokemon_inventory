const axios = require('axios');
const http = require('http');
const https = require('https');

const axiosInstance = axios.create({
    httpAgent: new http.Agent({ family: 4 }),
    httpsAgent: new https.Agent({ family: 4 })
});

async function testAxios() {
    const start = Date.now();
    try {
        const urlStr = 'https://api.pokemontcg.io/v2/cards?q=name:"pikachu"&pageSize=25';
        console.log("Fetching:", urlStr);
        const res = await axiosInstance({
            url: urlStr,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000
        });
        console.log("Axios Success in", Date.now() - start, "ms. Found:", res.data.data ? res.data.data.length : 0);
    } catch(e) {
        console.log("Axios Error in", Date.now() - start, "ms:", e.message);
    }
}
testAxios();
