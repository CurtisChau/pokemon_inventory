require('dotenv').config();
const { db, initDB } = require('./db');

async function wipeDatabase() {
    try {
        console.log('Initiating violent CASCADE drop on all tracking logs...');
        await db.query('DROP TABLE IF EXISTS sales, lots, inventory, shipping_logs CASCADE');
        console.log('Tables explicitly dropped. Sending rewrite arrays directly to Postgres initialization sequence.');
        
        // Wait 1 second to let sockets clear.
        await new Promise(r => setTimeout(r, 1000));
        await initDB();
        
        console.log('System wiped flawlessly. Zero states achieved.');
        process.exit(0);
    } catch(e) {
        console.error('Core dump failure:', e);
        process.exit(1);
    }
}
wipeDatabase();
