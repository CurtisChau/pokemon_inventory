require('dotenv').config();
const { db, readHydratedInventory } = require('./db');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

async function test() {
    try {
        const inventory = await readHydratedInventory();
        const { rows: sales } = await db.query('SELECT * FROM sales ORDER BY id DESC');
        const { rows: shipping } = await db.query('SELECT * FROM shipping_logs ORDER BY id DESC');
        
        const persons = [...new Set(sales.map(s => s.person).filter(p => p && typeof p === 'string' && p.trim() !== 'Unknown' && p.trim() !== ''))];
        const selectedPerson = 'all';
        
        let activity = [];
        sales.forEach(s => activity.push({ ...s, log_type: 'sale' }));
        shipping.forEach(s => activity.push({ ...s, log_type: 'shipping' }));
        activity.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        let range = '30';
        let filteredActivity = activity;
        let filteredSales = sales;
        
        if (range !== 'all') {
            const rangeDate = new Date();
            rangeDate.setDate(rangeDate.getDate() - parseInt(range));
            filteredActivity = filteredActivity.filter(s => new Date(s.date) >= rangeDate);
            filteredSales = filteredSales.filter(s => new Date(s.date) >= rangeDate);
        }
        
        const totalValue = inventory.reduce((sum, item) => sum + ((item.market_price || 0) * item.lots.reduce((q, l) => q + l.qty, 0)), 0);
        const totalShipping = shipping.reduce((sum, s) => sum + (parseFloat(s.cost) || 0), 0);
        
        const template = fs.readFileSync(path.join(__dirname, 'views/dashboard.ejs'), 'utf-8');
        const html = ejs.render(template, { 
            inventory, activity: filteredActivity, sales: filteredSales, 
            persons, selectedPerson, range, totalValue, totalShipping, currentPath: '/' 
        }, { views: [path.join(__dirname, 'views')] });
        
        console.log("Successfully Rendered! Length:", html.length);
    } catch(e) {
        console.error("DEBUG ERROR STACK:");
        console.error(e.stack);
    } finally {
        process.exit();
    }
}
test();
