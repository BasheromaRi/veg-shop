console.log('SERVER FILE LOADED');

const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

/* ================== PATHS ================== */
const DATA_DIR = process.env.DATA_DIR || '/var/data';
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');

const ADMIN_DIR = path.join(__dirname, 'public', 'admin');
const COURIER_DIR = path.join(__dirname, 'public', 'courier');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'products'), { recursive: true });

/* ================== DB ================== */
const dbPath = path.join(DATA_DIR, 'data.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('DB error', err);
  else console.log('Connected to SQLite DB:', dbPath);
});

function safeJson(s) {
  try {
    if (!s) return [];
    return JSON.parse(s);
  } catch {
    return [];
  }
}

function ensureOrderColumns() {
  db.all(`PRAGMA table_info(orders)`, [], (err, cols) => {
    if (err) {
      console.error('PRAGMA error', err);
      return;
    }

    const names = new Set((cols || []).map((c) => c.name));

    const addCol = (sql) =>
      db.run(sql, (e) => {
        if (e && !String(e.message || '').includes('duplicate column name')) {
          console.error('ALTER error:', e.message);
        }
      });
    if (!names.has('phone2')) {
      addCol(`ALTER TABLE orders ADD COLUMN phone2 TEXT DEFAULT ''`);
    }
    if (!names.has('notes')) {
      addCol(`ALTER TABLE orders ADD COLUMN notes TEXT DEFAULT ''`);
    }
    if (!names.has('assignedToCourier')) {
      addCol(`ALTER TABLE orders ADD COLUMN assignedToCourier INTEGER DEFAULT 0`);
    }
    if (!names.has('cancelReason')) {
      addCol(`ALTER TABLE orders ADD COLUMN cancelReason TEXT DEFAULT ''`);
    }
    if (!names.has('deliveryRegion')) {
      addCol(`ALTER TABLE orders ADD COLUMN deliveryRegion TEXT DEFAULT ''`);
    }
  });
}

