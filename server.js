const express = require('express');
const axios = require('axios');
const multer = require('multer');
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

initDB().catch(console.error);

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
        const { rows: shipping } = await db.query('SELECT SUM(cost) as total FROM shipping_logs');
        
        let range = req.query.range || '30';
        let filteredSales = sales;
        if (range !== 'all') {
            const rangeDate = new Date();
            rangeDate.setDate(rangeDate.getDate() - parseInt(range));
            filteredSales = sales.filter(s => new Date(s.date) >= rangeDate);
        }
        
        const totalValue = inventory.reduce((sum, item) => sum + ((item.market_price || 0) * item.lots.reduce((q, l) => q + l.qty, 0)), 0);
        const totalShipping = shipping.length ? (parseFloat(shipping[0].total) || 0) : 0;
        
        res.render('dashboard', { inventory, sales: filteredSales, range, totalValue, totalShipping, currentPath: '/' });
    } catch(e) { console.error('Dashboard Error:', e); res.send('Error loading dashboard'); }
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
            
            await client.query('INSERT INTO shipping_logs (cost, date) VALUES ($1, $2)', [costFloat, new Date().toISOString()]);
            
            let totalQty = 0;
            const latestLots = [];
            for (let itemId of itemIds) {
                const { rows: itemLots } = await client.query('SELECT id, qty FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id DESC LIMIT 1', [itemId]);
                if(itemLots.length > 0) {
                    totalQty += itemLots[0].qty;
                    latestLots.push(itemLots[0].id);
                }
            }
            
            if (totalQty > 0) {
                const addPerUnit = costFloat / totalQty;
                for (let lotId of latestLots) {
                    await client.query('UPDATE lots SET cog = cog + $1 WHERE id = $2', [addPerUnit, lotId]);
                }
            }
            
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

let cachedExchangeRate = 1.35; // Default fallback CAD rate
let lastRateFetch = 0;

async function getUsdToCadRate() {
    const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours
    if (Date.now() - lastRateFetch > CACHE_DURATION) {
        try {
            const res = await axios.get('https://open.er-api.com/v6/latest/USD');
            if (res.data && res.data.rates && res.data.rates.CAD) {
                cachedExchangeRate = res.data.rates.CAD;
                lastRateFetch = Date.now();
                console.log('Updated USD/CAD rate:', cachedExchangeRate);
            }
        } catch (e) {
            console.error('Failed to update exchange rate:', e.message);
        }
    }
    return cachedExchangeRate;
}

getUsdToCadRate();

