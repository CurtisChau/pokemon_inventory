const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');

const axiosInstance = axios.create({
    httpAgent: new http.Agent({ family: 4 }),
    httpsAgent: new https.Agent({ family: 4 })
});

const fetchWithTimeout = async (url, options = {}) => {
    const { timeout = 8000, headers = {}, ...fetchOptions } = options;
    try {
        const response = await axiosInstance({
            url,
            headers,
            ...fetchOptions,
            timeout
        });
        return {
            json: async () => response.data,
            status: response.status,
            ok: response.status >= 200 && response.status < 300
        };
    } catch (e) {
        if (e.code === 'ECONNABORTED') {
            throw new Error('The operation was aborted');
        }
        throw e;
    }
};
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { initDB, db, readHydratedInventory } = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, ''))
});
const upload = multer({ storage });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.use(basicAuth({
    users: { [process.env.ADMIN_USERNAME || 'admin']: process.env.ADMIN_PASSWORD || 'pokemon123' },
    challenge: true,
    realm: 'Pokemon Inventory'
}));

app.get('/', async (req, res) => {
    try {
        const inventory = await readHydratedInventory();
        const { rows: sales } = await db.query('SELECT * FROM sales ORDER BY id DESC');
        const { rows: shipping } = await db.query('SELECT * FROM shipping_logs ORDER BY id DESC');
        
        // Extract unique persons for filter dropdown
        const persons = [...new Set(sales.map(s => s.person).filter(p => p && p.trim() !== 'Unknown' && p.trim() !== ''))];
        const selectedPerson = req.query.person || 'all';
        
        let activity = [];
        sales.forEach(s => activity.push({ ...s, log_type: 'sale' }));
        shipping.forEach(s => activity.push({ ...s, log_type: 'shipping' }));
        activity.sort((a, b) => {
            const dA = a.date ? new Date(a.date).valueOf() : 0;
            const dB = b.date ? new Date(b.date).valueOf() : 0;
            return (isNaN(dB) ? 0 : dB) - (isNaN(dA) ? 0 : dA);
        });
        
        let range = req.query.range || '30';
        let filteredActivity = activity;
        let filteredSales = sales;
        // Apply Filters
        if (range !== 'all') {
            const rangeDate = new Date();
            rangeDate.setDate(rangeDate.getDate() - parseInt(range));
            filteredActivity = filteredActivity.filter(s => new Date(s.date) >= rangeDate);
            filteredSales = filteredSales.filter(s => new Date(s.date) >= rangeDate);
        }
        if (selectedPerson !== 'all') {
            filteredActivity = filteredActivity.filter(s => s.log_type === 'shipping' || s.person === selectedPerson);
            filteredSales = filteredSales.filter(s => s.person === selectedPerson);
        }
        
        const totalValue = inventory.reduce((sum, item) => sum + ((item.market_price || 0) * item.lots.reduce((q, l) => q + l.qty, 0)), 0);
        const totalShipping = shipping.reduce((sum, s) => sum + (parseFloat(s.cost) || 0), 0);
        
        res.render('dashboard', { inventory, activity: filteredActivity, sales: filteredSales, persons, selectedPerson, range, totalValue, totalShipping, currentPath: '/' });
    } catch(e) { console.error('Dashboard Error:', e); res.send('Error loading dashboard: ' + e.message + '\n' + e.stack); }
});

