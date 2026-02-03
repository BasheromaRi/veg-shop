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

/* ================== PATHS ================== */
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public/uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ================== DB ================== */
const db = new sqlite3.Database(path.join(DATA_DIR, 'data.db'), err => {
  if (err) console.error('DB error', err);
  else console.log('Connected to SQLite DB');
});

/* ================== ADMIN ================== */
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'Q1azP0lm';

/* ================== MIDDLEWARE ================== */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(
  session({
    name: 'vegshop.sid',
    secret: 'veg-shop-secret',
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({
      db: 'sessions.db',
      dir: DATA_DIR
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // Render free = false
      maxAge: 1000 * 60 * 60 * 6
    }
  })
);

/* ================== STATIC ================== */
app.use(express.static(path.join(__dirname, 'public')));
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
    res.clearCookie('vegshop.sid');
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

/* ================== PAGE GUARD ================== */
const protectedPages = [
  '/admin.html',
  '/manage-products.html',
  '/orders.html',
  '/campaigns.html'
];

app.use((req, res, next) => {
  if (protectedPages.includes(req.path) && !req.session.isAdmin) {
    return res.redirect('/login.html');
  }
  next();
});

/* ================== API GUARD ================== */
app.use((req, res, next) => {
  if (req.path.startsWith('/uploads')) return next();
  if (req.session.isAdmin) return next();

  if (req.method === 'GET' && req.path === '/api/products') return next();
  if (req.method === 'POST' && req.path === '/api/orders') return next();
  if (req.method === 'POST' && req.path === '/api/login') return next();
  if (req.method === 'GET' && req.path === '/api/me') return next();

  return res.status(401).json({ error: 'غير مصرح' });
});

/* ================== MULTER ================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, 'products', req.params.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
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
        map[img.product_id].push(
          `/uploads/products/${img.product_id}/${img.image}`
        );
      });

      res.json(
        products.map(p => ({
          ...p,
          images: map[p.id] || []
        }))
      );
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

app.post(
  '/api/products/:id/images',
  upload.array('images', 5),
  (req, res) => {
    if (!req.files?.length) {
      return res.status(400).json({ error: 'لا توجد صور' });
    }

    const stmt = db.prepare(
      'INSERT INTO product_images (product_id, image) VALUES (?, ?)'
    );

    req.files.forEach(f => stmt.run(req.params.id, f.filename));
    stmt.finalize();

    res.json({ success: true });
  }
);

/* ================== ORDERS ================== */
app.post('/api/orders', (req, res) => {
  const { items, phone, country, address, name } = req.body;

  db.run(
    `INSERT INTO orders (name, phone, country, address, items, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      phone,
      country,
      address,
      JSON.stringify(items),
      'new',
      new Date().toISOString()
    ],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true });
    }
  );
});

/* ================== START ================== */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
