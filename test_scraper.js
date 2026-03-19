const axios = require('axios');
const cheerio = require('cheerio');

async function testPriceCharting() {
    try {
        console.log('Testing PriceCharting...');
        const res = await axios.get('https://www.pricecharting.com/search-products?q=charizard&type=prices', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if(res.data.products) {
            console.log('Found PC Product Example:', res.data.products[0]);
        }
    } catch(e) { console.error('PriceCharting error:', e.message); }
}

async function testCollectr() {
    try {
        console.log('\nTesting Collectr Web App Scrape...');
        const res = await axios.get('https://app.getcollectr.com/search?query=charizard', { 
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        let jsonData = null;
        // Search for window.__NUXT__ or generic JSON injected payload
        const match = res.data.match(/window\.__NUXT__=(.*?);<\/script>/);
        if (match) {
            console.log('Found Nuxt JSON payload!');
            // the data is evaluated Javascript but could be parsable
        } else {
            console.log('Looking for algolia or other search hints. HTML Snippet:', res.data.substring(0, 300));
        }
    } catch(err) { console.error('Collectr Web App error:', err.message); }
}

async function run() {
    await testPriceCharting();
    await testCollectr();
}

run();

async function run() {
    await testPriceCharting();
    await testCollectr();
}

run();
