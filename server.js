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
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads'); // على الديسك
const ADMIN_DIR = path.join(__dirname, 'admin'); // صفحات الإدارة خارج public

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ================== DB ================== */
const dbPath = path.join(DATA_DIR, 'data.db');
const db = new sqlite3.Database(dbPath, err => {
  if (err) console.error('DB error', err);
  else console.log('Connected to SQLite DB:', dbPath);
});

/* ================== ADMIN ================== */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Q1azP0lm';

/* ================== MIDDLEWARE ================== */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.set('trust proxy', 1);

/* ✅ Session Store ثابت (مهم لRender) */
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

/* ✅ منع كاش للصفحات الحساسة (حتى ما يضل "فاتح") */
function noCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

/* ================== STATIC (المتجر فقط) ================== */
app.use(express.static(path.join(__dirname, 'public')));

/* ✅ الصور من Disk */
app.use('/uploads', express.static(UPLOADS_DIR));

/* ================== AUTH ================== */
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
    // ✅ مسح الكوكي صح من الجذر
    res.clearCookie('vegshop.sid', { path: '/' });
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!req.session?.isAdmin });
});

/* ================== ADMIN PAGES (منفصلة) ==================
   الروابط:
   /admin/secret-admin-9347
   /admin/manage-products
   /admin/orders
   /admin/campaigns
*/
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.redirect('/login.html');
}

app.get('/admin/secret-admin-9347', noCache, requireAdmin, (req, res) => {
  return res.sendFile(path.join(ADMIN_DIR, 'secret-admin-9347.html'));
});

app.get('/admin/manage-products', noCache, requireAdmin, (req, res) => {
  return res.sendFile(path.join(ADMIN_DIR, 'manage-products.html'));
});

app.get('/admin/orders', noCache, requireAdmin, (req, res) => {
  return res.sendFile(path.join(ADMIN_DIR, 'orders.html'));
});

app.get('/admin/campaigns', noCache, requireAdmin, (req, res) => {
  return res.sendFile(path.join(ADMIN_DIR, 'campaigns.html'));
});

/* (اختياري) لو حد كتب .html بالغلط، نوجّهه للمسار الصح */
app.get('/secret-admin-9347.html', (req, res) => res.redirect('/admin/secret-admin-9347'));

/* ================== API GUARD ==================
   مهم: لأننا عاملين app.use('/api', apiGuard)
   فـ req.path هون بيكون /products /orders /login ...
*/
function apiGuard(req, res, next) {
  // السماح للزبون:
  if (req.method === 'GET' && req.path === '/products') return next();
  if (req.method === 'POST' && req.path === '/orders') return next();

  // auth:
  if (req.method === 'POST' && req.path === '/login') return next();
  if (req.method === 'POST' && req.path === '/logout') return next();
  if (req.method === 'GET' && req.path === '/me') return next();

  // أي API للإدارة لازم يكون Admin
  if (req.session?.isAdmin) return next();

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
  },
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

app.post('/api/products/:id/images', upload.array('images', 10), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'لا توجد صور' });

  const stmt = db.prepare('INSERT INTO product_images (product_id, image) VALUES (?, ?)');
  req.files.forEach(f => stmt.run(req.params.id, f.filename));
  stmt.finalize();

  res.json({ success: true, files: req.files.length });
});

/* ================== ORDERS ================== */
/* ✅ الزبون: يضيف طلب */
app.post('/api/orders', (req, res) => {
  const { items, phone, country, address, name } = req.body;

  db.run(
    `INSERT INTO orders (name, phone, country, address, items, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, phone, country, address, JSON.stringify(items), 'new', new Date().toISOString()],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true, orderId: this.lastID });
    }
  );
});

/* ✅ الإدارة: تقرأ الطلبات */
app.get('/api/orders', (req, res) => {
  if (!req.session?.isAdmin) return res.status(401).json({ error: 'غير مصرح' });

  db.all('SELECT * FROM orders ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.map(o => ({ ...o, items: JSON.parse(o.items) })));
  });
});

app.put('/api/orders/:id/status', (req, res) => {
  if (!req.session?.isAdmin) return res.status(401).json({ error: 'غير مصرح' });

  db.run('UPDATE orders SET status = ? WHERE id = ?', [req.body.status, req.params.id], err => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true });
  });
});

app.delete('/api/orders/:id', (req, res) => {
  if (!req.session?.isAdmin) return res.status(401).json({ error: 'غير مصرح' });

  db.run('DELETE FROM orders WHERE id = ?', [req.params.id], err => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true });
  });
});

/* ================== START ================== */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