app.get('/api/exchange-rate', async (req, res) => {
    const rate = await getUsdToCadRate();
    res.json({ usdToCad: rate });
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 3) return res.json({ data: [] });
        
        const rate = await getUsdToCadRate();
        const response = await axios.get(`https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(q)}*"&pageSize=10`, { timeout: 8000 });
        
        if (response.data.data) {
            response.data.data = response.data.data.map(card => {
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
        res.json(response.data);
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
        const response = await axios.get(`https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 8000
        });
        
        if(response.data && response.data.products) {
            const mapped = response.data.products.slice(0, 10).map(p => {
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
    const view = req.query.view || 'list';
    res.render('inventory', { view, currentPath: req.path, inventory: await readHydratedInventory() });
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
            
            if (floatShipping > 0) {
               await client.query('INSERT INTO shipping_logs (cost, date) VALUES ($1, $2)', [floatShipping, new Date().toISOString()]);
            }
            
            for (let item of items) {
                const { rows } = await client.query('SELECT id FROM inventory WHERE lower(name) = $1 AND set_name = $2', [item.name.toLowerCase(), item.set_name || 'Custom']);
                const existingItem = rows[0];
                
                const finalUnitCog = parseFloat(item.unit_cog || 0) + distributedShipping;
                
                if (existingItem) {
                    await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', [existingItem.id, parseInt(item.qty || 1), finalUnitCog, new Date().toISOString()]);
                } else {
                    const { rows: ir } = await client.query(
                        `INSERT INTO inventory (name, set_name, condition, data_source, image, tcgplayer_url, market_price, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                        [item.name, item.set_name, item.condition, item.data_source, item.image, item.tcgplayer_url, item.market_price, item.category]
                    );
                    await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', [ir[0].id, parseInt(item.qty || 1), finalUnitCog, new Date().toISOString()]);
                }
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
        const { rows } = await db.query('SELECT id FROM inventory WHERE lower(name) = $1 AND set_name = $2', [name.toLowerCase(), set_name || 'Custom']);
        const existingItem = rows[0];
        const insertLotQ = 'INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)';
        
        let unitCog = parseFloat(cog) || 0;
        const parseShipping = parseFloat(shipping_cost) || 0;
        if (parseShipping > 0) {
            unitCog += (parseShipping / parseInt(qty));
        }

        if (existingItem) {
            await db.query(insertLotQ, [existingItem.id, parseInt(qty), unitCog, new Date().toISOString()]);
            
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
                await db.query(`UPDATE inventory SET ${updates.join(', ')} WHERE id = $${idx}`, params);
            }
        } else {
            const { rows: ir } = await db.query(
                `INSERT INTO inventory (name, set_name, condition, data_source, image, tcgplayer_url, market_price, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [name, set_name || 'Custom', condition, data_source || 'manual', finalImageUrl || '', tcgplayer_url || '', parsedMarketPrice, req.body.category || 'Singles']
            );
            await db.query(insertLotQ, [ir[0].id, parseInt(qty), unitCog, new Date().toISOString()]);
        }
    } catch(e) { console.error('Add Inventory Error:', e); }
    
    res.redirect('/inventory');
});

app.post('/sales/add', async (req, res) => {
    const { item_id, qty, price, shipping_cost } = req.body;
    if(!item_id || !qty) return res.redirect('/');
    
    try {
        const { rows: items } = await db.query('SELECT * FROM inventory WHERE id = $1', [item_id]);
        const item = items[0];
        if (!item) return res.redirect('/');
        
        let remainingToSell = parseInt(qty);
        const { rows: lots } = await db.query('SELECT * FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id ASC', [item_id]);
        
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            for (let lot of lots) {
                if (lot.qty >= remainingToSell) {
                    await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [lot.qty - remainingToSell, lot.id]);
                    remainingToSell = 0; break;
                } else {
                    remainingToSell -= lot.qty;
                    await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [0, lot.id]);
                }
            }
            
            if (parseInt(qty) - remainingToSell > 0) {
                const netPrice = (parseFloat(price) || 0) - (parseFloat(shipping_cost) || 0);
                await client.query('INSERT INTO sales (item_id, item_name, qty, total_price, type, date) VALUES ($1, $2, $3, $4, $5, $6)', [
                    item.id, item.name, parseInt(qty) - remainingToSell, netPrice, 'Sale', new Date().toISOString()
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

app.post('/trade/add', async (req, res) => {
    const { 
        giving_item_id, giving_qty, cash_given, 
        receiving_name, receiving_qty, cash_received, 
        receiving_price, receiving_set, receiving_image, receiving_tcgplayer 
    } = req.body;
    
    try {
        const { rows: items } = await db.query('SELECT * FROM inventory WHERE id = $1', [giving_item_id]);
        const item = items[0];
        if (item) {
            let remainingToSell = parseInt(giving_qty || 1);
            const { rows: lots } = await db.query('SELECT * FROM lots WHERE inventory_id = $1 AND qty > 0 ORDER BY id ASC', [item.id]);
            
            const client = await db.connect();
            try {
                await client.query('BEGIN');
                for (let lot of lots) {
                    if (lot.qty >= remainingToSell) {
                        await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [lot.qty - remainingToSell, lot.id]);
                        remainingToSell = 0; break;
                    } else {
                        remainingToSell -= lot.qty;
                        await client.query('UPDATE lots SET qty = $1 WHERE id = $2', [0, lot.id]);
                    }
                }
                
                if (receiving_name) {
                    const { rows: exs } = await client.query('SELECT id FROM inventory WHERE lower(name) = $1 AND set_name = $2', [receiving_name.toLowerCase(), receiving_set || 'Custom']);
                    const existingItem = exs[0];
                    const costBasis = parseFloat(item.market_price || 0) * parseInt(giving_qty || 1) + parseFloat(cash_given || 0) - parseFloat(cash_received || 0);
                    const unitCog = costBasis / parseInt(receiving_qty || 1);
                    
                    let recId = existingItem ? existingItem.id : null;
                    if (!existingItem) {
                        const { rows: newI } = await client.query(`INSERT INTO inventory (name, set_name, condition, data_source, image, tcgplayer_url, market_price, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [
                            receiving_name, receiving_set || 'Custom', 'Near Mint', 'tcgplayer', receiving_image || '', receiving_tcgplayer || '', parseFloat(receiving_price || 0), 'Singles'
                        ]);
                        recId = newI[0].id;
                    }
                    await client.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', [recId, parseInt(receiving_qty || 1), Math.max(0, unitCog), new Date().toISOString()]);
                    
                    const totalVal = parseFloat(receiving_price || 0) * parseInt(receiving_qty || 1) + parseFloat(cash_received || 0);
                    await client.query('INSERT INTO sales (item_id, item_name, qty, total_price, type, date) VALUES ($1, $2, $3, $4, $5, $6)', [
                        item.id, item.name + ` ➔ ${receiving_name}`, parseInt(giving_qty || 1), totalVal, 'Trade', new Date().toISOString()
                    ]);
                }
                await client.query('COMMIT');
            } catch(e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
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
                await db.query('INSERT INTO lots (inventory_id, qty, cog, date) VALUES ($1, $2, $3, $4)', [
                    item.id, sale.qty, 0, new Date().toISOString()
                ]);
            }
        }
        await db.query('DELETE FROM sales WHERE id = $1', [sale_id]);
    } catch(e) { console.error('Refund Error:', e); }
    res.redirect('/');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