function ensureProductColumns() {
  db.all(`PRAGMA table_info(products)`, [], (err, cols) => {
    if (err) {
      console.error('PRAGMA products error', err);
      return;
    }

    const names = new Set((cols || []).map((c) => c.name));

    const addCol = (sql) =>
      db.run(sql, (e) => {
        if (e && !String(e.message || '').includes('duplicate column name')) {
          console.error('ALTER products error:', e.message);
        }
      });

    if (!names.has('onCampaign')) {
  addCol(`ALTER TABLE products ADD COLUMN onCampaign INTEGER DEFAULT 0`);
}

if (!names.has('qtyStep')) {
  addCol(`ALTER TABLE products ADD COLUMN qtyStep INTEGER DEFAULT 1`);
}
  });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT DEFAULT '',
    available INTEGER DEFAULT 1,
    unitType TEXT DEFAULT 'kg',
    onCampaign INTEGER DEFAULT 0,
    qtyStep INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    image TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    phone2 TEXT DEFAULT '',
    country TEXT,
    address TEXT,
    notes TEXT DEFAULT '',
    items TEXT,
    status TEXT DEFAULT 'new',
    assignedToCourier INTEGER DEFAULT 0,
    cancelReason TEXT DEFAULT '',
    deliveryRegion TEXT DEFAULT '',
    createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    discountPercent REAL,
    minTotal REAL,
    active INTEGER DEFAULT 1,
    createdAt TEXT,
    updatedAt TEXT
  )`);

  ensureOrderColumns();
  ensureProductColumns();
  console.log('✅ DB tables ensured + migrations checked');
});

/* ================== USERS ================== */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Q1azP0lm';
const COURIER_PIN = process.env.COURIER_PIN || '7788';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = '795056938';

/* ================== MIDDLEWARE ================== */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.set('trust proxy', 1);

app.use(
  session({
    name: 'vegshop.sid',
    store: new SQLiteStore({
      dir: DATA_DIR,
      db: 'sessions.sqlite',
      table: 'sessions',
    }),
    secret: process.env.SESSION_SECRET || 'veg-shop-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 6,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

function noCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

/* ================== STATIC ================== */
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '30d',
  etag: true,
  lastModified: true
}));

/* ================== AUTH (ADMIN) ================== */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'بيانات خاطئة' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('vegshop.sid');
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin, isCourier: !!req.session.isCourier });
});

/* ================== AUTH (COURIER) ================== */
app.post('/api/courier/login', (req, res) => {
  const { pin } = req.body;
  if (String(pin || '').trim() === String(COURIER_PIN)) {
    req.session.isCourier = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'كود الشليح غلط' });
});

app.post('/api/courier/logout', (req, res) => {
  req.session.isCourier = false;
  req.session.save(() => res.json({ success: true }));
});

/* ================== GUARDS ================== */
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.redirect('/login.html');
}

function requireCourier(req, res, next) {
  if (req.session?.isCourier) return next();
  return res.redirect('/courier-login');
}

/* ================== ADMIN PAGES ================== */
app.use('/admin', noCache, requireAdmin);

app.get('/admin/secret-admin-9347', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'secret-admin-9347.html'));
});
app.get('/admin/manage-products', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'manage-products.html'));
});
app.get('/admin/orders', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'orders.html'));
});
app.get('/admin/campaigns', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'campaigns.html'));
});
app.get('/admin/product-totals', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'product-totals.html'));
});

/* ================== COURIER PAGES ================== */
app.get('/courier-login', noCache, (req, res) => {
  res.sendFile(path.join(COURIER_DIR, 'courier-login.html'));
});

app.get('/courier', noCache, requireCourier, (req, res) => {
  res.sendFile(path.join(COURIER_DIR, 'courier.html'));
});

/* ================== API GUARD ================== */
function apiGuard(req, res, next) {
  if (req.path.startsWith('/uploads')) return next();

  if (req.method === 'GET' && req.path === '/products') return next();
  if (req.method === 'POST' && req.path === '/orders') return next();
  if (req.method === 'GET' && req.path === '/campaigns/active') return next();

  if (req.method === 'POST' && req.path === '/login') return next();
  if (req.method === 'POST' && req.path === '/logout') return next();
  if (req.method === 'GET' && req.path === '/me') return next();

  if (req.method === 'POST' && req.path === '/courier/login') return next();
  if (req.method === 'POST' && req.path === '/courier/logout') return next();

  if (req.session?.isAdmin) return next();
  if (req.session?.isCourier && req.path.startsWith('/courier/')) return next();

  return res.status(401).json({ error: 'غير مصرح' });
}
app.use('/api', apiGuard);

/* ================== MULTER ================== */
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('الملف لازم يكون صورة'));
    }
    cb(null, true);
  }
});

/* ================== PRODUCTS ================== */
app.get('/api/products', (req, res) => {
  db.all('SELECT * FROM products ORDER BY id DESC', [], (err, products) => {
    if (err) return res.status(500).json({ error: 'DB error' });

    db.all('SELECT * FROM product_images', [], (err2, images) => {
      if (err2) return res.status(500).json({ error: 'DB error' });

      const map = {};
      images.forEach((img) => {
        if (!map[img.product_id]) map[img.product_id] = [];
        map[img.product_id].push(`/uploads/products/${img.product_id}/${img.image}`);
      });

      res.json(products.map((p) => ({ ...p, images: map[p.id] || [] })));
    });
  });
});

app.post('/api/products', (req, res) => {
  const { name, price, description, available, unitType, onCampaign, qtyStep } = req.body;

  db.run(
    `INSERT INTO products (name, price, description, available, unitType, onCampaign, qtyStep)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      price,
      description || '',
      available ? 1 : 0,
      unitType || 'kg',
      onCampaign ? 1 : 0,
      Number(qtyStep) || 1
    ],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, productId: this.lastID });
    }
  );
});

app.put('/api/products/:id', (req, res) => {
  const { name, price, description, available, unitType, onCampaign, qtyStep } = req.body;

  db.run(
   `UPDATE products
 SET name = ?, price = ?, description = ?, available = ?, unitType = ?, onCampaign = ?, qtyStep = ?
 WHERE id = ?`,
[
  name,
  price,
  description || '',
  available ? 1 : 0,
  unitType || 'kg',
  onCampaign ? 1 : 0,
  Number(qtyStep) || 1,
  req.params.id
],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, changes: this.changes });
    }
  );
});

