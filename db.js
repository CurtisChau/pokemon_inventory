const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/pokemon_inventory';
const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
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
        
        console.log("PostgreSQL Database Initialized!");
    } catch(err) {
        console.error("Error initializing postgres schemas:", err.message);
    }
};

const readHydratedInventory = async () => {
    const { rows: items } = await pool.query('SELECT * FROM inventory ORDER BY name ASC');
    const { rows: lots } = await pool.query('SELECT * FROM lots WHERE qty > 0');
    
    return items.map(item => {
        return {
            ...item,
            set: item.set_name,
            lots: lots.filter(l => l.inventory_id === item.id)
        };
    });
};

module.exports = { db: pool, initDB, readHydratedInventory };
