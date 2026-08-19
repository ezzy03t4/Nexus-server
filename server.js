// ================================================================
// SERVER.JS — Full implementation with deposit, withdrawal, support & trading
// ================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ================================================================
// EXPRESS APP
// ================================================================
const app = express();
// Allow multiple origins (including your local Live Server)
const allowedOrigins = [
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:5000',
  'https://nexus.pxxlspace.cv',
  process.env.FRONTEND_URL
].filter(Boolean); // remove undefined

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  // If you need credentials (cookies), uncomment:
  // credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ================================================================
// MULTER CONFIGURATION (for file uploads)
// ================================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ================================================================
// RATE LIMITING
// ================================================================
const rateLimits = {};
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 100;

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (!rateLimits[ip]) {
    rateLimits[ip] = { count: 1, resetTime: now + RATE_LIMIT_WINDOW };
    return next();
  }

  if (now > rateLimits[ip].resetTime) {
    rateLimits[ip].count = 1;
    rateLimits[ip].resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }

  rateLimits[ip].count++;
  if (rateLimits[ip].count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  next();
};

setInterval(() => {
  const now = Date.now();
  Object.keys(rateLimits).forEach(ip => {
    if (now > rateLimits[ip].resetTime) delete rateLimits[ip];
  });
}, 60 * 1000);

app.use(rateLimiter);

// ================================================================
// SQLITE DATABASE (with full schema and migrations) - using sqlite3
// ================================================================
const db = new sqlite3.Database(process.env.DATABASE_PATH || 'database.sqlite');
// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// Promisify db methods for async/await
db.getAsync = promisify(db.get).bind(db);
db.allAsync = promisify(db.all).bind(db);
db.runAsync = promisify(db.run).bind(db);
db.execAsync = promisify(db.exec).bind(db);

// Helper to run schema migrations (synchronous - we can use execAsync with await)
async function initDatabase() {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      country TEXT NOT NULL,
      phone TEXT DEFAULT '',
      selectedPlan TEXT DEFAULT NULL,
      balance REAL DEFAULT 0,
      profilePicture TEXT DEFAULT NULL,
      isAdmin INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      verificationCode TEXT DEFAULT NULL,
      verificationCodeExpires INTEGER DEFAULT NULL,
      createdAt INTEGER DEFAULT (strftime('%s', 'now')),
      updatedAt INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal', 'trade', 'bonus', 'plan_purchase')),
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed', 'cancelled', 'processing')),
      method TEXT DEFAULT NULL,
      description TEXT DEFAULT '',
      reference TEXT DEFAULT NULL,
      proof TEXT DEFAULT NULL,
      createdAt INTEGER DEFAULT (strftime('%s', 'now')),
      updatedAt INTEGER DEFAULT (strftime('%s', 'now')),
      completedAt INTEGER DEFAULT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      isRead INTEGER DEFAULT 0,
      createdAt INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      date TEXT NOT NULL,
      action TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      UNIQUE(userId, date, action),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      amount REAL NOT NULL,
      averagePrice REAL NOT NULL,
      createdAt INTEGER DEFAULT (strftime('%s', 'now')),
      updatedAt INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(userId, symbol)
    )
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      subject TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      message TEXT NOT NULL,
      attachment TEXT DEFAULT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
      adminReply TEXT DEFAULT NULL,
      createdAt INTEGER DEFAULT (strftime('%s', 'now')),
      updatedAt INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // ---- Migrations: ensure all columns exist ----
  // Users table
  const userTableInfo = await db.allAsync("PRAGMA table_info(users)");
  const existingUserCols = userTableInfo.map(c => c.name);
  const userColumnsToAdd = [
    { name: 'profilePicture', type: 'TEXT DEFAULT NULL' },
    { name: 'updatedAt', type: 'INTEGER DEFAULT 0' },
    { name: 'selectedPlan', type: 'TEXT DEFAULT NULL' },
    { name: 'balance', type: 'REAL DEFAULT 0' },
    { name: 'isAdmin', type: 'INTEGER DEFAULT 0' },
    { name: 'blocked', type: 'INTEGER DEFAULT 0' },
    { name: 'verified', type: 'INTEGER DEFAULT 0' },
    { name: 'verificationCode', type: 'TEXT DEFAULT NULL' },
    { name: 'verificationCodeExpires', type: 'INTEGER DEFAULT NULL' }
  ];
  for (const col of userColumnsToAdd) {
    if (!existingUserCols.includes(col.name)) {
      console.log(`🔄 Adding ${col.name} column to users...`);
      await db.execAsync(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
    }
  }
  await db.execAsync('UPDATE users SET updatedAt = createdAt WHERE updatedAt IS NULL OR updatedAt = 0');

  // Transactions table
  const txTableInfo = await db.allAsync("PRAGMA table_info(transactions)");
  const existingTxCols = txTableInfo.map(c => c.name);
  const txColumnsToAdd = [
    { name: 'proof', type: 'TEXT DEFAULT NULL' },
    { name: 'description', type: 'TEXT DEFAULT ""' },
    { name: 'completedAt', type: 'INTEGER DEFAULT NULL' },
    { name: 'method', type: 'TEXT DEFAULT NULL' },
    { name: 'updatedAt', type: 'INTEGER DEFAULT 0' },
    { name: 'currency', type: 'TEXT DEFAULT "USD"' },
    { name: 'originalAmount', type: 'REAL DEFAULT 0' },
    { name: 'exchangeRate', type: 'REAL DEFAULT 1' },
    { name: 'feePercent', type: 'REAL DEFAULT 0' },
    { name: 'feeAmount', type: 'REAL DEFAULT 0' }
  ];
  for (const col of txColumnsToAdd) {
    if (!existingTxCols.includes(col.name)) {
      console.log(`🔄 Adding ${col.name} column to transactions...`);
      await db.execAsync(`ALTER TABLE transactions ADD COLUMN ${col.name} ${col.type}`);
    }
  }
  await db.execAsync('UPDATE transactions SET updatedAt = createdAt WHERE updatedAt IS NULL OR updatedAt = 0');

  // Fix transactions CHECK constraint to include 'plan_purchase' if needed
  const txCreateSql = await db.getAsync("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'");
  if (txCreateSql && !txCreateSql.sql.includes("'plan_purchase'")) {
    console.log('🔄 Recreating transactions table to add plan_purchase to CHECK constraint...');
    await db.execAsync('BEGIN TRANSACTION');
    await db.execAsync(`
      CREATE TABLE transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal', 'trade', 'bonus', 'plan_purchase')),
        amount REAL NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed', 'cancelled', 'processing')),
        method TEXT DEFAULT NULL,
        description TEXT DEFAULT '',
        reference TEXT DEFAULT NULL,
        proof TEXT DEFAULT NULL,
        createdAt INTEGER DEFAULT (strftime('%s', 'now')),
        updatedAt INTEGER DEFAULT (strftime('%s', 'now')),
        completedAt INTEGER DEFAULT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await db.execAsync(`
      INSERT INTO transactions_new (
        id, userId, type, amount, status, method, description,
        reference, proof, createdAt, updatedAt, completedAt
      )
      SELECT
        id, userId, type, amount, status, method, description,
        reference, proof, createdAt, updatedAt, completedAt
      FROM transactions
    `);
    await db.execAsync('DROP TABLE transactions');
    await db.execAsync('ALTER TABLE transactions_new RENAME TO transactions');
    await db.execAsync('COMMIT');
    console.log('✅ transactions table recreated with updated CHECK constraint.');
  }

  // Support tickets migrations
  const supportTableInfo = await db.allAsync("PRAGMA table_info(support_tickets)");
  const existingSupportCols = supportTableInfo.map(c => c.name);
  const supportColumnsToAdd = [
    { name: 'attachment', type: 'TEXT DEFAULT NULL' },
    { name: 'adminReply', type: 'TEXT DEFAULT NULL' },
    { name: 'updatedAt', type: 'INTEGER DEFAULT 0' }
  ];
  for (const col of supportColumnsToAdd) {
    if (!existingSupportCols.includes(col.name)) {
      console.log(`🔄 Adding ${col.name} column to support_tickets...`);
      await db.execAsync(`ALTER TABLE support_tickets ADD COLUMN ${col.name} ${col.type}`);
    }
  }
  await db.execAsync('UPDATE support_tickets SET updatedAt = createdAt WHERE updatedAt IS NULL OR updatedAt = 0');
}

// Initialize database (run before starting server)
initDatabase().then(() => {
  console.log('✅ Database schema and migrations applied.');
}).catch(err => {
  console.error('❌ Database initialization error:', err);
  process.exit(1);
});

// ================================================================
// HELPERS
// ================================================================
const rowToUser = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    password: row.password,
    country: row.country,
    phone: row.phone || '',
    selectedPlan: row.selectedPlan || null,
    balance: row.balance || 0,
    profilePicture: row.profilePicture || null,
    isAdmin: row.isAdmin === 1,
    blocked: row.blocked === 1,
    verified: row.verified === 1,
    verificationCode: row.verificationCode || null,
    verificationCodeExpires: row.verificationCodeExpires ? new Date(row.verificationCodeExpires * 1000) : null,
    createdAt: new Date(row.createdAt * 1000),
    updatedAt: new Date(row.updatedAt * 1000),
  };
};

const rowToTransaction = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    amount: row.amount,
    status: row.status,
    method: row.method || null,
    description: row.description || '',
    reference: row.reference || null,
    proof: row.proof || null,
    createdAt: new Date(row.createdAt * 1000),
    updatedAt: new Date(row.updatedAt * 1000),
    completedAt: row.completedAt ? new Date(row.completedAt * 1000) : null,
  };
};

const generateVerificationCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateResetCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateReference = () => {
  const prefix = 'NX';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${timestamp}${random}`;
};

const log = (level, message, data = null) => {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...(data && { data }) }));
};

// ================================================================
// PLAN CONFIGURATION
// ================================================================
const PLAN_CONFIG = {
  Starter:   { price: 100,  maxTrade: 1000,   refreshLimit: 5,   cashbackPercent: 0   },
  Basic:     { price: 500,  maxTrade: 5000,   refreshLimit: 10,  cashbackPercent: 5  },
  Pro:       { price: 1500, maxTrade: 20000,  refreshLimit: 20,  cashbackPercent: 10  },
  Elite:     { price: 3500, maxTrade: 50000,  refreshLimit: 50,  cashbackPercent: 15  },
  Enterprise:{ price: 7500, maxTrade: 200000, refreshLimit: 100, cashbackPercent: 20  },
  Titan:     { price: 15000,maxTrade: 1000000,refreshLimit: 999999, cashbackPercent: 40}
};

const PLAN_ORDER = {
  Starter: 1,
  Basic: 2,
  Pro: 3,
  Elite: 4,
  Enterprise: 5,
  Titan: 6
};

// Serve the dashboard page
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'https://nexus.pxxlspace.cv/Dashboard/index.html'));
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'https://nexus.pxxlspace.cv/index.html'));
});

const PLAN_PRICES = Object.fromEntries(
  Object.entries(PLAN_CONFIG).map(([name, cfg]) => [name, cfg.price])
);

// ---- Daily usage helpers ----
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

async function getDailyUsage(userId, action, date) {
  const row = await db.getAsync('SELECT count FROM daily_usage WHERE userId = ? AND date = ? AND action = ?', userId, date, action);
  return row ? row.count : 0;
}

async function incrementDailyUsage(userId, action, date) {
  await db.runAsync(`
    INSERT INTO daily_usage (userId, date, action, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(userId, date, action) DO UPDATE SET count = count + 1
  `, userId, date, action);
}

async function checkAndIncrementDailyLimit(userId, action, limit) {
  const date = getTodayDate();
  const used = await getDailyUsage(userId, action, date);
  if (used >= limit) {
    return { allowed: false, used, limit };
  }
  await incrementDailyUsage(userId, action, date);
  return { allowed: true, used: used + 1, limit };
}