app.delete('/api/products/:id', (req, res) => {
  const id = req.params.id;

  db.all('SELECT image FROM product_images WHERE product_id = ?', [id], (err, rows) => {
    if (!err && rows?.length) {
      rows.forEach((r) => {
        const filePath = path.join(UPLOADS_DIR, 'products', id, r.image);
        try { fs.existsSync(filePath) && fs.unlinkSync(filePath); } catch (e) {}
      });
    }

    db.run('DELETE FROM product_images WHERE product_id = ?', [id], (err2) => {
      if (err2) return res.status(500).json({ error: 'DB error' });

      db.run('DELETE FROM products WHERE id = ?', [id], function (err3) {
        if (err3) return res.status(500).json({ error: 'DB error' });

        const dir = path.join(UPLOADS_DIR, 'products', id);
        try { fs.existsSync(dir) && fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

        res.json({ success: true, changes: this.changes });
      });
    });
  });
});

app.post('/api/products/:id/images', upload.array('images', 10), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'لا توجد صور' });

    const dir = path.join(UPLOADS_DIR, 'products', req.params.id);
    fs.mkdirSync(dir, { recursive: true });

    const stmt = db.prepare('INSERT INTO product_images (product_id, image) VALUES (?, ?)');

    for (const file of req.files) {
      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
      const filePath = path.join(dir, filename);

      await sharp(file.buffer)
        .rotate()
        .resize({
          width: 900,
          height: 700,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({
          quality: 75
        })
        .toFile(filePath);

      stmt.run(req.params.id, filename);
    }

    stmt.finalize();

    res.json({ success: true, files: req.files.length });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'خطأ برفع الصور' });
  }
});
app.delete('/api/products/:id/images', (req, res) => {
  try {
    const productId = req.params.id;
    const imagePath = decodeURIComponent(req.query.image || '');

    if (!imagePath) {
      return res.status(400).json({ error: 'الصورة غير موجودة' });
    }

    const filename = path.basename(imagePath);

    db.run(
      'DELETE FROM product_images WHERE product_id = ? AND image = ?',
      [productId, filename],
      (err) => {
        if (err) return res.status(500).json({ error: 'DB error' });

        const filePath = path.join(UPLOADS_DIR, 'products', productId, filename);

        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          console.error('Delete image file error:', e);
        }

        res.json({ success: true });
      }
    );
  } catch (err) {
    console.error('Delete image error:', err);
    res.status(500).json({ error: 'خطأ بحذف الصورة' });
  }
});
app.delete('/api/products/:id/images', (req, res) => {
  try {
    const productId = req.params.id;
    const imagePath = decodeURIComponent(req.query.image || '');

    if (!imagePath) {
      return res.status(400).json({ error: 'الصورة غير موجودة' });
    }

    const filename = path.basename(imagePath);

    db.run(
      'DELETE FROM product_images WHERE product_id = ? AND image = ?',
      [productId, filename],
      (err) => {
        if (err) return res.status(500).json({ error: 'DB error' });

        const filePath = path.join(UPLOADS_DIR, 'products', productId, filename);

        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          console.error('Delete image file error:', e);
        }

        res.json({ success: true });
      }
    );
  } catch (err) {
    console.error('Delete image error:', err);
    res.status(500).json({ error: 'خطأ بحذف الصورة' });
  }
});
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text
      })
    });

    if (!res.ok) {
      const data = await res.text();
      console.error('Telegram send failed:', data);
    }
  } catch (err) {
    console.error('Telegram error:', err);
  }
}
/* ================== ORDERS ================== */
app.get('/api/orders', (req, res) => {
  db.all('SELECT * FROM orders ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.map((o) => ({ ...o, items: safeJson(o.items) })));
  });
});

