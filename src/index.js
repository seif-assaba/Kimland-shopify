require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// ========== MIDDLEWARE ==========
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========== SESSION ==========
app.use(session({
  secret: process.env.SESSION_SECRET || 'kimland-shopify-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// ========== STATIC FILES ==========
app.use(express.static(path.join(__dirname, '../public')));

// ========== VIEWS ==========
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ========== IMPORT ROUTES ==========
const apiRoutes = require('./routes/apiRoutes');

// ========== USE ROUTES ==========
app.use('/api', apiRoutes);

// ========== HOME PAGE ==========
app.get('/', (req, res) => {
  let productCount = 0;
  let lastProduct = null;

  try {
    const files = fs.readdirSync('.');
    const productFiles = files.filter(f => f.startsWith('product-') && f.endsWith('.json'));
    productCount = productFiles.length;

    if (productCount > 0) {
      const data = JSON.parse(fs.readFileSync(productFiles[0], 'utf8'));
      lastProduct = data;
    }
  } catch (e) {}

  const shopifyConfigured = Boolean(process.env.SHOPIFY_ADMIN_TOKEN && process.env.SHOPIFY_ADMIN_TOKEN !== 'shpat_xxxxxxxxxxxxxxxxxxxxxxxx');

  res.render('dashboard', {
    title: 'Kimland Shopify Sync',
    hasProducts: productCount > 0,
    productCount: productCount,
    lastProduct: lastProduct,
    isLoggedIn: true,
    shopifyConfigured: shopifyConfigured,
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// ========== START ==========
app.listen(PORT, HOST, () => {
  console.log('\n========================================');
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📌 API available at http://${HOST}:${PORT}/api`);
  console.log('========================================\n');
});

module.exports = app;