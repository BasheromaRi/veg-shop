const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath);

// إنشاء الجداول
// إنشاء الجداول
db.serialize(() => {
  // جدول المنتجات
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      description TEXT,
      available INTEGER DEFAULT 1,
      unitType TEXT DEFAULT 'kg'    -- kg = كغم  |  bag = كيس
    )
  `);

  // جدول الطلبات
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      country TEXT,
      address TEXT,
      items TEXT,
      status TEXT DEFAULT 'new',
      createdAt TEXT
    )
  `);

  // جدول الحملات والعروض (إذا كنت ضفته)
  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      discountPercent REAL,
      minTotal REAL,
      active INTEGER DEFAULT 1
    )
  `);
});


module.exports = db;