app.post('/api/orders', (req, res) => {
  const { items, phone, phone2, country, address, name, notes, deliveryRegion } = req.body;

  const safeItems = Array.isArray(items) ? items : [];

  db.run(
    `INSERT INTO orders (name, phone, phone2, country, address, notes, deliveryRegion, items, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name || '',
      phone || '',
      phone2 || '',
      country || '',
      address || '',
      notes || '',
      deliveryRegion || '',
      JSON.stringify(safeItems),
      'new',
      new Date().toISOString(),
    ],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });

      const orderId = this.lastID;

      const cleanSubtotal = Math.round(
        safeItems.reduce((sum, i) => {
          const price = Number(i.price) || 0;
          const qty = Number(i.qty) || 0;
          return sum + (price * qty);
        }, 0)
      );

      const delivery = cleanSubtotal >= 300 ? 0 : 30;
      const total = Math.round(cleanSubtotal + delivery);

      const itemsText = safeItems.map(i => {
        const unit = i.unitType === 'bag' ? 'كيس' : 'كغم';
        const line = Math.round((Number(i.price) || 0) * (Number(i.qty) || 0));
        return `• ${i.name} — ${i.qty} ${unit} — ₪${line}`;
      }).join('\n');

      const msg = `🆕 طلب جديد #${orderId}

👤 الاسم: ${name || '-'}
📞 الهاتف: ${phone || '-'}
📞 هاتف إضافي: ${phone2 || '-'}
📍 البلد: ${country || '-'}
🗺️ المنطقة: ${deliveryRegion || '-'}
🏠 العنوان: ${address || '-'}
📝 ملاحظات: ${notes || '-'}

🛒 المنتجات:
${itemsText || '-'}

💰 المجموع قبل التوصيل: ₪${cleanSubtotal}
🚚 التوصيل: ${delivery === 0 ? 'مجاني ✅' : '₪30'}
✅ المجموع الكلي: ₪${total}`;

      sendTelegramMessage(msg);

      res.json({ success: true, orderId });
    }
  );
});

app.put('/api/orders/:id/status', (req, res) => {
  const { status, cancelReason } = req.body;

  db.run(
    'UPDATE orders SET status = ?, cancelReason = ? WHERE id = ?',
    [status, status === 'cancelled' ? (cancelReason || '') : '', req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true });
    }
  );
});
app.put('/api/orders/:id/region', (req, res) => {
  const { deliveryRegion } = req.body;

  db.run(
    'UPDATE orders SET deliveryRegion = ? WHERE id = ?',
    [deliveryRegion || '', req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, changes: this.changes });
    }
  );
});
app.put('/api/orders/:id/edit', (req, res) => {
  const id = req.params.id;
  const { name, phone, phone2, country, address, notes, deliveryRegion, items } = req.body;

  const safeItems = Array.isArray(items) ? items : [];

  db.run(
    `UPDATE orders
     SET name = ?, phone = ?, phone2 = ?, country = ?, address = ?, notes = ?, deliveryRegion = ?, items = ?
     WHERE id = ?`,
    [
      name || '',
      phone || '',
      phone2 || '',
      country || '',
      address || '',
      notes || '',
      deliveryRegion || '',
      JSON.stringify(safeItems),
      id
    ],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, changes: this.changes });
    }
  );
});
app.delete('/api/orders/:id', (req, res) => {
  db.run('DELETE FROM orders WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true });
  });
});

/* ================== ADMIN -> Assign to courier ================== */
app.put('/api/orders/:id/assign', (req, res) => {
  const assigned = req.body.assigned ? 1 : 0;
  const id = req.params.id;

  if (assigned) {
    db.run(
      'UPDATE orders SET assignedToCourier = 1, status = ? WHERE id = ?',
      ['out_for_delivery', id],
      function (err) {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true, changes: this.changes });
      }
    );
  } else {
    db.run(
      'UPDATE orders SET assignedToCourier = 0 WHERE id = ?',
      [id],
      function (err) {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true, changes: this.changes });
      }
    );
  }
});

/* ================== REPORTS ================== */
app.get('/api/reports/totals', (req, res) => {
  const status = String(req.query.status || 'all').trim();
  const region = String(req.query.region || 'all').trim();

  let sql = 'SELECT status, deliveryRegion, items FROM orders';
const params = [];
const where = [];

if (status !== 'all') {
  where.push('status = ?');
  params.push(status);
}

if (region !== 'all') {
  const regions = region.split(',').map(r => r.trim()).filter(Boolean);

  if (regions.length === 1) {
    where.push('deliveryRegion = ?');
    params.push(regions[0]);
  } else if (regions.length > 1) {
    where.push(`deliveryRegion IN (${regions.map(() => '?').join(',')})`);
    params.push(...regions);
  }
}

if (where.length) {
  sql += ' WHERE ' + where.join(' AND ');
}

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('reports/totals db error:', err);
      return res.status(500).json({ error: 'DB error' });
    }

    const map = new Map();

    for (const r of (rows || [])) {
      const items = safeJson(r.items);

      for (const it of items) {
        const name = String(it.name || '').trim();
        const unitType = (it.unitType === 'bag') ? 'bag' : 'kg';
        const qty = Number(it.qty || 0);

        if (!name || !qty) continue;

        const key = `${name}||${unitType}`;
        map.set(key, (map.get(key) || 0) + qty);
      }
    }

    const totals = Array.from(map.entries()).map(([key, totalQty]) => {
      const [name, unitType] = key.split('||');
      return { name, unitType, totalQty };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    res.json({ totals });
  });
});

/* ================== CAMPAIGNS ================== */
app.get('/api/campaigns/active', (req, res) => {
  db.all(
    `SELECT id, title, description, discountPercent, minTotal
     FROM campaigns
     WHERE active = 1
     ORDER BY id DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: 'DB error' });
      res.json(rows || []);
    }
  );
});