app.post('/shipping/apply', async (req, res) => {
    const { total_cost, selected_items } = req.body;
    if(!selected_items || selected_items.length === 0 || !total_cost) return res.redirect('/');
    
    try {
        const costFloat = parseFloat(total_cost);
        if(costFloat <= 0) return res.redirect('/');
        
        const itemIds = Array.isArray(selected_items) ? selected_items.map(id => parseInt(id)) : [parseInt(selected_items)];
        
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            let totalQty = 0;
            const latestLots = [];
            for (let itemId of itemIds) {
                const { rows: itemLots } = await client.query('SELECT id, qty FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id DESC LIMIT 1', [itemId]);
                if(itemLots.length > 0) {
                    totalQty += itemLots[0].qty;
                    latestLots.push(itemLots[0].id);
                }
            }
            
            const impacts = [];
            if (totalQty > 0) {
                const addPerUnit = costFloat / totalQty;
                for (let lotId of latestLots) {
                    await client.query('UPDATE lots SET cog = cog + $1 WHERE id = $2', [addPerUnit, lotId]);
                    impacts.push({ lotId, amount: addPerUnit });
                }
            }
            
            await client.query('INSERT INTO shipping_logs (cost, impacts, date) VALUES ($1, $2, $3)', [costFloat, JSON.stringify(impacts), new Date().toISOString()]);
            
            await client.query('COMMIT');
        } catch(err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (e) { console.error('Shipping Cost Error:', e); }
    
    res.redirect('/');
});

let cachedRates = { CAD: 1.35, CNY: 7.20, HKD: 7.80 }; // Fallbacks
let lastRateFetch = 0;

async function getExchangeRates() {
    const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours
    if (Date.now() - lastRateFetch > CACHE_DURATION) {
        try {
            const res = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD');
            const data = await res.json();
            if (data && data.rates && data.rates.CAD) {
                cachedRates.CAD = data.rates.CAD;
                if(data.rates.CNY) cachedRates.CNY = data.rates.CNY;
                if(data.rates.HKD) cachedRates.HKD = data.rates.HKD;
                lastRateFetch = Date.now();
                console.log('Updated exchange rates:', cachedRates);
            }
        } catch (e) {
            console.error('Failed to update exchange rates:', e.message);
        }
    }
    return cachedRates;
}

async function getUsdToCadRate() {
    const rates = await getExchangeRates();
    return rates.CAD;
}

getExchangeRates();

app.get('/api/exchange-rate', async (req, res) => {
    const rates = await getExchangeRates();
    res.json(rates);
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 3) return res.json({ data: [] });
        
        const cleanQ = q.replace(/\[.*?\]|\(.*?\)/g, "").trim();
        
        const rate = await getUsdToCadRate();
        const rawQ = `name:"${cleanQ}"`;
        const urlStr = `https://api.pokemontcg.io/v2/cards?q=${rawQ}&pageSize=25`;
        console.log('EXPRESS TRACE FETCH URL:', urlStr);
        const response = await fetchWithTimeout(urlStr, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000
        });
        const data = await response.json();
        
        if (data.data) {
            data.data = data.data.map(card => {
                if (card.tcgplayer && card.tcgplayer.prices) {
                    for (const grade of Object.keys(card.tcgplayer.prices)) {
                        if (card.tcgplayer.prices[grade].market) {
                            card.tcgplayer.prices[grade].market = parseFloat((card.tcgplayer.prices[grade].market * rate).toFixed(1));
                        }
                    }
                }
                return card;
            });
        }
        res.json(data);
    } catch (err) {
        console.error('Search API Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch cards. Please try again later.' });
    }
});

app.get('/api/search/sealed', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 3) return res.json({ data: [] });
        
        const rate = await getUsdToCadRate();
        const response = await fetchWithTimeout(`https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
        });
        const data = await response.json();
        
        if(data && data.products) {
            const mapped = data.products.slice(0, 10).map(p => {
                const numericPrice = parseFloat((p.price1 || '').replace(/[^0-9.]/g, ''));
                const consoleSlug = (p.consoleName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                const productSlug = (p.productName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                
                return {
                    name: p.productName || 'Unknown',
                    set: { name: p.consoleName || 'Sealed' },
                    images: { small: p.imageUri || '' },
                    tcgplayer: {
                        url: `https://www.pricecharting.com/game/${consoleSlug}/${productSlug}`,
                        prices: numericPrice ? { normal: { market: parseFloat((numericPrice * rate).toFixed(1)) } } : null
                    }
                };
            });
            return res.json({ data: mapped });
        }
        res.json({ data: [] });
    } catch (err) {
        console.error('PriceCharting API Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch sealed products.' });
    }
});

app.get('/inventory', async (req, res) => {
    try {
        const view = req.query.view || 'list';
        res.render('inventory', { view, currentPath: req.path, inventory: await readHydratedInventory() });
    } catch (e) {
        console.error('Inventory View Error:', e);
        res.status(500).send('Error loading inventory.');
    }
});

