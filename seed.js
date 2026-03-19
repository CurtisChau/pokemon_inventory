const { initDB, db } = require('./db');

initDB(); // Run migrations (add category column)

console.log("Seeding mock data for charts...");

const sampleSets = ['Crown Zenith', '151', 'Evolving Skies', 'Scarlet & Violet Base'];
const sampleCats = ['Singles', 'Sealed', 'Graded', 'Accessories'];

for(let i=1; i<=8; i++) {
  try {
    const res = db.prepare('INSERT INTO inventory (name, set_name, condition, market_price, category) VALUES (?, ?, ?, ?, ?)').run(
      `Mock Random Asset #${i}`, 
      sampleSets[Math.floor(Math.random()*sampleSets.length)], 
      'Near Mint', 
      (Math.random()*150 + 5).toFixed(2), 
      sampleCats[Math.floor(Math.random()*sampleCats.length)]
    );
    db.prepare('INSERT INTO lots (inventory_id, qty, cog, date) VALUES (?, ?, ?, ?)').run(res.lastInsertRowid, Math.floor(Math.random()*10)+1, 10.0, new Date().toISOString());
  } catch(e) { console.error('Error inserting item:', e.message); }
}

for(let j=1; j<=45; j++) {
  try {
    const saleDate = new Date();
    // Scatter the sales across the last 90 days smoothly but clustered to the last month!
    saleDate.setDate(saleDate.getDate() - Math.floor(Math.random() * (j < 15 ? 15 : 90)));
    
    db.prepare('INSERT INTO sales (item_id, item_name, qty, total_price, type, date) VALUES (?, ?, ?, ?, ?, ?)').run(
      Math.floor(Math.random()*8)+1, 
      `Sale Bundle ${j}`, 
      Math.floor(Math.random()*5)+1, 
      (Math.random()*180 + 10).toFixed(2), 
      'Sale', 
      saleDate.toISOString()
    );
  } catch(e) { console.error('Error inserting sale:', e.message); }
}

console.log("Mock data successfully seeded!");