app.get('/api/campaigns', (req, res) => {
  db.all('SELECT * FROM campaigns ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ success:false, error:'DB error' });
    res.json(rows || []);
  });
});

app.post('/api/campaigns', (req, res) => {
  const { title, description, discountPercent, minTotal, active } = req.body;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ success:false, error:'العنوان مطلوب' });
  }

  const now = new Date().toISOString();

  db.run(
    `INSERT INTO campaigns (title, description, discountPercent, minTotal, active, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      String(title).trim(),
      String(description || ''),
      (discountPercent === '' || discountPercent == null) ? null : Number(discountPercent),
      (minTotal === '' || minTotal == null) ? null : Number(minTotal),
      active ? 1 : 0,
      now,
      now,
    ],
    function (err) {
      if (err) return res.status(500).json({ success:false, error:'DB error' });
      res.json({ success:true, id: this.lastID });
    }
  );
});

app.put('/api/campaigns/:id', (req, res) => {
  const id = req.params.id;
  const { title, description, discountPercent, minTotal, active } = req.body;

  if (!title || !String(title).trim()) {
    return res.status(400).json({ success:false, error:'العنوان مطلوب' });
  }

  const now = new Date().toISOString();

  db.run(
    `UPDATE campaigns
     SET title = ?, description = ?, discountPercent = ?, minTotal = ?, active = ?, updatedAt = ?
     WHERE id = ?`,
    [
      String(title).trim(),
      String(description || ''),
      (discountPercent === '' || discountPercent == null) ? null : Number(discountPercent),
      (minTotal === '' || minTotal == null) ? null : Number(minTotal),
      active ? 1 : 0,
      now,
      id,
    ],
    function (err) {
      if (err) return res.status(500).json({ success:false, error:'DB error' });
      res.json({ success:true, changes: this.changes });
    }
  );
});

app.delete('/api/campaigns/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM campaigns WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ success:false, error:'DB error' });
    res.json({ success:true, changes: this.changes });
  });
});

/* ================== COURIER APIs ================== */
app.get('/api/courier/orders', (req, res) => {
  const status = req.query.status;
  let where = 'WHERE assignedToCourier = 1';
  const params = [];

  if (status && status !== 'all') {
    where += ' AND status = ?';
    params.push(status);
  }

  db.all(`SELECT * FROM orders ${where} ORDER BY id DESC`, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.map((o) => ({ ...o, items: safeJson(o.items) })));
  });
});

app.put('/api/courier/orders/:id/delivered', (req, res) => {
  db.run(
    `UPDATE orders SET status = 'done' WHERE id = ? AND assignedToCourier = 1`,
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, changes: this.changes });
    }
  );
});

app.put('/api/courier/orders/:id/cancel', (req, res) => {
  const reason = String(req.body.reason || '').trim();
  db.run(
    `UPDATE orders SET status = 'cancelled', cancelReason = ? WHERE id = ? AND assignedToCourier = 1`,
    [reason, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, changes: this.changes });
    }
  );
});

/* ================== START ================== */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