app.post('/inventory/bulk-shipment', async (req, res) => {
    const { total_shipping, bulk_payload } = req.body;
    if(!bulk_payload) return res.redirect('/inventory');
    
    try {
        const items = JSON.parse(bulk_payload);
        const floatShipping = parseFloat(total_shipping) || 0;
        const totalQty = items.reduce((sum, i) => sum + parseInt(i.qty || 1), 0);
        
        const distributedShipping = totalQty > 0 ? (floatShipping / totalQty) : 0;
        
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            const impacts = [];
            for (let item of items) {
                const { rows } = await client.query('SELECT id FROM inventory WHERE lower(name) = $1 AND set_name = $2', [item.name.toLowerCase(), item.set_name || 'Custom']);
                const existingItem = rows[0];
                
                const finalUnitCog = parseFloat(item.unit_cog || 0) + distributedShipping;
                
                if (existingItem) {
                    const { rows: lr } = await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4) RETURNING id', [existingItem.id, parseInt(item.qty || 1), finalUnitCog, new Date().toISOString()]);
                    if (distributedShipping > 0) impacts.push({ lotId: lr[0].id, amount: distributedShipping });
                } else {
                    const { rows: ir } = await client.query(
                        `INSERT INTO inventory (name, set_name, condition, data_source, image, tcgplayer_url, market_price, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                        [item.name, item.set_name, item.condition, item.data_source, item.image, item.tcgplayer_url, item.market_price, item.category]
                    );
                    const { rows: lr } = await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4) RETURNING id', [ir[0].id, parseInt(item.qty || 1), finalUnitCog, new Date().toISOString()]);
                    if (distributedShipping > 0) impacts.push({ lotId: lr[0].id, amount: distributedShipping });
                }
            }
            
            if (floatShipping > 0) {
               await client.query('INSERT INTO shipping_logs (cost, impacts, date) VALUES ($1, $2, $3)', [floatShipping, JSON.stringify(impacts), new Date().toISOString()]);
            }
            
            await client.query('COMMIT');
        } catch(err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch(e) {
        console.error('Bulk Shipment Error:', e);
    }
    
    res.redirect('/inventory');
});

app.post('/inventory/add', upload.single('image_upload'), async (req, res) => {
    const { name, condition, qty, cog, shipping_cost, image_url, data_source, set_name, tcgplayer_url, market_price } = req.body;
    if(!name || !qty) return res.redirect('/inventory');
    
    let finalImageUrl = image_url;
    if (req.file) finalImageUrl = '/uploads/' + req.file.filename;
    
    let parsedMarketPrice = parseFloat(market_price);
    if(isNaN(parsedMarketPrice)) parsedMarketPrice = null;

    try {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query('SELECT id FROM inventory WHERE lower(name) = $1 AND set_name = $2 FOR UPDATE', [name.toLowerCase(), set_name || 'Custom']);
            const existingItem = rows[0];
            const insertLotQ = 'INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)';
            
            let unitCog = parseFloat(cog) || 0;
            const parseShipping = parseFloat(shipping_cost) || 0;
            if (parseShipping > 0) {
                unitCog += (parseShipping / parseInt(qty));
            }

            if (existingItem) {
                await client.query(insertLotQ, [existingItem.id, parseInt(qty), unitCog, new Date().toISOString()]);
                
                let updates = [];
                let params = [];
                let idx = 1;
                if(finalImageUrl) { updates.push(`image = $${idx++}`); params.push(finalImageUrl); }
                if(data_source) { updates.push(`data_source = $${idx++}`); params.push(data_source); }
                if(tcgplayer_url) { updates.push(`tcgplayer_url = $${idx++}`); params.push(tcgplayer_url); }
                if(parsedMarketPrice !== null) { updates.push(`market_price = $${idx++}`); params.push(parsedMarketPrice); }
                if(req.body.category) { updates.push(`category = $${idx++}`); params.push(req.body.category); }
                
                if (updates.length > 0) {
                    params.push(existingItem.id);
                    await client.query(`UPDATE inventory SET ${updates.join(', ')} WHERE id = $${idx}`, params);
                }
            } else {
                const { rows: ir } = await client.query(
                    `INSERT INTO inventory (name, set_name, condition, data_source, image, tcgplayer_url, market_price, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                    [name, set_name || 'Custom', condition, data_source || 'manual', finalImageUrl || '', tcgplayer_url || '', parsedMarketPrice, req.body.category || 'Singles']
                );
                await client.query(insertLotQ, [ir[0].id, parseInt(qty), unitCog, new Date().toISOString()]);
            }
            await client.query('COMMIT');
        } catch(e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch(e) { console.error('Add Inventory Error:', e); }
    
    res.redirect('/inventory');
});

// Helper for background sync without overwriting price
async function triggerBackgroundTcgplayerSync(rows) {
    for (const row of rows) {
        try {
            const rawName = row['Product Name'] || row['name'] || 'Unknown';
            const rawSet = row['Set'] || row['set_name'] || '';
            const category = row['Category'] || row['category'] || 'Singles';
            
            if (category !== 'Singles' && category !== 'Pokemon') continue; // only do this for cards
            
            const cleanName = rawName.replace(/\[.*?\]|\(.*?\)/g, "").trim();
            const cleanSet = rawSet.replace(/\[.*?\]|\(.*?\)/g, "").trim();
            
            const { rows: existing } = await db.query('SELECT id, image, tcgplayer_url FROM inventory WHERE lower(name) = $1 AND set_name = $2', [rawName.toLowerCase(), rawSet || 'Custom']);
            if (existing.length > 0) {
                const item = existing[0];
                if (!item.image || !item.tcgplayer_url) {
                    let foundImg = '';
                    let foundUrl = '';
                    let foundSource = '';
                    
                    // Attempt 1: TCGPlayer Exact
                    const qExact = `name:"${cleanName}"${cleanSet && cleanSet !== 'Custom' && cleanSet !== 'Unknown' ? ` set.name:"*${cleanSet}*"` : ''}`;
                    let tcgUrl1 = `https://api.pokemontcg.io/v2/cards?q=${qExact}&pageSize=1`;
                    
                    try {
                        let res = await fetchWithTimeout(tcgUrl1, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        let data = await res.json();
                        if (data && data.data && data.data.length > 0) {
                            foundImg = data.data[0].images?.small || '';
                            foundUrl = data.data[0].tcgplayer?.url || '';
                            foundSource = 'tcgplayer';
                        }
                    } catch(e) {}
                    
                    // Attempt 2: TCGPlayer Fuzzy Name Only
                    if (!foundImg) {
                        try {
                            const firstWord = cleanName.split(' ')[0].replace(/[^a-zA-Z0-9]/g, '');
                            const qFuzzy = `name:"${firstWord}"`;
                            let tcgUrl2 = `https://api.pokemontcg.io/v2/cards?q=${qFuzzy}&pageSize=25`;
                            let res2 = await fetchWithTimeout(tcgUrl2, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                            let data2 = await res2.json();
                            if (data2 && data2.data && data2.data.length > 0) {
                                // Find best match manually by checking if the name is contained
                                const match = data2.data.find(c => c.name.toLowerCase().includes(cleanName.toLowerCase())) || data2.data[0];
                                foundImg = match.images?.small || '';
                                foundUrl = match.tcgplayer?.url || '';
                                foundSource = 'tcgplayer';
                            }
                        } catch(e) {}
                    }
                    
                    // Attempt 3: PriceCharting Fallback
                    if (!foundImg && cleanName && cleanName !== 'Unknown') {
                        try {
                            let pcUrl = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(cleanName + ' ' + cleanSet)}&type=prices`;
                            let res3 = await fetchWithTimeout(pcUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
                            let data3 = await res3.json();
                            if (data3 && data3.products && data3.products.length > 0) {
                                foundImg = data3.products[0].imageUri || '';
                                foundUrl = `https://www.pricecharting.com/game/${(data3.products[0].consoleName||'').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${(data3.products[0].productName||'').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
                                foundSource = 'pricecharting';
                            }
                        } catch(e) {}
                    }
                    
                    if (foundImg) {
                        await db.query('UPDATE inventory SET image = $1, tcgplayer_url = $2, data_source = $3 WHERE id = $4', [foundImg, foundUrl, foundSource, item.id]);
                        console.log('Successfully found image for', cleanName, 'via', foundSource);
                    } else {
                        console.log('WARNING: Fully failed to find image for', cleanName);
                    }
                    await new Promise(r => setTimeout(r, 1500)); // sleep 1.5s between full fetches
                }
            }
        } catch(e) {
            console.error('Background sync failed for', row['Product Name'], e.message);
        }
    }
}

app.post('/inventory/edit', upload.single('edit_image_upload'), async (req, res) => {
    try {
        let { item_id, name, set_name, condition, category, market_price, qty, avg_cog, image_url, tcgplayer_url } = req.body;
        
        let parsedMarketPrice = parseFloat(market_price) || null;
        let targetQty = parseInt(qty) || 0;
        let parsedCog = parseFloat(avg_cog);
        
        let finalImageUrl = image_url;
        if (req.file) finalImageUrl = '/uploads/' + req.file.filename;

        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            // 1. Update Inventory Details
            let updateQuery = `UPDATE inventory SET name = $1, set_name = $2, condition = $3, category = $4, market_price = $5`;
            let queryParams = [name, set_name, condition, category, parsedMarketPrice];
            let pIdx = 6;
            
            let extraUpdates = [];
            if (finalImageUrl) { extraUpdates.push(`image = $${pIdx++}`); queryParams.push(finalImageUrl); }
            if (tcgplayer_url) { extraUpdates.push(`tcgplayer_url = $${pIdx++}`); queryParams.push(tcgplayer_url); }
            
            if (extraUpdates.length > 0) {
                updateQuery += `, ${extraUpdates.join(', ')}`;
            }
            updateQuery += ` WHERE id = $${pIdx}`;
            queryParams.push(item_id);
            
            await client.query(updateQuery, queryParams);
            
            if (!isNaN(parsedCog)) {
                await client.query('UPDATE lots SET cog = $1 WHERE inventory_id = $2', [parsedCog, item_id]);
            }
            
            // 2. Quantity Reconciliation
            const { rows: lots } = await client.query('SELECT id, qty FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id ASC', [item_id]);
            let currentQty = lots.reduce((sum, l) => sum + l.qty, 0);
            
            if (targetQty > currentQty) {
                let diff = targetQty - currentQty;
                await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', 
                                  [item_id, diff, !isNaN(parsedCog) ? parsedCog : 0.0, new Date().toISOString()]);
            } else if (targetQty < currentQty) {
                let diffToRemove = currentQty - targetQty;
                for (let i = 0; i < lots.length && diffToRemove > 0; i++) {
                    let lot = lots[i];
                    if (lot.qty <= diffToRemove) {
                        await client.query('UPDATE lots SET qty = 0 WHERE id = $1', [lot.id]);
                        diffToRemove -= lot.qty;
                    } else {
                        await client.query('UPDATE lots SET qty = qty - $1 WHERE id = $2', [diffToRemove, lot.id]);
                        diffToRemove = 0;
                    }
                }
            }
            
            await client.query('COMMIT');
        } catch(e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        
        res.redirect('/inventory');
    } catch(e) {
        console.error('Edit Inventory Error:', e);
        res.redirect('/inventory?error=operation_invalid');
    }
});

app.post('/inventory/import-csv', upload.single('csv_file'), async (req, res) => {
    if (!req.file) return res.redirect('/inventory');
    
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            fs.unlinkSync(req.file.path); // clean up
            
            try {
                const client = await db.connect();
                try {
                    await client.query('BEGIN');
                    for (const row of results) {
                        // find correct market price using dynamic key
                        let marketPriceKey = Object.keys(row).find(k => k.toLowerCase().includes('market price'));
                        let rawMarketPrice = marketPriceKey ? row[marketPriceKey] : null;
                        if (row['Price Override'] && parseFloat(row['Price Override']) > 0) {
                            rawMarketPrice = row['Price Override'];
                        }
                        const parsedMarketPrice = parseFloat(rawMarketPrice) || null;
                        
                        const name = row['Product Name'] || row['name'] || 'Unknown';
                        const setName = row['Set'] || row['set_name'] || 'Custom';
                        
                        // Treat the product condition properly
                        let condition = row['Card Condition'] || row['condition'] || 'Near Mint';
                        if (!['Near Mint', 'Lightly Played', 'Sealed'].includes(condition)) {
                            condition = 'Near Mint';
                        }
                        
                        const category = row['Category'] || row['category'] || 'Singles';
                        const qty = parseInt(row['Quantity'] || row['qty'] || 1);
                        const cog = parseFloat(row['Average Cost Paid'] || row['cog'] || 0);
                        
                        // Check if exists
                        const { rows } = await client.query('SELECT id, market_price FROM inventory WHERE lower(name) = $1 AND set_name = $2 FOR UPDATE', [name.toLowerCase(), setName]);
                        let item_id;
                        
                        if (rows.length > 0) {
                            item_id = rows[0].id;
                            // Optionally update market price to CSV overrides if explicitly defined
                            if (parsedMarketPrice !== null) {
                                await client.query('UPDATE inventory SET market_price = $1 WHERE id = $2', [parsedMarketPrice, item_id]);
                            }
                        } else {
                            const { rows: ir } = await client.query(
                                `INSERT INTO inventory (name, set_name, condition, data_source, market_price, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                                [name, setName, condition, 'manual', parsedMarketPrice, category]
                            );
                            item_id = ir[0].id;
                        }
                        
                        if (qty > 0) {
                            await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', [item_id, qty, cog, new Date().toISOString()]);
                        }
                    }
                    await client.query('COMMIT');
                } catch(e) {
                    await client.query('ROLLBACK');
                    console.error('CSV Import Error in DB:', e.message);
                } finally {
                    client.release();
                }
                
                // Trigger background task to populate TCGPlayer links/images asynchronously
                triggerBackgroundTcgplayerSync(results);
                
            } catch(e) {
                console.error('CSV Import Overall Error:', e);
            }
            res.redirect('/inventory');
        });
});

app.post('/sales/add', upload.single('sale_image'), async (req, res) => {
    const { item_id, qty, price, shipping_cost, person, person_override } = req.body;
    if(!item_id || !qty) return res.redirect('/');
    
    let finalPerson = person === 'Other' ? (person_override || 'Unknown') : (person || 'Unknown');
    let saleImage = req.file ? '/uploads/' + req.file.filename : null;
    
    try {
        const { rows: items } = await db.query('SELECT * FROM inventory WHERE id = $1', [item_id]);
        const item = items[0];
        if (!item) return res.redirect('/');
        
        let remainingToSell = parseInt(qty);
        let totalCogsDepleted = 0;
        const { rows: lots } = await db.query('SELECT * FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id ASC', [item_id]);
        
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            for (let lot of lots) {
                if (lot.qty >= remainingToSell) {
                    totalCogsDepleted += remainingToSell * parseFloat(lot.cog || 0);
                    await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [lot.qty - remainingToSell, lot.id]);
                    remainingToSell = 0; break;
                } else {
                    totalCogsDepleted += lot.qty * parseFloat(lot.cog || 0);
                    remainingToSell -= lot.qty;
                    await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [0, lot.id]);
                }
            }
            
            if (parseInt(qty) - remainingToSell > 0) {
                const netPrice = (parseFloat(price) || 0) - (parseFloat(shipping_cost) || 0);
                await client.query('INSERT INTO sales (item_id, item_name, qty, total_price, type, date, person, cogs_sold, image) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
                    item.id, item.name, parseInt(qty) - remainingToSell, netPrice, 'Sale', new Date().toISOString(), finalPerson, totalCogsDepleted, saleImage
                ]);
            }
            await client.query('COMMIT');
        } catch(e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch(e) { console.error('Sale Add Error:', e); }
    
    res.redirect('/');
});

app.post('/sales/bulk-add', upload.single('sale_image'), async (req, res) => {
    let { item_id, qty, price, shipping_cost, person, person_override } = req.body;
    
    // Normalize arrays
    const givenIds = [].concat(item_id || []).filter(id => id);
    const givenQtys = [].concat(qty || []).map(q => parseInt(q) || 1);
    
    if (givenIds.length === 0) return res.redirect('/');
    
    let finalPerson = person === 'Other' ? (person_override || 'Unknown') : (person || 'Unknown');
    let saleImage = req.file ? '/uploads/' + req.file.filename : null;
    let netPrice = (parseFloat(price) || 0) - (parseFloat(shipping_cost) || 0);
    
    try {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            let totalCogsDepleted = 0;
            let givenLogNames = [];
            let totalRemainingSold = 0;
            
            for(let i = 0; i < givenIds.length; i++) {
                const id = givenIds[i];
                let remainingToSell = givenQtys[i];
                if (remainingToSell <= 0) continue;
                
                totalRemainingSold += remainingToSell;
                
                const { rows: items } = await client.query('SELECT name FROM inventory WHERE id = $1', [id]);
                if(items.length > 0) givenLogNames.push(items[0].name);
                
                const { rows: lots } = await client.query('SELECT * FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id ASC', [id]);
                
                for (let lot of lots) {
                    if (remainingToSell <= 0) break;
                    if (lot.qty >= remainingToSell) {
                        totalCogsDepleted += remainingToSell * parseFloat(lot.cog || 0);
                        await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [lot.qty - remainingToSell, lot.id]);
                        remainingToSell = 0; 
                    } else {
                        totalCogsDepleted += lot.qty * parseFloat(lot.cog || 0);
                        remainingToSell -= lot.qty;
                        await client.query('UPDATE lots SET qty = 0 WHERE id = $1', [lot.id]);
                    }
                }
            }
            
            if (totalRemainingSold > 0) {
                let saleDesc = givenLogNames.length > 3 ? `Multi Sale: ${givenLogNames.slice(0, 3).join(', ')} and ${givenLogNames.length - 3} more` : `Multi Sale: ${givenLogNames.join(', ')}`;
                if (givenLogNames.length === 1) saleDesc = givenLogNames[0]; // fallback
                
                await client.query('INSERT INTO sales (item_id, item_name, qty, total_price, type, date, person, cogs_sold, image) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
                    givenIds[0] || null, saleDesc, totalRemainingSold, netPrice, 'Sale', new Date().toISOString(), finalPerson, totalCogsDepleted, saleImage
                ]);
            }

            await client.query('COMMIT');
        } catch(e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch(e) { console.error('Bulk Sale Add Error:', e); }
    
    res.redirect('/');
});

app.post('/shipping/undo', async (req, res) => {
    const { shipping_id } = req.body;
    if(!shipping_id) return res.redirect('/');
    
    try {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            const { rows } = await client.query('SELECT * FROM shipping_logs WHERE id = $1', [shipping_id]);
            const log = rows[0];
            
            if (log && log.impacts) {
                const impacts = JSON.parse(log.impacts);
                for(let imp of impacts) {
                    await client.query('UPDATE lots SET cog = cog - $1 WHERE id = $2', [imp.amount, imp.lotId]);
                }
                await client.query('DELETE FROM shipping_logs WHERE id = $1', [shipping_id]);
            }
            
            await client.query('COMMIT');
        } catch(err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch(e) { console.error('Undo Shipping Error:', e); }
    
    res.redirect('/');
});

app.post('/trade/add', async (req, res) => {
    let { 
        giving_item_id, giving_qty, giving_price_override, 
        receiving_name, receiving_qty, receiving_price, receiving_set, receiving_image, receiving_tcgplayer,
        cash_given, cash_received, person
    } = req.body;
    
    // Normalize arrays
    const givenIds = [].concat(giving_item_id || []).filter(id => id);
    const givenQtys = [].concat(giving_qty || []).map(q => parseInt(q) || 1);
    const givenPrices = [].concat(giving_price_override || []).map(p => parseFloat(p) || 0);
    
    const recNames = [].concat(receiving_name || []).filter(n => n.trim().length > 0);
    const recQtys = [].concat(receiving_qty || []).map(q => parseInt(q) || 1);
    const recPrices = [].concat(receiving_price || []).map(p => parseFloat(p) || 0);
    const recSets = [].concat(receiving_set || []);
    const recImages = [].concat(receiving_image || []);
    const recTcgplayers = [].concat(receiving_tcgplayer || []);
    
    const cashGov = parseFloat(cash_given || 0);
    const cashRec = parseFloat(cash_received || 0);
    
    try {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            let totalCogsDepleted = 0;
            let givenLogNames = [];
            
            // 1. Deduct all given items
            for(let i = 0; i < givenIds.length; i++) {
                const id = givenIds[i];
                let remainingToSell = givenQtys[i];
                
                const { rows: items } = await client.query('SELECT name FROM inventory WHERE id = $1', [id]);
                if(items.length > 0) givenLogNames.push(items[0].name);
                
                const { rows: lots } = await client.query('SELECT * FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id ASC', [id]);
                
                for (let lot of lots) {
                    if (remainingToSell <= 0) break;
                    if (lot.qty >= remainingToSell) {
                        totalCogsDepleted += remainingToSell * parseFloat(lot.cog || 0);
                        await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [lot.qty - remainingToSell, lot.id]);
                        remainingToSell = 0; 
                    } else {
                        totalCogsDepleted += lot.qty * parseFloat(lot.cog || 0);
                        remainingToSell -= lot.qty;
                        await client.query('UPDATE lots SET qty = 0 WHERE id = $1', [lot.id]);
                    }
                }
            }
            
            // 2. Math & Distributions
            const totalCogsGiven = totalCogsDepleted + cashGov;
            const costBasisForNewCards = totalCogsGiven - cashRec;
            let totalRecMarketVal = 0;
            
            for(let i = 0; i < recNames.length; i++) {
                totalRecMarketVal += recPrices[i] * recQtys[i];
            }
            
            // Zero profit math:
            let tradeCogsSold = totalCogsGiven;
            let tradeTotalPrice = 0;
            
            if (recNames.length > 0) {
                if (costBasisForNewCards >= 0) {
                    tradeTotalPrice = totalCogsGiven; // Profit = 0
                } else {
                    tradeTotalPrice = cashRec; // pure cash profit
                }
                
                let recLogNames = [];
                for(let i = 0; i < recNames.length; i++) {
                    const rName = recNames[i];
                    const rQty = recQtys[i];
                    const rPrice = recPrices[i];
                    recLogNames.push(rName);
                    
                    let unitCog = 0;
                    if (costBasisForNewCards > 0) {
                        const ratio = totalRecMarketVal > 0 ? ((rPrice * rQty) / totalRecMarketVal) : (1 / recNames.length);
                        unitCog = (costBasisForNewCards * ratio) / rQty;
                    }
                    
                    const rSet = recSets[i] || 'Custom';
                    const { rows: exs } = await client.query('SELECT id FROM inventory WHERE lower(name) = $1 AND set_name = $2', [rName.toLowerCase(), rSet]);
                    let recId = exs[0] ? exs[0].id : null;
                    
                    if (!recId) {
                        const { rows: newI } = await client.query(`INSERT INTO inventory (name, set_name, condition, data_source, image, tcgplayer_url, market_price, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [
                            rName, rSet, 'Near Mint', 'tcgplayer', recImages[i] || '', recTcgplayers[i] || '', rPrice, 'Singles'
                        ]);
                        recId = newI[0].id;
                    }
                    
                    await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', [recId, rQty, Math.max(0, unitCog), new Date().toISOString()]);
                }
                
                const saleDesc = (givenLogNames.length > 1 ? `Multi (${givenLogNames.length})` : (givenLogNames[0] || 'Cash')) + ` ➔ ` + (recLogNames.length > 1 ? `Multi (${recLogNames.length})` : (recLogNames[0] || 'Unknown'));
                
                await client.query('INSERT INTO sales (item_id, item_name, qty, total_price, type, date, person, cogs_sold) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
                    givenIds[0] || null, saleDesc, givenQtys.reduce((a,b)=>a+b, 0) || 1, tradeTotalPrice, 'Trade', new Date().toISOString(), person || 'Unknown', tradeCogsSold
                ]);
            } else {
                tradeTotalPrice = cashRec;
                const saleDesc = (givenLogNames.length > 1 ? `Multi (${givenLogNames.length})` : (givenLogNames[0] || 'Unknown')) + ` ➔ Cash`;
                await client.query('INSERT INTO sales (item_id, item_name, qty, total_price, type, date, person, cogs_sold) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
                    givenIds[0] || null, saleDesc, givenQtys.reduce((a,b)=>a+b, 0) || 1, tradeTotalPrice, 'Trade', new Date().toISOString(), person || 'Unknown', tradeCogsSold
                ]);
            }

            await client.query('COMMIT');
        } catch(e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch(e) { console.error('Trade Add Error:', e); }
    res.redirect('/');
});

app.post('/sales/refund', async (req, res) => {
    try {
        const { sale_id } = req.body;
        const { rows: sales } = await db.query('SELECT * FROM sales WHERE id = $1', [sale_id]);
        const sale = sales[0];
        if (!sale) return res.redirect('/');
        
        if (sale.type === 'Sale' || sale.type === 'Trade') {
            const { rows: items } = await db.query('SELECT id FROM inventory WHERE id = $1', [sale.item_id]);
            const item = items[0];
            if (item) {
                const cogToRestore = (sale.qty && sale.qty > 0) ? (sale.cogs_sold / sale.qty) : 0;
                await db.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', [
                    item.id, sale.qty, cogToRestore, new Date().toISOString()
                ]);
            }
        }
        await db.query('DELETE FROM sales WHERE id = $1', [sale_id]);
    } catch(e) { console.error('Refund Error:', e); }
    res.redirect('/');
});

