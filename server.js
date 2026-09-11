require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const DELIVERY_FEE = 2; // flat delivery fee in JOD, applied to every order across Jordan

const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const STATS_FILE = path.join(__dirname, 'stats.json');
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const CODE_OWNERS_FILE = path.join(__dirname, 'codeOwners.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
if (!fs.existsSync(CODE_OWNERS_FILE)) fs.writeFileSync(CODE_OWNERS_FILE, '[]', 'utf8');

/* ---------- simple JSON file storage helpers ---------- */
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function getProducts() { return readJSON(PRODUCTS_FILE, []); }
function saveProducts(products) { writeJSON(PRODUCTS_FILE, products); }
function getStats() { return readJSON(STATS_FILE, { visits: 0 }); }
function saveStats(stats) { writeJSON(STATS_FILE, stats); }
function getOrders() { return readJSON(ORDERS_FILE, []); }
function saveOrders(orders) { writeJSON(ORDERS_FILE, orders); }
function getCodeOwners() { return readJSON(CODE_OWNERS_FILE, []); }
function saveCodeOwners(owners) { writeJSON(CODE_OWNERS_FILE, owners); }
function genOrderNumber() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ---------- write lock ----------
   As the catalog grows and gets more concurrent traffic (an order coming in while an
   admin edits a product, two orders landing at nearly the same time, etc.), any code
   path that does read -> modify -> write on products.json/orders.json/stats.json must
   run as one atomic step, otherwise a second request can read stale data before the
   first one's write lands and silently overwrite it (e.g. a lost stock decrement).
   withFileLock() queues every such operation so they always run one at a time, in order. */
let writeLock = Promise.resolve();
function withFileLock(fn) {
  const run = writeLock.then(() => fn());
  writeLock = run.then(() => {}, () => {}); // keep the chain alive even if fn() throws
  return run;
}

/* ---------- image upload handling ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, 'p' + Date.now() + '-' + Math.round(Math.random() * 1e6) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  }
});
const uploadImages = upload.array('images', 6);
const uploadProof = upload.single('cliqProof');

/* ---------- middleware ---------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 } // 12 hours
}));
// Only /uploads (product photos) is served as a static folder. We deliberately do NOT
// serve the whole project directory as static files, since that would also expose
// server.js, package.json, and the JSON data files (which contain customer names,
// phone numbers and addresses) directly over HTTP. index.html, admin.html and
// style.css are each served through their own explicit route below instead.
app.use('/uploads', express.static(UPLOADS_DIR));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

/* ---------- public API ---------- */
app.get('/api/products', (req, res) => {
  // stockQty is internal (database + admin only) — the public endpoint only ever
  // exposes a computed true/false inStock flag, never the actual quantity number.
  const products = getProducts().map(p => {
    const { stockQty, ...pub } = p;
    pub.inStock = (stockQty || 0) > 0;
    return pub;
  });
  res.json(products);
});

app.post('/api/visit', (req, res) => {
  withFileLock(() => {
    const stats = getStats();
    stats.visits = (stats.visits || 0) + 1;
    saveStats(stats);
    res.json({ visits: stats.visits });
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

app.post('/api/products/:id/view', (req, res) => {
  withFileLock(() => {
    const products = getProducts();
    const p = products.find(x => String(x.id) === String(req.params.id));
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    p.views = (p.views || 0) + 1;
    saveProducts(products);
    res.json({ views: p.views });
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

app.get('/api/config', (req, res) => {
  res.json({
    cliqAlias: process.env.CLIQ_ALIAS || '0776410059',
    cliqName: process.env.CLIQ_NAME || 'ANJUM Store',
    deliveryFee: DELIVERY_FEE,
    currency: 'JD'
  });
});

/* ---------- orders ---------- */
app.post('/api/orders', uploadProof, (req, res) => {
  const body = req.body;
  let items;
  try {
    items = JSON.parse(body.itemsJSON || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid items' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  if (!body.customerName || !body.phone || !body.address) {
    return res.status(400).json({ error: 'Missing customer details' });
  }
  if (!['cod', 'cliq'].includes(body.paymentMethod)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }
  if (body.paymentMethod === 'cliq' && !req.file) {
    return res.status(400).json({ error: 'CliQ transfer proof image is required' });
  }

  withFileLock(() => {
    // recompute prices/names server-side from the product catalog so the client can't tamper with totals
    const products = getProducts();
    let total = 0;
    const lineItems = items.map(it => {
      const p = products.find(x => String(x.id) === String(it.productId));
      const price = p ? p.price : 0;
      const qty = Math.max(1, parseInt(it.qty) || 1);
      total += price * qty;
      return {
        productId: it.productId,
        name: p ? p.name : (it.name || 'Unknown item'),
        price,
        qty,
        size: it.size || '',
        color: it.color || ''
      };
    });

    // discount code: only codes registered via "Become a Code Partner" are valid.
    // Gives the customer 10% off; the same 10% of the order value is tracked as an amount
    // owed to the registered code owner (paid out manually by the store, off-platform).
    const subtotal = total;
    let code = (body.code || '').trim();
    let discountAmount = 0;
    if (code.length >= 3) {
      code = code.toUpperCase();
      const owners = getCodeOwners();
      const owner = owners.find(o => o.code === code);
      if (!owner) {
        res.status(400).json({ error: 'This discount code is not registered. Check the code or remove it to continue.' });
        return;
      }
      discountAmount = Math.round(subtotal * 0.10 * 100) / 100;
      total = Math.round((subtotal - discountAmount) * 100) / 100;
    } else {
      code = '';
    }

    const deliveryFee = DELIVERY_FEE;
    total = Math.round((total + deliveryFee) * 100) / 100;

    // decrement stock quantity for each ordered item (floored at 0)
    lineItems.forEach(li => {
      const p = products.find(x => String(x.id) === String(li.productId));
      if (p) p.stockQty = Math.max(0, (p.stockQty || 0) - li.qty);
    });
    saveProducts(products);

    const orders = getOrders();
    const order = {
      id: Date.now(),
      orderNumber: genOrderNumber(),
      customerName: body.customerName,
      phone: body.phone,
      address: body.address,
      items: lineItems,
      subtotal,
      code: code || null,
      discountAmount,
      deliveryFee,
      total,
      paymentMethod: body.paymentMethod,
      cliqProof: req.file ? ('/uploads/' + req.file.filename) : null,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    orders.push(order);
    saveOrders(orders);
    res.json({ orderNumber: order.orderNumber, total: order.total, subtotal: order.subtotal, code: order.code, discountAmount: order.discountAmount, deliveryFee: order.deliveryFee });
  }).catch(() => res.status(500).json({ error: 'Server error, please try again' }));
});

app.get('/api/orders/track', (req, res) => {
  const phone = (req.query.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  const orders = getOrders().filter(o => o.phone.trim() === phone);
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(orders);
});

app.get('/api/orders', requireAdmin, (req, res) => {
  const orders = getOrders();
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(orders);
});

app.get('/api/codes', requireAdmin, (req, res) => {
  const orders = getOrders().filter(o => o.code);
  const owners = getCodeOwners();
  const map = {};
  orders.forEach(o => {
    if (!map[o.code]) map[o.code] = { code: o.code, uses: 0, totalOrderValue: 0, totalOwed: 0 };
    map[o.code].uses += 1;
    map[o.code].totalOrderValue += o.subtotal || 0;
    map[o.code].totalOwed += o.discountAmount || 0;
  });
  // also list registered codes that haven't been used yet, so the admin sees them too
  owners.forEach(o => {
    if (!map[o.code]) map[o.code] = { code: o.code, uses: 0, totalOrderValue: 0, totalOwed: 0 };
  });
  const list = Object.values(map).map(entry => {
    const owner = owners.find(o => o.code === entry.code);
    return {
      ...entry,
      ownerName: owner ? owner.name : null,
      ownerPhone: owner ? owner.phone : null,
      registered: !!owner
    };
  }).sort((a, b) => b.totalOwed - a.totalOwed);
  res.json(list);
});

/* ---------- code owner registration (anyone can claim a unique code) ---------- */
app.post('/api/code-owners', (req, res) => {
  withFileLock(() => {
    const { name, phone } = req.body;
    let code = (req.body.code || '').trim();
    if (!name || !phone) { res.status(400).json({ error: 'Name and phone are required' }); return; }
    if (code.length < 3) { res.status(400).json({ error: 'Code must be at least 3 characters' }); return; }
    code = code.toUpperCase();
    const owners = getCodeOwners();
    if (owners.some(o => o.code === code)) {
      res.status(409).json({ error: 'This code is already taken. Try a different one.' });
      return;
    }
    const owner = { id: Date.now(), name, phone, code, createdAt: new Date().toISOString() };
    owners.push(owner);
    saveCodeOwners(owners);
    res.json({ ok: true, code: owner.code });
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

app.get('/api/code-owners/check', (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (code.length < 3) { res.json({ available: false }); return; }
  const owners = getCodeOwners();
  res.json({ available: !owners.some(o => o.code === code) });
});

app.put('/api/orders/:id', requireAdmin, (req, res) => {
  withFileLock(() => {
    const orders = getOrders();
    const o = orders.find(x => String(x.id) === String(req.params.id));
    if (!o) { res.status(404).json({ error: 'Not found' }); return; }
    const allowedStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (req.body.status && allowedStatuses.includes(req.body.status)) {
      o.status = req.body.status;
    }
    saveOrders(orders);
    res.json(o);
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

/* ---------- admin auth ---------- */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Incorrect password' });
});
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/admin/check', (req, res) => {
  res.json({ authed: !!(req.session && req.session.isAdmin) });
});

/* ---------- admin-only product management ---------- */
app.post('/api/products', requireAdmin, uploadImages, (req, res) => {
  withFileLock(() => {
    const products = getProducts();
    const body = req.body;
    let sizes = body.sizesText && body.sizesText.trim()
      ? body.sizesText.split(',').map(s => s.trim())
      : 'Most sizes available';
    let colors = body.colorsText && body.colorsText.trim()
      ? body.colorsText.split(',').map(s => s.trim())
      : [];
    const images = (req.files || []).map(f => '/uploads/' + f.filename);
    const newProduct = {
      id: Date.now(),
      name: body.name,
      category: body.category,
      sub: body.sub || '',
      type: body.type || '',
      price: parseFloat(body.price) || 0,
      sizes,
      colors,
      descAr: body.descAr || '',
      stockQty: Math.max(0, parseInt(body.stockQty) || 0),
      featured: body.featured === 'true' || body.featured === 'on',
      images,
      views: 0
    };
    products.push(newProduct);
    saveProducts(products);
    res.json(newProduct);
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  // quick JSON-only updates (e.g. toggling "featured") — kept separate from the full edit form below
  withFileLock(() => {
    const products = getProducts();
    const p = products.find(x => String(x.id) === String(req.params.id));
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    Object.assign(p, req.body);
    saveProducts(products);
    res.json(p);
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

app.put('/api/products/:id/edit', requireAdmin, uploadImages, (req, res) => {
  withFileLock(() => {
    const products = getProducts();
    const p = products.find(x => String(x.id) === String(req.params.id));
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    const body = req.body;

    if (body.name) p.name = body.name;
    if (body.category) p.category = body.category;
    if (body.sub !== undefined) p.sub = body.sub;
    if (body.type !== undefined) p.type = body.type;
    if (body.price) p.price = parseFloat(body.price) || p.price;
    if (body.sizesText !== undefined) {
      p.sizes = body.sizesText.trim() ? body.sizesText.split(',').map(s => s.trim()) : 'Most sizes available';
    }
    if (body.colorsText !== undefined) {
      p.colors = body.colorsText.trim() ? body.colorsText.split(',').map(s => s.trim()) : [];
    }
    if (body.descAr !== undefined) p.descAr = body.descAr;
    if (body.stockQty !== undefined) p.stockQty = Math.max(0, parseInt(body.stockQty) || 0);
    p.featured = body.featured === 'true' || body.featured === 'on';

    // remove any existing images the admin flagged for deletion
    if (body.removeImages) {
      try {
        const toRemove = JSON.parse(body.removeImages);
        if (Array.isArray(toRemove) && toRemove.length) {
          toRemove.forEach(imgPath => {
            fs.unlink(path.join(__dirname, imgPath), () => {});
          });
          p.images = (p.images || []).filter(img => !toRemove.includes(img));
        }
      } catch (e) { /* ignore malformed removeImages */ }
    }
    // append any newly uploaded images
    if (req.files && req.files.length) {
      const newImages = req.files.map(f => '/uploads/' + f.filename);
      p.images = [...(p.images || []), ...newImages];
    }

    saveProducts(products);
    res.json(p);
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  withFileLock(() => {
    let products = getProducts();
    const p = products.find(x => String(x.id) === String(req.params.id));
    if (p && Array.isArray(p.images)) {
      p.images.forEach(imgPath => {
        const filePath = path.join(__dirname, imgPath);
        fs.unlink(filePath, () => {}); // best-effort cleanup, ignore errors
      });
    }
    products = products.filter(x => String(x.id) !== String(req.params.id));
    saveProducts(products);
    res.json({ ok: true });
  }).catch(() => res.status(500).json({ error: 'Server error' }));
});

app.get('/api/stats', requireAdmin, (req, res) => {
  const stats = getStats();
  const products = getProducts();
  res.json({
    visits: stats.visits || 0,
    totalProducts: products.length,
    outOfStock: products.filter(p => (p.stockQty || 0) === 0).length,
    totalViews: products.reduce((s, p) => s + (p.views || 0), 0),
    products
  });
});

/* ---------- page routes ---------- */
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ANJUM server running on http://localhost:${PORT}`);
});