// ---- CoinGecko ID mapping ----
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOT: 'polkadot',
  XRP: 'ripple',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  LINK: 'chainlink',
  UNI: 'uniswap',
  ATOM: 'cosmos',
  LTC: 'litecoin'
};
const SUPPORTED_SYMBOLS = Object.keys(COINGECKO_IDS);

// ================================================================
// EXCHANGE RATE FETCHER (USD base)
// ================================================================
const EXCHANGE_RATE_API = 'https://api.exchangerate-api.com/v4/latest/USD';
const RATE_CACHE = {};
const RATE_CACHE_TTL = 10 * 60 * 1000;

async function getExchangeRates() {
    const now = Date.now();
    if (RATE_CACHE.timestamp && (now - RATE_CACHE.timestamp < RATE_CACHE_TTL)) {
        return RATE_CACHE.rates;
    }

    try {
        const response = await axios.get(EXCHANGE_RATE_API);
        const data = response.data;
        RATE_CACHE.rates = data.rates;
        RATE_CACHE.timestamp = now;
        console.log('[Exchange] Rates refreshed');
        return data.rates;
    } catch (error) {
        console.error('[Exchange] Failed to fetch rates:', error.message);
        if (RATE_CACHE.rates) {
            console.warn('[Exchange] Using stale rates');
            return RATE_CACHE.rates;
        }
        return { USD: 1, ZAR: 19.2, PHP: 70 };
    }
}

// ================================================================
// CRYPTO PRICE FETCHER WITH CACHE & FALLBACK
// ================================================================
const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';
const PRICE_CACHE = {};
const CACHE_TTL = 30 * 1000;

async function getCryptoPrices(symbols) {
  if (!symbols || symbols.length === 0) return {};

  const cacheKey = symbols.slice().sort().join(',');

  const now = Date.now();
  if (PRICE_CACHE[cacheKey] && (now - PRICE_CACHE[cacheKey].timestamp < CACHE_TTL)) {
    console.log(`[price] Using cached prices for ${cacheKey}`);
    return PRICE_CACHE[cacheKey].prices;
  }

  try {
    const ids = symbols
      .map(s => COINGECKO_IDS[s.toUpperCase()])
      .filter(Boolean)
      .join(',');

    if (!ids) {
      log('warn', 'No valid symbols provided for price fetch', { symbols });
      return {};
    }

    const apiKey = process.env.COINGECKO_API_KEY;
    const url = `${COINGECKO_API}?ids=${ids}&vs_currencies=usd`;
    
    const headers = {};
    if (apiKey) {
      headers['x-cg-demo-api-key'] = apiKey;
    }

    const response = await axios.get(url, { headers });
    const data = response.data;

    const result = {};
    for (const sym of symbols) {
      const id = COINGECKO_IDS[sym.toUpperCase()];
      if (id && data[id]) {
        result[sym.toUpperCase()] = data[id].usd;
      }
    }

    PRICE_CACHE[cacheKey] = {
      timestamp: now,
      prices: result,
    };

    console.log(`[price] Fetched fresh prices for ${cacheKey}`);
    return result;
  } catch (error) {
    if (PRICE_CACHE[cacheKey]) {
      console.warn(`[price] API failed, using stale cache for ${cacheKey}`);
      return PRICE_CACHE[cacheKey].prices;
    }

    if (error.response && error.response.status === 429) {
      console.warn('[price] Rate limit hit, waiting 2s and retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const ids = symbols
          .map(s => COINGECKO_IDS[s.toUpperCase()])
          .filter(Boolean)
          .join(',');

        const apiKey = process.env.COINGECKO_API_KEY;
        const url = `${COINGECKO_API}?ids=${ids}&vs_currencies=usd`;
        const headers = {};
        if (apiKey) {
          headers['x-cg-demo-api-key'] = apiKey;
        }

        const response = await axios.get(url, { headers });
        const data = response.data;

        const result = {};
        for (const sym of symbols) {
          const id = COINGECKO_IDS[sym.toUpperCase()];
          if (id && data[id]) {
            result[sym.toUpperCase()] = data[id].usd;
          }
        }

        PRICE_CACHE[cacheKey] = { timestamp: Date.now(), prices: result };
        console.log(`[price] Retry successful, fetched fresh prices for ${cacheKey}`);
        return result;
      } catch (retryError) {
        console.error('[price] Retry failed, returning empty (or stale if available)');
        if (PRICE_CACHE[cacheKey]) {
          console.warn(`[price] Using stale cache after retry failure for ${cacheKey}`);
          return PRICE_CACHE[cacheKey].prices;
        }
        log('error', 'Price fetch failed after retry', { message: retryError.message });
        return {};
      }
    }

    log('error', 'Failed to fetch crypto prices', { message: error.message });
    return {};
  }
}

// ================================================================
// SEED DEFAULT ADMIN
// ================================================================
(async function seedAdmin() {
  const adminEmail = 'admin@nexus.com';
  const adminPassword = 'Admin123!';
  const existing = await db.getAsync('SELECT id FROM users WHERE email = ?', adminEmail);
  if (!existing) {
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(adminPassword, salt);
    await db.runAsync(`
      INSERT INTO users (name, email, password, country, isAdmin, verified, balance)
      VALUES ('Admin', ?, ?, 'Global', 1, 1, 0)
    `, adminEmail, hashed);
    console.log('✅ Default admin created: admin@nexus.com / Admin123!');
  }
})();

// ================================================================
// PRICE & CONVERSION ROUTES
// ================================================================

app.get('/api/prices/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return res.status(400).json({ error: 'Unsupported symbol.' });
    }
    const prices = await getCryptoPrices([symbol]);
    const price = prices[symbol];
    if (!price) {
      return res.status(404).json({ error: 'Price not available.' });
    }
    res.json({ symbol, price, timestamp: new Date().toISOString() });
  } catch (error) {
    log('error', 'Price fetch error', error);
    res.status(500).json({ error: 'Failed to fetch price.' });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const prices = await getCryptoPrices(SUPPORTED_SYMBOLS);
    res.json({ prices, timestamp: new Date().toISOString() });
  } catch (error) {
    log('error', 'Prices fetch error', error);
    res.status(500).json({ error: 'Failed to fetch prices.' });
  }
});

app.get('/api/convert', async (req, res) => {
  try {
    const { from, to, amount } = req.query;
    if (!from || !to || !amount) {
      return res.status(400).json({ error: 'Missing parameters: from, to, amount' });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number.' });
    }

    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();

    if (fromUpper === 'USD' && toUpper === 'USD') {
      return res.json({ from: 'USD', to: 'USD', amount: amountNum, result: amountNum, rate: 1, timestamp: new Date().toISOString() });
    }

    const symbolsNeeded = [];
    if (fromUpper !== 'USD') symbolsNeeded.push(fromUpper);
    if (toUpper !== 'USD') symbolsNeeded.push(toUpper);

    for (const sym of symbolsNeeded) {
      if (!SUPPORTED_SYMBOLS.includes(sym)) {
        return res.status(400).json({ error: `Unsupported symbol: ${sym}` });
      }
    }

    const prices = await getCryptoPrices(symbolsNeeded);

    if (fromUpper === 'USD') {
      const price = prices[toUpper];
      if (!price) return res.status(404).json({ error: `Price for ${toUpper} not available.` });
      const result = amountNum / price;
      return res.json({
        from: 'USD',
        to: toUpper,
        amount: amountNum,
        result: result,
        rate: price,
        timestamp: new Date().toISOString()
      });
    }

    if (toUpper === 'USD') {
      const price = prices[fromUpper];
      if (!price) return res.status(404).json({ error: `Price for ${fromUpper} not available.` });
      const result = amountNum * price;
      return res.json({
        from: fromUpper,
        to: 'USD',
        amount: amountNum,
        result: result,
        rate: price,
        timestamp: new Date().toISOString()
      });
    }

    const fromPrice = prices[fromUpper];
    const toPrice = prices[toUpper];
    if (!fromPrice || !toPrice) {
      return res.status(404).json({ error: 'Price for one of the symbols not available.' });
    }
    const usdValue = amountNum * fromPrice;
    const result = usdValue / toPrice;
    const rate = fromPrice / toPrice;
    return res.json({
      from: fromUpper,
      to: toUpper,
      amount: amountNum,
      result: result,
      rate: rate,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log('error', 'Conversion error', error);
    res.status(500).json({ error: 'Conversion failed.' });
  }
});

// ================================================================
// EMAIL UTILITY
// ================================================================
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const transporter = {
  sendMail: async (mailOptions) => {
    try {
      const { from, to, subject, html } = mailOptions;
      const senderEmail = from || process.env.EMAIL_USER || 'nexusai58@gmail.com';

      const response = await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: { email: senderEmail, name: 'Nexus AI' },
          to: [{ email: to }],
          subject: subject,
          htmlContent: html,
        },
        {
          headers: {
            'api-key': BREVO_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );
      console.log('✅ Email sent via Brevo API:', response.data);
      return response.data;
    } catch (error) {
      console.error('❌ Brevo API error:', error.response?.data || error.message);
      throw error;
    }
  }
};

transporter.verify = function (callback) {
  if (callback) callback(null, true);
  return Promise.resolve(true);
};

const sendVerificationEmail = async (email, code) => {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Nexus AI - Verify Your Email',
    html: `
      <div style="font-family:Arial;max-width:500px;margin:0 auto;padding:20px;background:#0b0b0e;color:#f0f0f5;border-radius:12px;">
        <h1 style="background:linear-gradient(135deg,#6c5ce7,#00cec9);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Welcome to Nexus AI!</h1>
        <p style="color:#9494aa;">Please verify your email by entering this code:</p>
        <div style="background:#14141f;padding:20px;border-radius:12px;text-align:center;border:1px solid rgba(255,255,255,0.04);">
          <h2 style="font-size:36px;letter-spacing:8px;color:#00cec9;">${code}</h2>
        </div>
        <p style="color:#6a6a82;font-size:14px;">Expires in 10 minutes.</p>
        <p style="color:#6a6a82;font-size:14px;">If you didn't sign up, ignore this email.</p>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#6a6a82;font-size:12px;text-align:center;">© 2026 Nexus AI</p>
      </div>
    `,
  });
  log('info', `Verification email sent to ${email}`);
};

const sendPasswordResetEmail = async (email, code) => {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Nexus AI - Reset Your Password',
    html: `
      <div style="font-family:Arial;max-width:500px;margin:0 auto;padding:20px;background:#0b0b0e;color:#f0f0f5;border-radius:12px;">
        <h1 style="background:linear-gradient(135deg,#6c5ce7,#00cec9);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Reset Your Password</h1>
        <p style="color:#9494aa;">Enter this code to reset your password:</p>
        <div style="background:#14141f;padding:20px;border-radius:12px;text-align:center;border:1px solid rgba(255,255,255,0.04);">
          <h2 style="font-size:36px;letter-spacing:8px;color:#00cec9;">${code}</h2>
        </div>
        <p style="color:#6a6a82;font-size:14px;">Expires in 15 minutes.</p>
        <p style="color:#6a6a82;font-size:14px;">If you didn't request this, ignore it.</p>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#6a6a82;font-size:12px;text-align:center;">© 2026 Nexus AI</p>
      </div>
    `,
  });
  log('info', `Password reset email sent to ${email}`);
};