app.post('/api/sync-prices', async (req, res) => {
    // Fire and forget simple sync implementation to iterate item by item safely
    res.redirect('/?syncing=true');
    try {
        const { rows: items } = await db.query("SELECT id, name, set_name, data_source FROM inventory WHERE data_source IN ('tcgplayer', 'pricecharting')");
        const rate = await getUsdToCadRate();
        
        for (let item of items) {
            try {
                if (item.data_source === 'pricecharting') {
                    const response = await fetchWithTimeout(`https://www.pricecharting.com/search-products?q=${encodeURIComponent(item.name)}&type=prices`, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
                    });
                    const data = await response.json();
                    if (data && data.products && data.products.length > 0) {
                        const match = data.products.find(p => p.productName.toLowerCase() === item.name.toLowerCase()) || data.products[0];
                        const num = parseFloat((match.price1 || '').replace(/[^0-9.]/g, ''));
                        if (!isNaN(num) && num > 0) {
                            await db.query('UPDATE inventory SET market_price = $1 WHERE id = $2', [parseFloat((num * rate).toFixed(1)), item.id]);
                        }
                    }
                } else if (item.data_source === 'tcgplayer') {
                    const qStr = `name:"${item.name}"${item.set_name && item.set_name !== 'Custom' && item.set_name !== 'Unknown' ? ` set.name:"${item.set_name}"` : ''}`;
                    const urlObj = new URL('https://api.pokemontcg.io/v2/cards');
                    urlObj.searchParams.append('q', qStr);
                    urlObj.searchParams.append('pageSize', '1');
                    const response = await fetchWithTimeout(urlObj.toString(), {
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    const data = await response.json();
                    if (data && data.data && data.data.length > 0) {
                        const card = data.data[0];
                        if (card.tcgplayer && card.tcgplayer.prices) {
                            const p = card.tcgplayer.prices.normal?.market || card.tcgplayer.prices.holofoil?.market || card.tcgplayer.prices.reverseHolofoil?.market;
                            if (p) {
                                await db.query('UPDATE inventory SET market_price = $1 WHERE id = $2', [parseFloat((p * rate).toFixed(1)), item.id]);
                            }
                        }
                    }
                }
            } catch(subE) {
                console.error('Failed syncing price for:', item.name, subE.message);
            }
            await new Promise(r => setTimeout(r, 1000)); // Respect limits (1 req/sec)
        }
    } catch(e) { console.error('Overall Sync Error:', e); }
});

initDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
