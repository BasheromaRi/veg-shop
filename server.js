console.log('SERVER FILE LOADED');

const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

/* ================== PATHS ==================
   Render: اربط Disk على /var/data
*/
const DATA_DIR = process.env.DATA_DIR || '/var/data';
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');

// صفحات الإدارة داخل public/admin
const ADMIN_DIR = path.join(__dirname, 'public', 'admin');

// صفحات الشليح داخل public/courier
const COURIER_DIR = path.join(__dirname, 'public', 'courier');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'products'), { recursive: true });

/* ================== DB ================== */
const dbPath = path.join(DATA_DIR, 'data.db');
const db = new sqlite3.Database(dbPath, err => {
  if (err) console.error('DB error', err);
  else console.log('Connected to SQLite DB:', dbPath);
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT DEFAULT '',
    available INTEGER DEFAULT 1,
    unitType TEXT DEFAULT 'kg'
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
  country TEXT,
  address TEXT,
  notes TEXT DEFAULT '',
  items TEXT,
  status TEXT DEFAULT 'new',
  createdAt TEXT
)`);

   db.run(`ALTER TABLE orders ADD COLUMN notes TEXT DEFAULT ''`, () => {});
  // ✅ أعمدة جديدة (إذا مش موجودة رح نتجاهل الخطأ)
  db.run(`ALTER TABLE orders ADD COLUMN assignedToCourier INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN cancelReason TEXT DEFAULT ''`, () => {});

  console.log('✅ DB tables ensured + extra columns');
});

/* ================== USERS ================== */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Q1azP0lm';

// ✅ كود الشليح (غيره من Render ENV)
const COURIER_PIN = process.env.COURIER_PIN || '7788';

/* ================== MIDDLEWARE ================== */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.set('trust proxy', 1);

app.use(session({
  name: 'vegshop.sid',
  store: new SQLiteStore({
    dir: DATA_DIR,
    db: 'sessions.sqlite',
    table: 'sessions'
  }),
  secret: process.env.SESSION_SECRET || 'veg-shop-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 6,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

function noCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

/* ================== STATIC ================== */
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

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
  req.session.save(() => {
    res.json({ success: true });
  });
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

/* ================== ADMIN PAGES (محمية) ================== */
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

  // زبون:
  if (req.method === 'GET' && req.path === '/products') return next();
  if (req.method === 'POST' && req.path === '/orders') return next();

  // admin auth:
  if (req.method === 'POST' && req.path === '/login') return next();
  if (req.method === 'POST' && req.path === '/logout') return next();
  if (req.method === 'GET' && req.path === '/me') return next();

  // courier auth:
  if (req.method === 'POST' && req.path === '/courier/login') return next();
  if (req.method === 'POST' && req.path === '/courier/logout') return next();

  // إدارة:
  if (req.session?.isAdmin) return next();

  // شليح:
  if (req.session?.isCourier && req.path.startsWith('/courier/')) return next();

  return res.status(401).json({ error: 'غير مصرح' });
}
app.use('/api', apiGuard);

/* ================== MULTER ================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, 'products', req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});
const upload = multer({ storage });

/* ================== PRODUCTS ================== */
app.get('/api/products', (req, res) => {
  db.all('SELECT * FROM products ORDER BY id DESC', [], (err, products) => {
    if (err) return res.status(500).json({ error: 'DB error' });

    db.all('SELECT * FROM product_images', [], (err2, images) => {
      if (err2) return res.status(500).json({ error: 'DB error' });

      const map = {};
      images.forEach(img => {
        if (!map[img.product_id]) map[img.product_id] = [];
        map[img.product_id].push(`/uploads/products/${img.product_id}/${img.image}`);
      });

      res.json(products.map(p => ({ ...p, images: map[p.id] || [] })));
    });
  });
});

app.post('/api/products', (req, res) => {
  const { name, price, description, available, unitType } = req.body;

  db.run(
    `INSERT INTO products (name, price, description, available, unitType)
     VALUES (?, ?, ?, ?, ?)`,
    [name, price, description || '', available ? 1 : 0, unitType || 'kg'],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, productId: this.lastID });
    }
  );
});

app.put('/api/products/:id', (req, res) => {
  const { name, price, description, available, unitType } = req.body;

  db.run(
    `UPDATE products
     SET name = ?, price = ?, description = ?, available = ?, unitType = ?
     WHERE id = ?`,
    [name, price, description || '', available ? 1 : 0, unitType || 'kg', req.params.id],
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
      rows.forEach(r => {
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

app.post('/api/products/:id/images', upload.array('images', 10), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'لا توجد صور' });

  const stmt = db.prepare('INSERT INTO product_images (product_id, image) VALUES (?, ?)');
  req.files.forEach(f => stmt.run(req.params.id, f.filename));
  stmt.finalize();

  res.json({ success: true, files: req.files.length });
});

/* ================== ORDERS ================== */
app.get('/api/orders', (req, res) => {
  db.all('SELECT * FROM orders ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.map(o => ({ ...o, items: safeJson(o.items) })));
  });
});

app.post('/api/orders', (req, res) => {
  const { items, phone, country, address, name } = req.body;

  db.run(
    `INSERT INTO orders (name, phone, country, address, items, status, createdAt, assignedToCourier, cancelReason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      phone,
      country,
      address,
      JSON.stringify(items || []),
      'new',
      new Date().toISOString(),
      0,
      ''
    ],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, orderId: this.lastID });
    }
  );
});

app.put('/api/orders/:id/status', (req, res) => {
  const { status, cancelReason } = req.body;

  db.run(
    'UPDATE orders SET status = ?, cancelReason = ? WHERE id = ?',
    [
      status,
      status === 'cancelled' ? (cancelReason || '') : '', // ✅ نخزن السبب بس لو ملغي
      req.params.id
    ],
    (err) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true });
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
  db.run(
    'UPDATE orders SET assignedToCourier = ? WHERE id = ?',
    [assigned, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, changes: this.changes });
    }
  );
});

/* ================== COURIER APIs ================== */
app.get('/api/courier/orders', (req, res) => {
  // لازم يكون isCourier (guard فوق)
  const status = req.query.status; // all/new/contacted/in_progress/done/cancelled
  let where = 'WHERE assignedToCourier = 1';
  const params = [];

  if (status && status !== 'all') {
    where += ' AND status = ?';
    params.push(status);
  }

  db.all(`SELECT * FROM orders ${where} ORDER BY id DESC`, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.map(o => ({ ...o, items: safeJson(o.items) })));
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

/* ================== HELPERS ================== */
function safeJson(s) {
  try {
    if (!s) return [];
    return JSON.parse(s);
  } catch {
    return [];
  }
}

/* ================== START ================== */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