const sendDepositNotificationEmail = async (userEmail, userName, transaction, proofDataOrPath = null) => {
  const methodNames = {
    bank: 'Bank Transfer',
    credit: 'Credit Card',
    crypto: 'Cryptocurrency',
    paypal: 'PayPal'
  };

  let imageData = null;
  let imageMime = 'image/png';
  let attachment = null;

  if (proofDataOrPath) {
    if (typeof proofDataOrPath === 'string') {
      if (proofDataOrPath.startsWith('data:image')) {
        imageData = proofDataOrPath;
        const matches = proofDataOrPath.match(/^data:image\/(\w+);base64,(.+)$/);
        if (matches) {
          imageMime = `image/${matches[1]}`;
          attachment = {
            filename: `deposit-proof-${transaction.reference}.${matches[1]}`,
            content: matches[2],
            encoding: 'base64',
            contentType: imageMime,
          };
        }
      } else {
        try {
          const fileBuffer = fs.readFileSync(proofDataOrPath);
          const base64 = fileBuffer.toString('base64');
          const ext = path.extname(proofDataOrPath).toLowerCase().substring(1);
          const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif' };
          const imgType = mimeMap[ext] || 'png';
          imageData = `data:image/${imgType};base64,${base64}`;
          imageMime = `image/${imgType}`;
          attachment = {
            filename: `deposit-proof-${transaction.reference}.${ext}`,
            content: base64,
            encoding: 'base64',
            contentType: imageMime,
          };
        } catch (err) {
          console.error('Failed to read proof file:', err);
          imageData = null;
        }
      }
    }
  }

  if (!imageData) {
    imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  }

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: 'nexusai58@gmail.com',
    subject: `💰 New Deposit Request - ${userName}`,
    html: `
      <div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;background:#0b0b0e;color:#f0f0f5;border-radius:12px;">
        <h1 style="color:#fdcb6e;">💰 New Deposit Request</h1>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p><strong>User:</strong> ${userName} (${userEmail})</p>
        <p><strong>Amount:</strong> $${transaction.amount.toFixed(2)}</p>
        <p><strong>Method:</strong> ${methodNames[transaction.method] || transaction.method}</p>
        <p><strong>Reference:</strong> ${transaction.reference}</p>
        <p><strong>Transaction ID:</strong> #${transaction.id}</p>
        <p><strong>Status:</strong> Pending</p>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#9494aa;">The user has initiated a deposit.</p>
        ${proofDataOrPath ? `
          <p style="color:#9494aa;">Proof of payment is shown below:</p>
          <div style="background:#14141f;padding:12px;border-radius:8px;margin:12px 0;text-align:center;border:1px solid rgba(255,255,255,0.04);">
            <img src="${imageData}" alt="Proof of Payment" style="max-width:100%;max-height:400px;border-radius:8px;" />
          </div>
        ` : `
          <p style="color:#9494aa;">No proof uploaded yet – the user will send it separately.</p>
        `}
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#6a6a82;font-size:12px;text-align:center;">© 2026 Nexus AI</p>
      </div>
    `,
    attachments: attachment ? [attachment] : [],
  });
  log('info', `Deposit notification email sent to admin for user ${userEmail}`);
};

const sendDepositProofEmail = async (userEmail, userName, transaction, proofDataOrPath) => {
  const methodNames = {
    bank: 'Bank Transfer',
    credit: 'Credit Card',
    crypto: 'Cryptocurrency',
    paypal: 'PayPal'
  };

  let imageData = null;
  let imageMime = 'image/png';
  let attachment = null;

  if (typeof proofDataOrPath === 'string') {
    if (proofDataOrPath.startsWith('data:image')) {
      imageData = proofDataOrPath;
      const matches = proofDataOrPath.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        imageMime = `image/${matches[1]}`;
        attachment = {
          filename: `deposit-proof-${transaction.reference}.${matches[1]}`,
          content: matches[2],
          encoding: 'base64',
          contentType: imageMime,
        };
      }
    } else {
      try {
        const fileBuffer = fs.readFileSync(proofDataOrPath);
        const base64 = fileBuffer.toString('base64');
        const ext = path.extname(proofDataOrPath).toLowerCase().substring(1);
        const mimeMap = {
          jpg: 'jpeg',
          jpeg: 'jpeg',
          png: 'png',
          webp: 'webp',
          gif: 'gif'
        };
        const imgType = mimeMap[ext] || 'png';
        imageData = `data:image/${imgType};base64,${base64}`;
        imageMime = `image/${imgType}`;
        attachment = {
          filename: `deposit-proof-${transaction.reference}.${ext}`,
          content: base64,
          encoding: 'base64',
          contentType: imageMime,
        };
      } catch (err) {
        console.error('Failed to read proof file:', err);
        imageData = null;
      }
    }
  }

  if (!imageData) {
    imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  }

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: 'nexusai58@gmail.com',
    subject: `💰 New Deposit Proof - ${userName}`,
    html: `
      <div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;background:#0b0b0e;color:#f0f0f5;border-radius:12px;">
        <h1 style="color:#00cec9;">💰 New Deposit Proof Submitted</h1>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p><strong>User:</strong> ${userName} (${userEmail})</p>
        <p><strong>Amount:</strong> $${transaction.amount.toFixed(2)}</p>
        <p><strong>Method:</strong> ${methodNames[transaction.method] || transaction.method}</p>
        <p><strong>Reference:</strong> ${transaction.reference}</p>
        <p><strong>Transaction ID:</strong> #${transaction.id}</p>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#9494aa;">Proof of payment is shown below:</p>
        <div style="background:#14141f;padding:12px;border-radius:8px;margin:12px 0;text-align:center;border:1px solid rgba(255,255,255,0.04);">
          <img src="${imageData}" alt="Proof of Payment" style="max-width:100%;max-height:400px;border-radius:8px;" />
        </div>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#6a6a82;font-size:12px;text-align:center;">© 2026 Nexus AI</p>
      </div>
    `,
    attachments: attachment ? [attachment] : [],
  });
  log('info', `Deposit proof email sent for user ${userEmail}`);
};

const sendWithdrawalNotificationEmail = async (userEmail, userName, transaction) => {
  const methodNames = {
    bank: 'Bank Transfer',
    crypto: 'Cryptocurrency',
    paypal: 'PayPal'
  };

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: 'nexusai58@gmail.com',
    subject: `💸 New Withdrawal Request - ${userName}`,
    html: `
      <div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;background:#0b0b0e;color:#f0f0f5;border-radius:12px;">
        <h1 style="color:#ff6b6b;">💸 New Withdrawal Request</h1>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p><strong>User:</strong> ${userName} (${userEmail})</p>
        <p><strong>Amount:</strong> $${transaction.amount.toFixed(2)}</p>
        <p><strong>Method:</strong> ${methodNames[transaction.method] || transaction.method}</p>
        <p><strong>Address/Account:</strong> ${transaction.description.replace('Withdrawal to ', '')}</p>
        <p><strong>Reference:</strong> ${transaction.reference}</p>
        <p><strong>Transaction ID:</strong> #${transaction.id}</p>
        <p><strong>Status:</strong> Pending</p>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#9494aa;">The user has requested a withdrawal. Please review and approve/reject via admin panel.</p>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#6a6a82;font-size:12px;text-align:center;">© 2026 Nexus AI</p>
      </div>
    `,
  });
  log('info', `Withdrawal notification email sent to admin for user ${userEmail}`);
};

const sendSupportTicketEmail = async (userEmail, userName, ticket) => {
  const categoryNames = {
    general: 'General Inquiry',
    technical: 'Technical Issue',
    account: 'Account Problem',
    deposit: 'Deposit / Withdrawal',
    trading: 'Trading Issue',
    feature: 'Feature Request',
    bug: 'Bug Report',
    other: 'Other'
  };
  const priorityNames = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    urgent: 'Urgent'
  };

  let attachmentHtml = '';
  let attachmentData = null;
  if (ticket.attachment) {
    attachmentHtml = `
      <div style="background:#14141f;padding:12px;border-radius:8px;margin:12px 0;text-align:center;border:1px solid rgba(255,255,255,0.04);">
        <img src="${ticket.attachment}" alt="Attachment" style="max-width:100%;max-height:300px;border-radius:8px;" />
      </div>
    `;
    const matches = ticket.attachment.match(/^data:image\/(\w+);base64,(.+)$/);
    if (matches) {
      attachmentData = {
        filename: `support-attachment-${ticket.id}.${matches[1]}`,
        content: matches[2],
        encoding: 'base64',
        contentType: `image/${matches[1]}`
      };
    }
  }

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: 'nexusai58@gmail.com',
    subject: `🛟 New Support Ticket - ${ticket.subject}`,
    html: `
      <div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;background:#0b0b0e;color:#f0f0f5;border-radius:12px;">
        <h1 style="color:#00cec9;">🛟 New Support Ticket</h1>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p><strong>User:</strong> ${userName} (${userEmail})</p>
        <p><strong>Subject:</strong> ${ticket.subject}</p>
        <p><strong>Category:</strong> ${categoryNames[ticket.category] || ticket.category}</p>
        <p><strong>Priority:</strong> ${priorityNames[ticket.priority] || ticket.priority}</p>
        <p><strong>Ticket ID:</strong> #${ticket.id}</p>
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#9494aa;"><strong>Message:</strong></p>
        <div style="background:#14141f;padding:16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);">
          <p style="white-space:pre-wrap;color:#f0f0f5;">${ticket.message}</p>
        </div>
        ${attachmentHtml}
        <hr style="border-color:rgba(255,255,255,0.04);" />
        <p style="color:#6a6a82;font-size:12px;text-align:center;">© 2026 Nexus AI</p>
      </div>
    `,
    attachments: attachmentData ? [attachmentData] : [],
  });
  log('info', `Support ticket email sent for user ${userEmail} (Ticket #${ticket.id})`);
};

// ================================================================
// AUTH MIDDLEWARE
// ================================================================
const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please login again.' });
    }
    res.status(400).json({ error: 'Invalid token.' });
  }
};

