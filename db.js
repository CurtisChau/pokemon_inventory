const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/pokemon_inventory';
const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inventory (
            id SERIAL PRIMARY KEY,
            name text NOT NULL,
            set_name text DEFAULT 'Custom',
            condition text,
            image text,
            market_price real,
            data_source text,
            tcgplayer_url text,
            category text DEFAULT 'Singles'
            );
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lots (
            id SERIAL PRIMARY KEY,
            inventory_id integer REFERENCES inventory(id),
            qty integer DEFAULT 0,
            cog real DEFAULT 0.0,
            date text
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sales (
            id SERIAL PRIMARY KEY,
            item_id integer REFERENCES inventory(id),
            item_name text NOT NULL,
            qty integer DEFAULT 1,
            total_price real NOT NULL,
            type text DEFAULT 'Sale',
            date text
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS shipping_logs (
            id SERIAL PRIMARY KEY,
            cost real DEFAULT 0.0,
            impacts text,
            date text
            );
        `);
        
        // Add new columns if they don't exist (for migration)
        await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS person text DEFAULT 'Unknown';`).catch(() => {});
        await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cogs_sold real DEFAULT 0.0;`).catch(() => {});
        await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS image text;`).catch(() => {});
        await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS trade_received_data text;`).catch(() => {});
        
        console.log("PostgreSQL Database Initialized!");
    } catch(err) {
        console.error("Error initializing postgres schemas:", err.message);
    }
};

let _inventoryCache = null;
let _inventoryCacheTime = 0;
let _salesCache = null;
let _salesCacheTime = 0;
let _shippingCache = null;
let _shippingCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

const invalidateInventoryCache = () => {
    _inventoryCache = null;
    _salesCache = null;
    _shippingCache = null;
};

const readSales = async () => {
    if (_salesCache && (Date.now() - _salesCacheTime < CACHE_TTL)) return _salesCache;
    const { rows } = await pool.query('SELECT id, item_id, item_name, qty, total_price, type, date, person, cogs_sold, (image IS NOT NULL) AS has_image, trade_received_data FROM sales ORDER BY id DESC');
    // Keep image presence flag but not the data itself
    _salesCache = rows;
    _salesCacheTime = Date.now();
    return rows;
};

const readShipping = async () => {
    if (_shippingCache && (Date.now() - _shippingCacheTime < CACHE_TTL)) return _shippingCache;
    const { rows } = await pool.query('SELECT * FROM shipping_logs ORDER BY id DESC');
    _shippingCache = rows;
    _shippingCacheTime = Date.now();
    return rows;
};

const readHydratedInventory = async () => {
    if (_inventoryCache && (Date.now() - _inventoryCacheTime < CACHE_TTL)) {
        return _inventoryCache;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const { rows: items } = await client.query('SELECT * FROM inventory ORDER BY name ASC');
        const { rows: lots } = await client.query('SELECT * FROM lots WHERE qty > 0');
        await client.query('COMMIT');

        const result = items.map(item => ({
            ...item,
            set: item.set_name,
            lots: lots.filter(l => l.inventory_id === item.id)
        }));
        _inventoryCache = result;
        _inventoryCacheTime = Date.now();
        return result;
    } catch(err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

module.exports = { db: pool, initDB, readHydratedInventory, readSales, readShipping, invalidateInventoryCache };