const adminMiddleware = async (req, res, next) => {
  const userRow = await db.getAsync('SELECT isAdmin FROM users WHERE id = ?', req.user.id);
  if (!userRow || !userRow.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
};

// ================================================================
// AUTH ROUTES
// ================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, country, phone } = req.body;
    if (!name || !email || !password || !country) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await db.getAsync('SELECT id FROM users WHERE email = ?', email);
    if (existing) return res.status(400).json({ error: 'User already exists.' });

    const verificationCode = generateVerificationCode();
    const codeExpires = Math.floor(Date.now() / 1000) + 10 * 60;

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const stmt = await db.runAsync(`
      INSERT INTO users (
        name, email, password, country, phone,
        verificationCode, verificationCodeExpires, verified, balance, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 50, strftime('%s', 'now'))
    `, name, email, hashedPassword, country, phone || '', verificationCode, codeExpires);

    const userId = stmt.lastInsertRowid;

    await db.runAsync(`
      INSERT INTO transactions (userId, type, amount, status, description, reference)
      VALUES (?, 'bonus', 50, 'completed', 'Welcome bonus – $50 signup bonus', ?)
    `, userId, generateReference());

    await sendVerificationEmail(email, verificationCode);

    log('info', `New user registered: ${email} (ID: ${userId})`);
    res.status(201).json({
      message: 'Registration successful. Check your email for verification code. You received $50 signup bonus!',
      userId: userId,
    });
  } catch (error) {
    log('error', 'Registration error', error);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

    const userRow = await db.getAsync('SELECT * FROM users WHERE email = ?', email);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    const user = rowToUser(userRow);

    if (user.verified) return res.status(400).json({ error: 'Email already verified.' });
    if (user.verificationCode !== code) return res.status(400).json({ error: 'Invalid code.' });
    if (user.verificationCodeExpires < new Date()) {
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    }

    await db.runAsync(`
      UPDATE users SET verified = 1, verificationCode = NULL, verificationCodeExpires = NULL, updatedAt = strftime('%s', 'now')
      WHERE id = ?
    `, user.id);

    const updatedRow = await db.getAsync('SELECT * FROM users WHERE id = ?', user.id);
    const updatedUser = rowToUser(updatedRow);
    const token = jwt.sign(
      { id: updatedUser.id, email: updatedUser.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    log('info', `User verified: ${email} (ID: ${user.id})`);
    res.json({
      message: 'Email verified successfully!',
      token,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        country: updatedUser.country,
        phone: updatedUser.phone,
        selectedPlan: updatedUser.selectedPlan,
        balance: updatedUser.balance,
        profilePicture: updatedUser.profilePicture,
        isAdmin: updatedUser.isAdmin,
        blocked: updatedUser.blocked,
        verified: updatedUser.verified,
      },
    });
  } catch (error) {
    log('error', 'Verification error', error);
    res.status(500).json({ error: 'Server error during verification.' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const userRow = await db.getAsync('SELECT * FROM users WHERE email = ?', email);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    const user = rowToUser(userRow);

    if (user.verified) return res.status(400).json({ error: 'Email already verified.' });

    const verificationCode = generateVerificationCode();
    const codeExpires = Math.floor(Date.now() / 1000) + 10 * 60;
    await db.runAsync(`
      UPDATE users SET verificationCode = ?, verificationCodeExpires = ?, updatedAt = strftime('%s', 'now')
      WHERE id = ?
    `, verificationCode, codeExpires, user.id);

    await sendVerificationEmail(email, verificationCode);
    res.json({ message: 'New verification code sent.' });
  } catch (error) {
    log('error', 'Resend verification error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const userRow = await db.getAsync('SELECT * FROM users WHERE email = ?', email);
    if (!userRow) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = rowToUser(userRow);

    if (user.blocked) {
      return res.status(403).json({ error: 'Account blocked. Contact support.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });
    if (!user.verified) {
      return res.status(401).json({ error: 'Please verify your email before logging in.' });
    }

    await db.runAsync(`UPDATE users SET updatedAt = strftime('%s', 'now') WHERE id = ?`, user.id);

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    log('info', `User logged in: ${email} (ID: ${user.id})`);
    res.json({
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        country: user.country,
        phone: user.phone,
        selectedPlan: user.selectedPlan,
        balance: user.balance,
        profilePicture: user.profilePicture,
        isAdmin: user.isAdmin,
        blocked: user.blocked,
        verified: user.verified,
      },
    });
  } catch (error) {
    log('error', 'Login error', error);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const userRow = await db.getAsync('SELECT * FROM users WHERE email = ?', email);
    if (!userRow) {
      return res.json({ message: 'If an account exists, a reset code has been sent.' });
    }
    const user = rowToUser(userRow);

    const resetCode = generateResetCode();
    const codeExpires = Math.floor(Date.now() / 1000) + 15 * 60;
    await db.runAsync(`
      UPDATE users SET verificationCode = ?, verificationCodeExpires = ?, updatedAt = strftime('%s', 'now')
      WHERE id = ?
    `, resetCode, codeExpires, user.id);

    await sendPasswordResetEmail(email, resetCode);
    res.json({ message: 'If an account exists, a reset code has been sent.' });
  } catch (error) {
    log('error', 'Forgot password error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const userRow = await db.getAsync('SELECT * FROM users WHERE email = ?', email);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    const user = rowToUser(userRow);

    if (user.verificationCode !== code) return res.status(400).json({ error: 'Invalid reset code.' });
    if (user.verificationCodeExpires < new Date()) {
      return res.status(400).json({ error: 'Reset code expired. Request a new one.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await db.runAsync(`
      UPDATE users SET password = ?, verificationCode = NULL, verificationCodeExpires = NULL, updatedAt = strftime('%s', 'now')
      WHERE id = ?
    `, hashedPassword, user.id);

    log('info', `Password reset for user: ${email} (ID: ${user.id})`);
    res.json({ message: 'Password reset successfully. Please login with your new password.' });
  } catch (error) {
    log('error', 'Reset password error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// USER ROUTES (protected)
// ================================================================

app.get('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const userRow = await db.getAsync('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    const user = rowToUser(userRow);
    delete user.password;
    delete user.verificationCode;
    delete user.verificationCodeExpires;
    res.json(user);
  } catch (error) {
    log('error', 'Get user error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/user/update', authMiddleware, async (req, res) => {
  try {
    const { name, phone, country, profilePicture } = req.body;

    const userTableInfo = await db.allAsync("PRAGMA table_info(users)");
    const existingColumns = userTableInfo.map(c => c.name);

    const columnsToEnsure = ['profilePicture', 'updatedAt', 'selectedPlan', 'balance'];
    for (const col of columnsToEnsure) {
      if (!existingColumns.includes(col)) {
        console.log(`⚠️ Column ${col} missing – adding now...`);
        await db.execAsync(`ALTER TABLE users ADD COLUMN ${col} TEXT DEFAULT NULL`);
        console.log(`✅ Column ${col} added.`);
      }
    }

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
    if (country !== undefined) { updates.push('country = ?'); values.push(country); }
    if (profilePicture !== undefined) { updates.push('profilePicture = ?'); values.push(profilePicture); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    updates.push(`updatedAt = strftime('%s', 'now')`);
    values.push(req.user.id);

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

    const fieldNames = updates.map(u => u.split(' ')[0]).join(', ');
    console.log(`🔄 Updating user ${req.user.id} (fields: ${fieldNames})`);

    await db.runAsync(query, ...values);

    const userRow = await db.getAsync('SELECT * FROM users WHERE id = ?', req.user.id);
    const user = rowToUser(userRow);
    delete user.password;
    delete user.verificationCode;
    delete user.verificationCodeExpires;

    log('info', `Profile updated for user ${user.email} (ID: ${user.id})`);
    res.json({ message: 'Profile updated successfully.', user });
  } catch (error) {
    log('error', 'Update user error', { message: error.message, stack: error.stack, code: error.code });
    console.error('Update error details:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

app.put('/api/user/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const userRow = await db.getAsync('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    const user = rowToUser(userRow);

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Current password is incorrect.' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await db.runAsync(`
      UPDATE users SET password = ?, updatedAt = strftime('%s', 'now') WHERE id = ?
    `, hashedPassword, user.id);

    log('info', `Password changed for user ${user.email} (ID: ${user.id})`);
    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    log('error', 'Change password error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/user/transactions', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;
    let query = 'SELECT * FROM transactions WHERE userId = ?';
    const params = [req.user.id];

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    query += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const rows = await db.allAsync(query, ...params);
    const transactions = rows.map(rowToTransaction);

    let countQuery = 'SELECT COUNT(*) as total FROM transactions WHERE userId = ?';
    const countParams = [req.user.id];
    if (type) {
      countQuery += ' AND type = ?';
      countParams.push(type);
    }
    const totalRow = await db.getAsync(countQuery, ...countParams);
    const total = totalRow ? totalRow.total : 0;

    res.json({ transactions, pagination: { total, limit: parseInt(limit), offset: parseInt(offset) } });
  } catch (error) {
    log('error', 'Get transactions error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/user/balance', authMiddleware, async (req, res) => {
  try {
    const row = await db.getAsync('SELECT balance FROM users WHERE id = ?', req.user.id);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    res.json({ balance: row.balance || 0 });
  } catch (error) {
    log('error', 'Get balance error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// DEPOSIT ROUTES
// ================================================================

app.post('/api/user/deposit', authMiddleware, async (req, res) => {
    try {
        const { amount, method, proof, currency = 'USD' } = req.body;
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: 'Valid amount is required.' });
        }

        const depositAmount = parseFloat(amount);
        let usdAmount = depositAmount;

        let exchangeRate = 1;
        let originalCurrency = currency.toUpperCase();
        let originalAmount = depositAmount;
        let feePercent = 2.5;
        let feeAmount = 0;

        const rates = await getExchangeRates();

        if (originalCurrency !== 'USD') {
            const rate = rates[originalCurrency];
            if (!rate) {
                return res.status(400).json({ error: `Unsupported currency: ${originalCurrency}` });
            }
            exchangeRate = 1 / rate;
            usdAmount = depositAmount * exchangeRate;
        }

        feeAmount = usdAmount * (feePercent / 100);
        const finalUsdAmount = usdAmount - feeAmount;

        if (finalUsdAmount < 10) {
            return res.status(400).json({
                error: `Minimum deposit is $10 USD after fees. Your deposit of ${originalAmount} ${originalCurrency} is worth $${usdAmount.toFixed(2)} (after ${feePercent}% fee: $${finalUsdAmount.toFixed(2)}).`
            });
        }

        const reference = generateReference();
        const description = `Deposit via ${method || 'bank'} (${originalAmount} ${originalCurrency} → $${usdAmount.toFixed(2)} USD, fee: ${feePercent}%)`;

        const info = await db.runAsync(`
            INSERT INTO transactions (
                userId, type, amount, status, method, description, reference, proof,
                currency, originalAmount, exchangeRate, feePercent, feeAmount
            ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, req.user.id, 'deposit', finalUsdAmount, method || 'bank', description, reference, proof || null,
            originalCurrency, originalAmount, exchangeRate, feePercent, feeAmount);

        const transactionId = info.lastInsertRowid;
        const transactionRow = await db.getAsync('SELECT * FROM transactions WHERE id = ?', transactionId);
        const transaction = rowToTransaction(transactionRow);

        const userRow = await db.getAsync('SELECT name, email FROM users WHERE id = ?', req.user.id);
        if (userRow) {
            await sendDepositNotificationEmail(userRow.email, userRow.name, transaction, proof || null);
        }

        log('info', `Deposit created: ${originalAmount} ${originalCurrency} → $${finalUsdAmount} USD for user ${req.user.id}`);
        res.status(201).json({
            message: `Deposit request created. You will receive $${finalUsdAmount.toFixed(2)} USD after ${feePercent}% fee.`,
            transaction: {
                ...transaction,
                originalCurrency,
                originalAmount,
                exchangeRate,
                feePercent,
                feeAmount
            }
        });
    } catch (error) {
        log('error', 'Create deposit error', error);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ================================================================
// FLUTTERWAVE PAYMENT LINK
// ================================================================
const FLUTTERWAVE_API = 'https://api.flutterwave.com/v3/payments';

app.post('/api/deposit/flutterwave', authMiddleware, async (req, res) => {
    try {
        const { amount, currency = 'USD' } = req.body;
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: 'Valid amount is required.' });
        }

        const depositAmount = parseFloat(amount);
        const user = req.user;

        const rates = await getExchangeRates();
        let usdAmount = depositAmount;
        let exchangeRate = 1;

        if (currency.toUpperCase() !== 'USD') {
            const rate = rates[currency.toUpperCase()];
            if (!rate) {
                return res.status(400).json({ error: `Unsupported currency: ${currency}` });
            }
            usdAmount = depositAmount / rate;
            exchangeRate = 1 / rate;
        }

        const feePercent = 2.5;
        const feeAmount = usdAmount * (feePercent / 100);
        const finalUsdAmount = usdAmount - feeAmount;

        const MIN_USD = 100;
        if (finalUsdAmount < MIN_USD) {
            return res.status(400).json({
                error: `Minimum card deposit is $${MIN_USD} USD after fees. ` +
                       `Your deposit of ${depositAmount} ${currency} equals $${finalUsdAmount.toFixed(2)} USD (after ${feePercent}% fee).`
            });
        }

        const userRow = await db.getAsync('SELECT email, name FROM users WHERE id = ?', user.id);
        if (!userRow) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const reference = generateReference();
        log('info', `Flutterwave: Creating payment for reference: ${reference}, amount: ${depositAmount} ${currency}`);

        const info = await db.runAsync(`
            INSERT INTO transactions (userId, type, amount, status, method, description, reference, proof)
            VALUES (?, 'deposit', ?, 'pending', 'card', 'Flutterwave deposit', ?, ?)
        `, user.id, depositAmount, reference, 'pending');
        const transactionId = info.lastInsertRowid;

        const redirectUrl = `http://localhost:5000/api/deposit/verify/${reference}`;

        const payload = {
            tx_ref: reference,
            amount: depositAmount,
            currency: currency.toUpperCase(),
            redirect_url: redirectUrl,
            payment_options: 'card',
            customer: {
                email: userRow.email,
                name: userRow.name
            },
            customizations: {
                title: 'Nexus Deposit',
                description: `Deposit $${depositAmount} to your Nexus account`,
                logo: 'https://your-logo-url.com/logo.png'
            },
            meta: {
                userId: user.id,
                reference: reference
            }
        };

        log('info', `Flutterwave payload: ${JSON.stringify(payload)}`);

        const response = await axios.post(FLUTTERWAVE_API, payload, {
            headers: {
                'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        log('info', `Flutterwave response status: ${response.status}`);
        log('info', `Flutterwave response data: ${JSON.stringify(response.data)}`);

        if (response.data.status === 'success') {
            const paymentLink = response.data.data.link;
            log('info', `Flutterwave: Payment link created: ${paymentLink}`);
            await db.runAsync(`UPDATE transactions SET proof = ? WHERE id = ?`, paymentLink, transactionId);

            res.json({
                success: true,
                link: paymentLink,
                reference: reference,
                transaction: {
                    id: transactionId,
                    amount: depositAmount,
                    currency: currency,
                    reference: reference
                }
            });
        } else {
            log('error', `Flutterwave error response: ${JSON.stringify(response.data)}`);
            throw new Error(response.data.message || 'Flutterwave payment creation failed');
        }
    } catch (error) {
        log('error', 'Flutterwave deposit error', {
            message: error.message,
            response: error.response ? error.response.data : null,
            stack: error.stack
        });
        const errorMsg = error.response && error.response.data && error.response.data.message
            ? error.response.data.message
            : error.message;
        res.status(500).json({
            error: 'Failed to create payment link. Please try again.',
            details: errorMsg
        });
    }
});

app.get('/api/deposit/verify/:reference', authMiddleware, async (req, res) => {
    try {
        const reference = req.params.reference;
        const userId = req.user.id;

        const tx = await db.getAsync('SELECT * FROM transactions WHERE reference = ? AND userId = ?', reference, userId);

        if (!tx) {
            return res.status(404).json({ status: 'not_found', error: 'Transaction not found.' });
        }

        if (tx.status === 'completed') {
            return res.json({ status: 'completed' });
        }
        if (tx.status === 'failed' || tx.status === 'cancelled') {
            return res.json({ status: 'failed' });
        }

        try {
            const response = await axios.get(
                `https://api.flutterwave.com/v3/transactions/${reference}/verify`,
                { headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
            );
            const data = response.data;
            if (data.status === 'success' && data.data.status === 'successful') {
                await db.runAsync(`UPDATE transactions SET status = 'completed', completedAt = strftime('%s', 'now') WHERE id = ?`, tx.id);
                await db.runAsync(`UPDATE users SET balance = balance + ?, updatedAt = strftime('%s', 'now') WHERE id = ?`, tx.amount, userId);
                return res.json({ status: 'completed' });
            } else if (data.data.status === 'failed') {
                await db.runAsync(`UPDATE transactions SET status = 'failed', completedAt = strftime('%s', 'now') WHERE id = ?`, tx.id);
                return res.json({ status: 'failed' });
            } else {
                return res.json({ status: 'pending' });
            }
        } catch (apiError) {
            if (apiError.response && apiError.response.status === 400) {
                const errorData = apiError.response.data;
                if (errorData && errorData.message && errorData.message.includes('No transaction was found')) {
                    const createdAt = tx.createdAt;
                    const now = Math.floor(Date.now() / 1000);
                    const age = now - createdAt;

                    if (age < 120) {
                        log('info', `Transaction ${reference} not found on Flutterwave yet (age ${age}s), keeping as pending`);
                        return res.json({ status: 'pending' });
                    } else {
                        log('info', `Transaction ${reference} marked as failed (not found on Flutterwave after ${age}s)`);
                        await db.runAsync(`UPDATE transactions SET status = 'failed', completedAt = strftime('%s', 'now') WHERE id = ?`, tx.id);
                        return res.json({ status: 'failed', message: 'Transaction not found on Flutterwave' });
                    }
                }
            }
            throw apiError;
        }
    } catch (error) {
        log('error', 'Verification error', error);
        res.status(500).json({ error: 'Verification failed.', details: error.message });
    }
});

app.post('/api/webhooks/flutterwave', express.json(), async (req, res) => {
    try {
        const event = req.body;
        const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;

        const signature = req.headers['verif-hash'];
        if (secretHash && signature !== secretHash) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        if (event.event === 'charge.completed') {
            const txRef = event.data.tx_ref;
            const status = event.data.status;

            const tx = await db.getAsync('SELECT * FROM transactions WHERE reference = ?', txRef);
            if (!tx || tx.status === 'completed') {
                return res.status(200).send('OK');
            }

            if (status === 'successful') {
                await db.runAsync(`
                    UPDATE transactions SET status = 'completed', completedAt = strftime('%s', 'now')
                    WHERE id = ?
                `, tx.id);

                await db.runAsync(`
                    UPDATE users SET balance = balance + ?, updatedAt = strftime('%s', 'now')
                    WHERE id = ?
                `, tx.amount, tx.userId);

                log('info', `Webhook: Deposit ${tx.amount} completed for user ${tx.userId}`);

                try {
                    const user = await db.getAsync('SELECT name, email FROM users WHERE id = ?', tx.userId);
                    if (user) {
                        await sendDepositNotificationEmail(user.email, user.name, tx, null);
                        log('info', `Admin email sent for card deposit ${txRef} (user: ${user.email})`);
                    } else {
                        log('warn', `User not found for card deposit ${txRef} (userId: ${tx.userId})`);
                    }
                } catch (emailError) {
                    log('error', 'Failed to send admin email for card deposit', { error: emailError.message });
                }

            } else if (status === 'failed') {
                await db.runAsync(`
                    UPDATE transactions SET status = 'failed', completedAt = strftime('%s', 'now')
                    WHERE id = ?
                `, tx.id);
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        log('error', 'Webhook error', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

app.post('/api/user/deposit/proof/:id', authMiddleware, upload.single('proofFile'), async (req, res) => {
  try {
    const transactionId = req.params.id;

    let proofData = null;
    if (req.file) {
      const fileBuffer = fs.readFileSync(req.file.path);
      const base64 = fileBuffer.toString('base64');
      const mimeType = req.file.mimetype;
      proofData = `data:${mimeType};base64,${base64}`;
      proofData = req.file.path;
    } else if (req.body.proof) {
      proofData = req.body.proof;
    }

    if (!proofData) {
      return res.status(400).json({ error: 'Proof image is required (as file or base64).' });
    }

    const transaction = await db.getAsync('SELECT * FROM transactions WHERE id = ? AND userId = ?', transactionId, req.user.id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });
    if (transaction.status !== 'pending') return res.status(400).json({ error: 'Transaction already processed.' });
    if (transaction.type !== 'deposit') return res.status(400).json({ error: 'Not a deposit.' });

    let proofForDb = proofData;
    if (req.file) {
      const fileBuffer = fs.readFileSync(req.file.path);
      const base64 = fileBuffer.toString('base64');
      const mimeType = req.file.mimetype;
      proofForDb = `data:${mimeType};base64,${base64}`;
    }

    await db.runAsync(`
      UPDATE transactions SET proof = ?, updatedAt = strftime('%s', 'now')
      WHERE id = ?
    `, proofForDb, transactionId);

    const userRow = await db.getAsync('SELECT name, email FROM users WHERE id = ?', req.user.id);
    await sendDepositProofEmail(userRow.email, userRow.name, transaction, proofData);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    const updatedTransactionRow = await db.getAsync('SELECT * FROM transactions WHERE id = ?', transactionId);
    const updatedTransaction = rowToTransaction(updatedTransactionRow);

    log('info', `Deposit proof uploaded for transaction ${transactionId} by user ${req.user.id}`);
    res.json({
      message: 'Proof uploaded successfully! Our team will review and confirm your deposit.',
      transaction: updatedTransaction,
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    log('error', 'Upload proof error', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ================================================================
// PUBLIC CONTACT ROUTE (no auth required)
// ================================================================
app.post('/api/contact', async (req, res) => {
    try {
        const { name, email, subject, message } = req.body;

        if (!name || !email || !message) {
            return res.status(400).json({ error: 'Name, email, and message are required.' });
        }

        if (transporter) {
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: 'nexusai58@gmail.com',
                subject: `New Contact Form Submission: ${subject || 'No subject'}`,
                html: `
                    <div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;background:#0b0b0e;color:#f0f0f5;border-radius:12px;">
                        <h1 style="color:var(--accent-2);">New Contact Form Message</h1>
                        <hr style="border-color:rgba(255,255,255,0.04);" />
                        <p><strong>Name:</strong> ${name}</p>
                        <p><strong>Email:</strong> ${email}</p>
                        <p><strong>Subject:</strong> ${subject || 'N/A'}</p>
                        <hr style="border-color:rgba(255,255,255,0.04);" />
                        <p style="color:#9494aa;"><strong>Message:</strong></p>
                        <div style="background:#14141f;padding:16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);">
                            <p style="white-space:pre-wrap;color:#f0f0f5;">${message}</p>
                        </div>
                        <hr style="border-color:rgba(255,255,255,0.04);" />
                        <p style="color:#6a6a82;font-size:12px;text-align:center;">© 2026 Nexus AI</p>
                    </div>
                `
            });
        }

        log('info', `Contact form submitted by ${email} (${name})`);
        res.json({ message: 'Thank you! Your message has been sent. We\'ll get back to you shortly.' });
    } catch (error) {
        log('error', 'Contact form error', error);
        res.status(500).json({ error: 'Server error. Please try again later.' });
    }
});

app.get('/api/admin/support', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const tickets = await db.allAsync(`
      SELECT st.*, u.name as userName, u.email as userEmail
      FROM support_tickets st
      LEFT JOIN users u ON st.userId = u.id
      ORDER BY st.createdAt DESC
    `);
    res.json({ tickets });
  } catch (error) {
    log('error', 'Get admin support error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/admin/notify', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, message, type = 'info' } = req.body;
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required.' });
    }

    const users = await db.allAsync('SELECT id FROM users');
    const now = Math.floor(Date.now() / 1000);

    const insertStmt = await db.runAsync(`
      INSERT INTO notifications (userId, title, message, type, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const user of users) {
      await db.runAsync(`
        INSERT INTO notifications (userId, title, message, type, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `, user.id, title, message, type, now);
    }

    log('info', `Broadcast notification sent to ${users.length} users`);
    res.json({ message: `Notification sent to ${users.length} users.` });
  } catch (error) {
    log('error', 'Broadcast notification error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/user/notifications', authMiddleware, async (req, res) => {
  try {
    const notifications = await db.allAsync(`
      SELECT * FROM notifications
      WHERE userId = ?
      ORDER BY createdAt DESC
      LIMIT 50
    `, req.user.id);
    res.json({ notifications });
  } catch (error) {
    log('error', 'Get notifications error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/admin/users/:id/plan', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    const { planName } = req.body;
    const validPlans = ['Starter', 'Basic', 'Pro', 'Elite', 'Enterprise', 'Titan'];
    if (!validPlans.includes(planName)) {
      return res.status(400).json({ error: 'Invalid plan name.' });
    }

    const userRow = await db.getAsync('SELECT id, name, email FROM users WHERE id = ?', userId);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });

    await db.runAsync(`
      UPDATE users SET selectedPlan = ?, updatedAt = strftime('%s', 'now')
      WHERE id = ?
    `, planName, userId);

    const reference = generateReference();
    await db.runAsync(`
      INSERT INTO transactions (userId, type, amount, status, description, reference)
      VALUES (?, 'plan_purchase', 0, 'completed', 'Admin assigned plan: ' || ?, ?)
    `, userId, planName, reference);

    log('info', `Admin assigned plan ${planName} to user ${userRow.email}`);
    res.json({ message: `Plan "${planName}" assigned to user.` });
  } catch (error) {
    log('error', 'Assign plan error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/admin/deposit/:id/confirm', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const { status } = req.body;

    if (!status || !['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "completed" or "failed".' });
    }

    const transaction = await db.getAsync('SELECT * FROM transactions WHERE id = ?', transactionId);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });
    if (transaction.status !== 'pending' && transaction.status !== 'processing') {
      return res.status(400).json({ error: 'Transaction already finalized.' });
    }
    if (transaction.type !== 'deposit') return res.status(400).json({ error: 'Not a deposit.' });

    await db.runAsync(`
      UPDATE transactions SET status = ?, completedAt = strftime('%s', 'now')
      WHERE id = ?
    `, status, transactionId);

    if (status === 'completed') {
      await db.runAsync(`
        UPDATE users SET balance = balance + ?, updatedAt = strftime('%s', 'now')
        WHERE id = ?
      `, transaction.amount, transaction.userId);
    }

    const updatedTransactionRow = await db.getAsync('SELECT * FROM transactions WHERE id = ?', transactionId);
    const updatedTransaction = rowToTransaction(updatedTransactionRow);

    log('info', `Deposit ${status}: $${transaction.amount} for user ${transaction.userId}`);
    res.json({ message: `Deposit ${status} successfully.`, transaction: updatedTransaction });
  } catch (error) {
    log('error', 'Confirm deposit error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// WITHDRAWAL ROUTES (with email notification)
// ================================================================

app.post('/api/user/withdraw', authMiddleware, async (req, res) => {
    try {
        const { amount, method, address, currency = 'USD' } = req.body;
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: 'Valid amount is required.' });
        }
        if (!address) return res.status(400).json({ error: 'Address is required.' });

        const withdrawAmount = parseFloat(amount);
        const userRow = await db.getAsync('SELECT balance FROM users WHERE id = ?', req.user.id);
        if (!userRow) return res.status(404).json({ error: 'User not found.' });

        let usdAmount = withdrawAmount;
        let exchangeRate = 1;
        let targetCurrency = currency.toUpperCase();
        let feePercent = 5;
        let feeAmount = 0;

        if (targetCurrency !== 'USD') {
            const rates = await getExchangeRates();
            const rate = rates[targetCurrency];
            if (!rate) {
                return res.status(400).json({ error: `Unsupported currency: ${targetCurrency}` });
            }
            exchangeRate = rate;
            usdAmount = withdrawAmount / exchangeRate;
        }

        feeAmount = usdAmount * (feePercent / 100);
        const totalUsdRequired = usdAmount + feeAmount;

        if (totalUsdRequired > userRow.balance) {
            return res.status(400).json({
                error: `Insufficient balance. Need $${totalUsdRequired.toFixed(2)} USD (${withdrawAmount} ${targetCurrency} + ${feePercent}% fee).`,
                balance: userRow.balance,
                required: totalUsdRequired,
                shortfall: totalUsdRequired - userRow.balance
            });
        }

        const reference = generateReference();
        const description = `Withdrawal to ${address} (${withdrawAmount} ${targetCurrency})`;

        const info = await db.runAsync(`
            INSERT INTO transactions (
                userId, type, amount, status, method, description, reference,
                currency, originalAmount, exchangeRate, feePercent, feeAmount
            ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
        `, req.user.id, 'withdrawal', usdAmount, method || 'bank', description, reference,
            targetCurrency, withdrawAmount, exchangeRate, feePercent, feeAmount);

        const transactionId = info.lastInsertRowid;
        const transactionRow = await db.getAsync('SELECT * FROM transactions WHERE id = ?', transactionId);
        const transaction = rowToTransaction(transactionRow);

        const userData = await db.getAsync('SELECT name, email FROM users WHERE id = ?', req.user.id);
        if (userData) {
            await sendWithdrawalNotificationEmail(userData.email, userData.name, transaction);
        }

        log('info', `Withdrawal created: ${withdrawAmount} ${targetCurrency} ($${usdAmount} USD + ${feePercent}% fee) for user ${req.user.id}`);
        res.status(201).json({
            message: `Withdrawal request submitted. You will receive ${withdrawAmount.toFixed(2)} ${targetCurrency} ($${usdAmount.toFixed(2)} USD - ${feePercent}% fee).`,
            transaction: {
                ...transaction,
                targetCurrency,
                originalAmount: withdrawAmount,
                exchangeRate,
                feePercent,
                feeAmount
            }
        });
    } catch (error) {
        log('error', 'Create withdrawal error', error);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.put('/api/admin/withdraw/:id/confirm', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const { status } = req.body;
    if (!status || !['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "completed" or "failed".' });
    }

    const transaction = await db.getAsync('SELECT * FROM transactions WHERE id = ?', transactionId);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });
    if (transaction.status !== 'pending') return res.status(400).json({ error: 'Already processed.' });
    if (transaction.type !== 'withdrawal') return res.status(400).json({ error: 'Not a withdrawal.' });

    await db.runAsync(`
      UPDATE transactions SET status = ?, completedAt = strftime('%s', 'now')
      WHERE id = ?
    `, status, transactionId);

    if (status === 'completed') {
      await db.runAsync(`
        UPDATE users SET balance = balance - ?, updatedAt = strftime('%s', 'now')
        WHERE id = ?
      `, transaction.amount, transaction.userId);
    }

    const updatedTransactionRow = await db.getAsync('SELECT * FROM transactions WHERE id = ?', transactionId);
    const updatedTransaction = rowToTransaction(updatedTransactionRow);

    log('info', `Withdrawal ${status}: $${transaction.amount} for user ${transaction.userId}`);
    res.json({ message: `Withdrawal ${status} successfully.`, transaction: updatedTransaction });
  } catch (error) {
    log('error', 'Confirm withdrawal error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// PLAN PURCHASE ROUTE
// ================================================================

app.post('/api/plans/select', authMiddleware, async (req, res) => {
  try {
    const { planName } = req.body;
    const validPlans = ['Starter', 'Basic', 'Pro', 'Elite', 'Enterprise', 'Titan'];
    if (!validPlans.includes(planName)) {
      return res.status(400).json({ error: 'Invalid plan name.' });
    }

    const planConfig = PLAN_CONFIG[planName];
    if (!planConfig) {
      return res.status(400).json({ error: 'Plan not found.' });
    }
    const price = planConfig.price;

    const userRow = await db.getAsync('SELECT id, name, email, balance, selectedPlan FROM users WHERE id = ?', req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });

    const currentPlan = userRow.selectedPlan;
    if (currentPlan) {
      const currentLevel = PLAN_ORDER[currentPlan];
      const newLevel = PLAN_ORDER[planName];
      if (!newLevel) {
        return res.status(400).json({ error: 'Invalid plan order.' });
      }
      if (newLevel < currentLevel) {
        return res.status(400).json({
          error: `You cannot downgrade from ${currentPlan} to ${planName}. Only upgrades are allowed.`
        });
      }
      if (newLevel === currentLevel) {
        return res.status(400).json({ error: `You are already on the ${currentPlan} plan.` });
      }
    }

    const currentBalance = userRow.balance || 0;

    if (currentBalance < price) {
      return res.status(400).json({
        error: 'Insufficient balance.',
        required: price,
        available: currentBalance,
        shortfall: price - currentBalance,
      });
    }

    const newBalance = currentBalance - price;
    await db.runAsync(`
      UPDATE users SET selectedPlan = ?, balance = ?, updatedAt = strftime('%s', 'now') WHERE id = ?
    `, planName, newBalance, req.user.id);

    const reference = generateReference();
    await db.runAsync(`
      INSERT INTO transactions (userId, type, amount, status, description, reference)
      VALUES (?, 'plan_purchase', ?, 'completed', 'Plan purchase: ' || ?, ?)
    `, req.user.id, price, planName, reference);

    const updatedRow = await db.getAsync('SELECT * FROM users WHERE id = ?', req.user.id);
    const user = rowToUser(updatedRow);
    delete user.password;
    delete user.verificationCode;
    delete user.verificationCodeExpires;

    log('info', `Plan purchased: ${planName} for $${price} by user ${userRow.email} (ID: ${req.user.id})`);

    res.json({
      message: `✅ Plan "${planName}" purchased successfully for $${price}!`,
      plan: planName,
      price: price,
      previousBalance: currentBalance,
      newBalance: newBalance,
      user,
    });
  } catch (error) {
    log('error', 'Select plan error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/plans', (req, res) => {
  const plans = Object.entries(PLAN_CONFIG).map(([name, config]) => {
    const baseFeatures = {
      Starter: ['Basic AI analysis', '5 signals/day', 'Email support', 'Community forum'],
      Basic: ['Advanced AI predictions', '20 signals/day', 'Priority email', 'Real-time data', 'Backtesting'],
      Pro: ['Deep learning', '50 signals/day', 'Live chat', 'Custom alerts', 'API access', 'Multi-asset'],
      Elite: ['Institutional AI', '100+ signals', '24/7 support', 'Full API', 'Auto bots', 'Portfolio optimization', 'Risk tools'],
      Enterprise: ['Custom models', 'Unlimited signals', 'Account manager', 'White-label', 'Compliance tools', 'Multi-user', 'Custom integrations', 'SLA'],
      Titan: ['Quantum AI', 'Sentiment analysis', 'Global coverage', 'Priority features', 'Executive team', 'Custom dashboards', 'Institutional liquidity', 'Regulatory reporting']
    };
    const features = baseFeatures[name] || [];
    features.push(`Max trade per transaction: $${config.maxTrade.toLocaleString()}`);
    features.push(`Daily portfolio refreshes: ${config.refreshLimit === 999999 ? 'Unlimited' : config.refreshLimit}`);
    if (config.cashbackPercent > 0) {
      features.push(`Get ${config.cashbackPercent}% cashback on every trade`);
    }
    return {
      name,
      price: config.price,
      currency: '$',
      period: '/mo',
      maxTrade: config.maxTrade,
      refreshLimit: config.refreshLimit,
      cashbackPercent: config.cashbackPercent,
      features
    };
  });
  res.json(plans);
});

// ================================================================
// REFRESH PORTFOLIO ENDPOINT (with daily limit)
// ================================================================
app.get('/api/user/refresh-portfolio', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const userRow = await db.getAsync('SELECT selectedPlan FROM users WHERE id = ?', userId);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    const planName = userRow.selectedPlan || 'Starter';
    const planConfig = PLAN_CONFIG[planName];
    if (!planConfig) {
      return res.status(400).json({ error: 'Invalid plan.' });
    }

    const limit = planConfig.refreshLimit;
    const check = await checkAndIncrementDailyLimit(userId, 'refresh_portfolio', limit);
    if (!check.allowed) {
      return res.status(429).json({
        error: `Daily refresh limit reached (${limit} per day). Please upgrade your plan for more refreshes.`,
        used: check.used,
        limit: check.limit,
        resetAt: new Date(new Date().toISOString().split('T')[0] + 'T00:00:00.000Z').toISOString()
      });
    }

    const holdingsRows = await db.allAsync('SELECT * FROM holdings WHERE userId = ?', userId);
    if (holdingsRows.length === 0) {
      return res.json({
        holdings: [],
        totalValue: 0,
        refreshCount: check.used,
        limit: check.limit,
        message: 'No holdings to refresh.'
      });
    }

    const symbols = holdingsRows.map(h => h.symbol);
    const prices = await getCryptoPrices(symbols);

    const holdings = holdingsRows.map(h => ({
      symbol: h.symbol,
      amount: h.amount,
      averagePrice: h.averagePrice,
      currentPrice: prices[h.symbol] || 0,
      value: (prices[h.symbol] || 0) * h.amount,
      profitLoss: ((prices[h.symbol] || 0) - h.averagePrice) * h.amount,
    }));

    const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);

    res.json({
      holdings,
      totalValue,
      refreshCount: check.used,
      limit: check.limit,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    log('error', 'Refresh portfolio error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// HOLDINGS & TRADING ROUTES (Buy & Sell)
// ================================================================

app.get('/api/user/holdings', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const holdingsRows = await db.allAsync('SELECT * FROM holdings WHERE userId = ?', userId);
    if (holdingsRows.length === 0) {
      return res.json({ holdings: [], totalValue: 0 });
    }

    const symbols = holdingsRows.map(h => h.symbol);
    const prices = await getCryptoPrices(symbols);

    const holdings = holdingsRows.map(h => ({
      symbol: h.symbol,
      amount: h.amount,
      averagePrice: h.averagePrice,
      currentPrice: prices[h.symbol] || 0,
      value: (prices[h.symbol] || 0) * h.amount,
      profitLoss: ((prices[h.symbol] || 0) - h.averagePrice) * h.amount,
    }));

    const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);

    res.json({ holdings, totalValue });
  } catch (error) {
    log('error', 'Get holdings error', { message: error.message, stack: error.stack });
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/user/buy', authMiddleware, async (req, res) => {
  try {
    const { symbol, amountUSD } = req.body;
    if (!symbol || !amountUSD || amountUSD <= 0) {
      return res.status(400).json({ error: 'Symbol and positive amount are required.' });
    }

    if (!SUPPORTED_SYMBOLS.includes(symbol)) {
      return res.status(400).json({ error: 'Unsupported crypto symbol.' });
    }

    const userRow = await db.getAsync('SELECT id, balance, selectedPlan FROM users WHERE id = ?', req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    if (!userRow.selectedPlan) {
      return res.status(400).json({ error: 'You must purchase a plan before trading.' });
    }

    const planConfig = PLAN_CONFIG[userRow.selectedPlan];
    if (!planConfig) {
      return res.status(400).json({ error: 'Invalid plan. Please contact support.' });
    }

    const minTrade = 150;
    if (amountUSD < minTrade) {
      return res.status(400).json({ error: `Minimum trade is $${minTrade}.` });
    }

    if (amountUSD > planConfig.maxTrade) {
      return res.status(400).json({
        error: `Your current plan (${userRow.selectedPlan}) allows a maximum trade of $${planConfig.maxTrade}. Please upgrade to trade larger amounts.`
      });
    }

    if (userRow.balance < amountUSD) {
      return res.status(400).json({ error: 'Insufficient balance.' });
    }

    const prices = await getCryptoPrices([symbol]);
    if (!prices[symbol]) {
      return res.status(500).json({ error: 'Price data unavailable for this asset.' });
    }
    const price = prices[symbol];
    const cryptoAmount = amountUSD / price;

    const newBalance = userRow.balance - amountUSD;

    await db.runAsync(`UPDATE users SET balance = ?, updatedAt = strftime('%s', 'now') WHERE id = ?`, newBalance, req.user.id);
    console.log(`[buy] User ${req.user.id} balance updated to ${newBalance}`);

    const existing = await db.getAsync('SELECT * FROM holdings WHERE userId = ? AND symbol = ?', req.user.id, symbol);

    let holdingsUpdated = false;
    try {
      if (existing) {
        const totalAmount = existing.amount + cryptoAmount;
        const totalCost = (existing.amount * existing.averagePrice) + amountUSD;
        const newAvg = totalCost / totalAmount;
        await db.runAsync(`
          UPDATE holdings SET amount = ?, averagePrice = ?, updatedAt = strftime('%s', 'now')
          WHERE userId = ? AND symbol = ?
        `, totalAmount, newAvg, req.user.id, symbol);
        console.log(`[buy] Updated holdings for ${symbol}: amount=${totalAmount}, avg=${newAvg}`);
      } else {
        await db.runAsync(`
          INSERT INTO holdings (userId, symbol, amount, averagePrice, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
        `, req.user.id, symbol, cryptoAmount, price);
        console.log(`[buy] Inserted new holding for ${symbol}: amount=${cryptoAmount}, price=${price}`);
      }
      holdingsUpdated = true;
    } catch (holdingsError) {
      console.error('[buy] Holdings update failed:', holdingsError);
      throw new Error('Failed to update holdings: ' + holdingsError.message);
    }

    const reference = generateReference();
    await db.runAsync(`
      INSERT INTO transactions (userId, type, amount, status, description, reference)
      VALUES (?, 'trade', ?, 'completed', 'Buy ${symbol} with $${amountUSD}', ?)
    `, req.user.id, amountUSD, reference);

    let cashbackAmount = 0;
    let finalBalance = newBalance;
    if (planConfig.cashbackPercent > 0) {
      cashbackAmount = amountUSD * (planConfig.cashbackPercent / 100);
      finalBalance = newBalance + cashbackAmount;
      await db.runAsync(`UPDATE users SET balance = ?, updatedAt = strftime('%s', 'now') WHERE id = ?`, finalBalance, req.user.id);
      const bonusRef = generateReference();
      await db.runAsync(`
        INSERT INTO transactions (userId, type, amount, status, description, reference)
        VALUES (?, 'bonus', ?, 'completed', 'Trading cashback (${planConfig.cashbackPercent}%) on $${amountUSD}', ?)
      `, req.user.id, cashbackAmount, bonusRef);
      console.log(`[buy] Cashback ${cashbackAmount} credited to user ${req.user.id}`);
    }

    const updatedUserRow = await db.getAsync('SELECT * FROM users WHERE id = ?', req.user.id);
    const updatedUser = rowToUser(updatedUserRow);
    delete updatedUser.password;
    delete updatedUser.verificationCode;
    delete updatedUser.verificationCodeExpires;

    const updatedHoldings = await db.allAsync('SELECT * FROM holdings WHERE userId = ?', req.user.id);
    const symbols = updatedHoldings.map(h => h.symbol);
    const currentPrices = await getCryptoPrices(symbols);
    const holdingsWithPrice = updatedHoldings.map(h => ({
      symbol: h.symbol,
      amount: h.amount,
      averagePrice: h.averagePrice,
      currentPrice: currentPrices[h.symbol] || 0,
      value: (currentPrices[h.symbol] || 0) * h.amount,
      profitLoss: ((currentPrices[h.symbol] || 0) - h.averagePrice) * h.amount,
    }));

    log('info', `User ${req.user.id} bought ${cryptoAmount} ${symbol} for $${amountUSD}, cashback: $${cashbackAmount}`);

    res.json({
      message: `✅ Bought ${cryptoAmount.toFixed(6)} ${symbol} for $${amountUSD.toFixed(2)} at $${price.toFixed(2)} per coin.`,
      newBalance: finalBalance,
      cryptoAmount,
      price,
      cashback: cashbackAmount,
      user: updatedUser,
      holdings: holdingsWithPrice,
    });
  } catch (error) {
    console.error('[buy] Unhandled error:', error);
    log('error', 'Buy crypto error', { message: error.message, code: error.code, stack: error.stack });
    if (error.code === 'SQLITE_ERROR') {
      return res.status(500).json({ error: 'Database error. Please ensure the holdings table exists and try again.' });
    }
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// --- SELL ROUTE ---
app.post('/api/user/sell', authMiddleware, async (req, res) => {
  try {
    const { symbol, amount } = req.body;

    if (!symbol || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Symbol and positive amount are required.' });
    }

    const symbolUpper = symbol.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(symbolUpper)) {
      return res.status(400).json({ error: 'Unsupported crypto symbol.' });
    }

    const userRow = await db.getAsync('SELECT id, balance, selectedPlan FROM users WHERE id = ?', req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });

    const holding = await db.getAsync('SELECT * FROM holdings WHERE userId = ? AND symbol = ?', req.user.id, symbolUpper);
    if (!holding) {
      return res.status(400).json({ error: `You don't own any ${symbolUpper}.` });
    }

    if (holding.amount < amount) {
      return res.status(400).json({
        error: `Insufficient ${symbolUpper} balance. You have ${holding.amount.toFixed(6)}, trying to sell ${amount.toFixed(6)}.`
      });
    }

    const prices = await getCryptoPrices([symbolUpper]);
    if (!prices[symbolUpper]) {
      return res.status(500).json({ error: 'Price data unavailable for this asset.' });
    }
    const price = prices[symbolUpper];
    const usdValue = amount * price;

    const newAmount = holding.amount - amount;

    if (newAmount <= 0.000001) {
      await db.runAsync('DELETE FROM holdings WHERE userId = ? AND symbol = ?', req.user.id, symbolUpper);
    } else {
      await db.runAsync(`
        UPDATE holdings SET amount = ?, updatedAt = strftime('%s', 'now')
        WHERE userId = ? AND symbol = ?
      `, newAmount, req.user.id, symbolUpper);
    }

    const newBalance = userRow.balance + usdValue;
    await db.runAsync(`UPDATE users SET balance = ?, updatedAt = strftime('%s', 'now') WHERE id = ?`, newBalance, req.user.id);

    const reference = generateReference();
    await db.runAsync(`
      INSERT INTO transactions (userId, type, amount, status, description, reference)
      VALUES (?, 'trade', ?, 'completed', 'Sell ${amount.toFixed(6)} ${symbolUpper} for $${usdValue.toFixed(2)}', ?)
    `, req.user.id, usdValue, reference);

    const updatedUserRow = await db.getAsync('SELECT * FROM users WHERE id = ?', req.user.id);
    const updatedUser = rowToUser(updatedUserRow);
    delete updatedUser.password;
    delete updatedUser.verificationCode;
    delete updatedUser.verificationCodeExpires;

    log('info', `User ${req.user.id} sold ${amount} ${symbolUpper} for $${usdValue}`);

    res.json({
      message: `✅ Sold ${amount.toFixed(6)} ${symbolUpper} for $${usdValue.toFixed(2)} at $${price.toFixed(2)} per coin.`,
      newBalance,
      usdValue,
      price,
      remainingAmount: newAmount > 0 ? newAmount : 0,
      user: updatedUser,
    });
  } catch (error) {
    log('error', 'Sell crypto error', { message: error.message, stack: error.stack });
    res.status(500).json({ error: 'Server error. Please try again later.' });
  }
});

// --- SELL PREVIEW (optional) ---
app.get('/api/user/sell-preview', authMiddleware, async (req, res) => {
  try {
    const { symbol, amount } = req.query;
    if (!symbol || !amount) {
      return res.status(400).json({ error: 'Symbol and amount are required.' });
    }

    const symbolUpper = symbol.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(symbolUpper)) {
      return res.status(400).json({ error: 'Unsupported symbol.' });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number.' });
    }

    const holding = await db.getAsync('SELECT amount FROM holdings WHERE userId = ? AND symbol = ?', req.user.id, symbolUpper);
    if (!holding || holding.amount < amountNum) {
      return res.status(400).json({
        error: 'Insufficient balance.',
        available: holding ? holding.amount : 0,
        requested: amountNum
      });
    }

    const prices = await getCryptoPrices([symbolUpper]);
    if (!prices[symbolUpper]) {
      return res.status(500).json({ error: 'Price unavailable.' });
    }

    const usdValue = amountNum * prices[symbolUpper];

    res.json({
      symbol: symbolUpper,
      amount: amountNum,
      price: prices[symbolUpper],
      usdValue: usdValue,
      available: holding.amount
    });
  } catch (error) {
    log('error', 'Sell preview error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// SUPPORT ROUTES
// ================================================================

app.post('/api/user/support', authMiddleware, async (req, res) => {
  try {
    const { subject, category, priority, message, attachment } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required.' });
    }

    const validCategories = ['general', 'technical', 'account', 'deposit', 'trading', 'feature', 'bug', 'other'];
    const validPriorities = ['low', 'medium', 'high', 'urgent'];

    const ticketCategory = validCategories.includes(category) ? category : 'general';
    const ticketPriority = validPriorities.includes(priority) ? priority : 'medium';

    const info = await db.runAsync(`
      INSERT INTO support_tickets (userId, subject, category, priority, message, attachment, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
    `, req.user.id, subject, ticketCategory, ticketPriority, message, attachment || null);
    const ticketId = info.lastInsertRowid;

    const ticketRow = await db.getAsync('SELECT * FROM support_tickets WHERE id = ?', ticketId);
    const ticket = ticketRow;

    const userRow = await db.getAsync('SELECT name, email FROM users WHERE id = ?', req.user.id);
    if (userRow) {
      await sendSupportTicketEmail(userRow.email, userRow.name, ticket);
    }

    log('info', `Support ticket created: ${subject} for user ${req.user.id} (ID: ${ticketId})`);

    res.status(201).json({
      message: 'Support request sent successfully! We\'ll get back to you within 24 hours.',
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        createdAt: new Date(ticket.createdAt * 1000)
      }
    });
  } catch (error) {
    log('error', 'Support ticket error', error);
    res.status(500).json({ error: 'Server error. Please try again later.' });
  }
});

app.get('/api/user/support', authMiddleware, async (req, res) => {
  try {
    const tickets = await db.allAsync(`
      SELECT id, subject, category, priority, status, message, adminReply, createdAt, updatedAt
      FROM support_tickets
      WHERE userId = ?
      ORDER BY createdAt DESC
    `, req.user.id);

    res.json({
      tickets: tickets.map(t => ({
        ...t,
        createdAt: new Date(t.createdAt * 1000),
        updatedAt: new Date(t.updatedAt * 1000)
      }))
    });
  } catch (error) {
    log('error', 'Get support tickets error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/admin/support/:id/reply', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reply, status } = req.body;
    const ticketId = req.params.id;

    if (!reply) {
      return res.status(400).json({ error: 'Reply message is required.' });
    }

    const ticket = await db.getAsync('SELECT * FROM support_tickets WHERE id = ?', ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    const newStatus = status || ticket.status;
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    const finalStatus = validStatuses.includes(newStatus) ? newStatus : ticket.status;

    await db.runAsync(`
      UPDATE support_tickets
      SET adminReply = ?, status = ?, updatedAt = strftime('%s', 'now')
      WHERE id = ?
    `, reply, finalStatus, ticketId);

    const updatedTicket = await db.getAsync('SELECT * FROM support_tickets WHERE id = ?', ticketId);

    log('info', `Support ticket ${ticketId} replied by admin`);
    res.json({
      message: 'Reply sent successfully.',
      ticket: {
        ...updatedTicket,
        createdAt: new Date(updatedTicket.createdAt * 1000),
        updatedAt: new Date(updatedTicket.updatedAt * 1000)
      }
    });
  } catch (error) {
    log('error', 'Admin reply error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// ADMIN ROUTES
// ================================================================

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const rows = await db.allAsync(`
      SELECT id, name, email, country, phone, selectedPlan, balance, profilePicture, isAdmin, blocked, verified, createdAt
      FROM users ORDER BY createdAt DESC
    `);
    res.json(rows.map(r => ({ ...r, createdAt: new Date(r.createdAt * 1000) })));
  } catch (error) {
    log('error', 'Get admin users error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const row = await db.getAsync(`
      SELECT id, name, email, country, phone, selectedPlan, balance, profilePicture, isAdmin, blocked, verified, createdAt
      FROM users WHERE id = ?
    `, req.params.id);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    res.json({ ...row, createdAt: new Date(row.createdAt * 1000) });
  } catch (error) {
    log('error', 'Get admin user error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await db.getAsync('SELECT COUNT(*) as count FROM users');
    const verifiedUsers = await db.getAsync('SELECT COUNT(*) as count FROM users WHERE verified = 1');
    const blockedUsers = await db.getAsync('SELECT COUNT(*) as count FROM users WHERE blocked = 1');
    const totalBalance = await db.getAsync('SELECT SUM(balance) as total FROM users');
    const plans = await db.allAsync(`
      SELECT selectedPlan, COUNT(*) as count
      FROM users
      WHERE selectedPlan IS NOT NULL
      GROUP BY selectedPlan
    `);

    const recentTransactions = await db.allAsync('SELECT * FROM transactions ORDER BY createdAt DESC LIMIT 20');
    const deposits = await db.getAsync('SELECT SUM(amount) as total FROM transactions WHERE type = "deposit" AND status = "completed"');
    const withdrawals = await db.getAsync('SELECT SUM(amount) as total FROM transactions WHERE type = "withdrawal" AND status = "completed"');

    res.json({
      users: {
        total: totalUsers ? totalUsers.count : 0,
        verified: verifiedUsers ? verifiedUsers.count : 0,
        blocked: blockedUsers ? blockedUsers.count : 0,
      },
      finances: {
        totalBalance: totalBalance ? totalBalance.total || 0 : 0,
        totalDeposits: deposits ? deposits.total || 0 : 0,
        totalWithdrawals: withdrawals ? withdrawals.total || 0 : 0,
      },
      plans: plans.map(p => ({ plan: p.selectedPlan, count: p.count })),
      recentTransactions: recentTransactions.map(rowToTransaction),
    });
  } catch (error) {
    log('error', 'Get admin stats error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/admin/users/:id/block', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { block } = req.body;
    if (typeof block !== 'boolean') return res.status(400).json({ error: 'Block must be true/false.' });

    const userId = req.params.id;
    const userRow = await db.getAsync('SELECT id FROM users WHERE id = ?', userId);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });

    await db.runAsync(`
      UPDATE users SET blocked = ?, updatedAt = strftime('%s', 'now') WHERE id = ?
    `, block ? 1 : 0, userId);

    const user = await db.getAsync('SELECT name, email FROM users WHERE id = ?', userId);
    log('info', `User ${block ? 'blocked' : 'unblocked'}: ${user.email} (ID: ${userId})`);
    res.json({ message: `User ${block ? 'blocked' : 'unblocked'} successfully.` });
  } catch (error) {
    log('error', 'Block user error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/admin/users/:id/balance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { balance } = req.body;
    if (typeof balance !== 'number' || balance < 0) {
      return res.status(400).json({ error: 'Invalid balance. Must be a positive number.' });
    }

    const userId = req.params.id;
    const userRow = await db.getAsync('SELECT id, name, email, balance FROM users WHERE id = ?', userId);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });

    const previousBalance = userRow.balance;
    await db.runAsync(`
      UPDATE users SET balance = ?, updatedAt = strftime('%s', 'now') WHERE id = ?
    `, balance, userId);

    const diff = balance - previousBalance;
    if (diff !== 0) {
      await db.runAsync(`
        INSERT INTO transactions (userId, type, amount, status, description, reference)
        VALUES (?, 'trade', ?, 'completed', 'Admin balance adjustment', ?)
      `, userId, Math.abs(diff), generateReference());
    }

    log('info', `Balance updated for user ${userRow.email}: $${previousBalance} -> $${balance}`);
    res.json({ message: 'Balance updated successfully.' });
  } catch (error) {
    log('error', 'Update balance error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { limit = 100, offset = 0, type, status } = req.query;
    let query = 'SELECT * FROM transactions';
    const params = [];
    const conditions = [];

    if (type) { conditions.push('type = ?'); params.push(type); }
    if (status) { conditions.push('status = ?'); params.push(status); }

    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const rows = await db.allAsync(query, ...params);
    const transactions = rows.map(rowToTransaction);

    let countQuery = 'SELECT COUNT(*) as total FROM transactions';
    if (conditions.length > 0) countQuery += ' WHERE ' + conditions.join(' AND ');
    const totalRow = await db.getAsync(countQuery, ...params.slice(0, -2));
    const total = totalRow ? totalRow.total : 0;

    res.json({ transactions, pagination: { total, limit: parseInt(limit), offset: parseInt(offset) } });
  } catch (error) {
    log('error', 'Get admin transactions error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get exchange rates for frontend
app.get('/api/exchange-rates', async (req, res) => {
    try {
        const rates = await getExchangeRates();
        res.json({ rates, timestamp: new Date().toISOString() });
    } catch (error) {
        log('error', 'Exchange rate error', error);
        res.status(500).json({ error: 'Failed to fetch exchange rates.' });
    }
});

// Reset user data (admin only or user self-reset)
app.post('/api/user/reset', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { action } = req.body;

        const validActions = ['balance', 'plan', 'holdings', 'transactions', 'profile', 'all'];
        if (!validActions.includes(action)) {
            return res.status(400).json({ error: 'Invalid reset action.' });
        }

        await db.execAsync('BEGIN TRANSACTION');
        switch (action) {
            case 'balance':
                await db.runAsync(`UPDATE users SET balance = 50, updatedAt = strftime('%s', 'now') WHERE id = ?`, userId);
                break;
            case 'plan':
                await db.runAsync(`UPDATE users SET selectedPlan = NULL, updatedAt = strftime('%s', 'now') WHERE id = ?`, userId);
                break;
            case 'holdings':
                await db.runAsync(`DELETE FROM holdings WHERE userId = ?`, userId);
                break;
            case 'transactions':
                await db.runAsync(`DELETE FROM transactions WHERE userId = ?`, userId);
                const bonusRef = generateReference();
                await db.runAsync(`
                    INSERT INTO transactions (userId, type, amount, status, description, reference, createdAt, updatedAt)
                    VALUES (?, 'bonus', 50, 'completed', 'Welcome bonus – $50 signup bonus', ?, strftime('%s', 'now'), strftime('%s', 'now'))
                `, userId, bonusRef);
                await db.runAsync(`UPDATE users SET balance = 50, updatedAt = strftime('%s', 'now') WHERE id = ?`, userId);
                break;
            case 'profile':
                await db.runAsync(`
                    UPDATE users SET profilePicture = NULL, updatedAt = strftime('%s', 'now') WHERE id = ?
                `, userId);
                break;
            case 'all':
                await db.runAsync(`DELETE FROM holdings WHERE userId = ?`, userId);
                await db.runAsync(`DELETE FROM transactions WHERE userId = ?`, userId);
                const allBonusRef = generateReference();
                await db.runAsync(`
                    INSERT INTO transactions (userId, type, amount, status, description, reference, createdAt, updatedAt)
                    VALUES (?, 'bonus', 50, 'completed', 'Welcome bonus – $50 signup bonus', ?, strftime('%s', 'now'), strftime('%s', 'now'))
                `, userId, allBonusRef);
                await db.runAsync(`
                    UPDATE users SET balance = 50, selectedPlan = NULL, profilePicture = NULL, updatedAt = strftime('%s', 'now') WHERE id = ?
                `, userId);
                break;
        }
        await db.execAsync('COMMIT');

        const userRow = await db.getAsync('SELECT * FROM users WHERE id = ?', userId);
        if (!userRow) {
            return res.status(404).json({ error: 'User not found after reset.' });
        }
        const user = rowToUser(userRow);
        delete user.password;
        delete user.verificationCode;
        delete user.verificationCodeExpires;

        const transactions = await db.allAsync('SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC', userId);

        log('info', `User ${userId} reset ${action}`);
        res.json({
            message: `Reset "${action}" successful.`,
            user,
            transactions: transactions.map(rowToTransaction),
        });
    } catch (error) {
        await db.execAsync('ROLLBACK');
        log('error', 'Reset error', error);
        res.status(500).json({ error: 'Server error during reset.' });
    }
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    const userRow = await db.getAsync('SELECT id, email FROM users WHERE id = ?', userId);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });
    if (parseInt(userId) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account.' });
    }

    await db.runAsync('DELETE FROM users WHERE id = ?', userId);
    log('info', `User deleted: ${userRow.email} (ID: ${userId})`);
    res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    log('error', 'Delete user error', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), version: '2.1.0' });
});

// ================================================================
// ERROR HANDLING
// ================================================================
app.use((err, req, res, next) => {
  log('error', 'Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({
    error: 'Something went wrong. Please try again later.',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ================================================================
// START SERVER
// ================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 API available at http://localhost:${PORT}/api`);
  console.log(`🎁 New users get $50 signup bonus!`);
  console.log(`💰 Plan prices: Starter $100, Basic $500, Pro $1500, Elite $3500, Enterprise $7500, Titan $15000`);
  console.log(`🪙 Supported crypto: ${SUPPORTED_SYMBOLS.join(', ')}`);
  console.log(`📊 Price & conversion endpoints available at /api/prices and /api/convert`);
  console.log(`🛟 Support tickets endpoint: /api/user/support`);
  console.log(`🔄 Portfolio refresh endpoint: /api/user/refresh-portfolio (respects daily limits)`);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  log('error', 'Unhandled rejection', { message: err.message, stack: err.stack });
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  log('error', 'Uncaught exception', { message: err.message, stack: err.stack });
});