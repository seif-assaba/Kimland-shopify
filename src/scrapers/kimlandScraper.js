const { chromium } = require('playwright');
const logger = require('../utils/logger');

class KimlandScraper {
  // ====================== SINGLETON ======================
  static instance = null;
  static initPromise = null;

  static async getInstance() {
    if (KimlandScraper.instance) {
      return KimlandScraper.instance;
    }
    if (KimlandScraper.initPromise) {
      return KimlandScraper.initPromise;
    }

    KimlandScraper.initPromise = (async () => {
      const scraper = new KimlandScraper();
      await scraper.initialize();
      KimlandScraper.instance = scraper;
      logger.info('🟢 KimlandScraper singleton ready (browser kept alive)');
      return scraper;
    })();

    return KimlandScraper.initPromise;
  }

  static async closeInstance() {
    if (KimlandScraper.instance) {
      await KimlandScraper.instance.close();
      KimlandScraper.instance = null;
      KimlandScraper.initPromise = null;
    }
  }

  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isLoggedIn = false;
    this._lock = Promise.resolve();
    this._lastLoginAt = 0;
    this._opsSinceRestart = 0;
    // Restart browser every N ops to free memory without crashing login
    this._restartEvery = Number(process.env.BROWSER_RESTART_EVERY || 12);
  }

  // ====================== INITIALIZE (low-memory, stable) ======================
  async initialize() {
    if (this.browser) return true;

    try {
      // Set PLAYWRIGHT_HEADLESS=false in .env to watch the browser live
      const isHeadless = process.env.PLAYWRIGHT_HEADLESS !== 'false';

      // NOTE: do NOT use --single-process / --no-zygote — they crash Chromium
      // ("Target page, context or browser has been closed")
      this.browser = await chromium.launch({
        headless: isHeadless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--disable-sync',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--js-flags=--max-old-space-size=192',
          '--window-size=1024,768',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars'
        ]
      });

      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'fr-FR',
        viewport: { width: 1024, height: 768 },
        javaScriptEnabled: true,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: {
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"'
        }
      });

      // Block heavy resources (keep stylesheet so login UI still works)
      await this.context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) {
          return route.abort();
        }
        return route.continue();
      });

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
      });

      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(30000);
      this.page.setDefaultNavigationTimeout(35000);

      this.isLoggedIn = false;
      this._opsSinceRestart = 0;
      logger.info(`Browser + context initialized (low-memory stable) | headless=${isHeadless}`);
      return true;
    } catch (error) {
      logger.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  // Restart Chromium every N operations to free RAM (without closing mid-login)
  async maybeRestartBrowser() {
    this._opsSinceRestart = (this._opsSinceRestart || 0) + 1;
    if (this._opsSinceRestart < this._restartEvery) return;

    logger.info(`♻️ Restarting browser after ${this._opsSinceRestart} ops (free memory)...`);
    try {
      await this.close();
    } catch (_) {}
    KimlandScraper.instance = null;
    KimlandScraper.initPromise = null;
    // Next getInstance() will create a fresh browser
  }

  // ====================== SIMPLE MUTEX ======================
  async withLock(fn) {
    const prev = this._lock;
    let resolve;
    this._lock = new Promise(r => (resolve = r));
    try {
      await prev;
      return await fn();
    } finally {
      resolve();
    }
  }

  // ====================== ENSURE READY + LOGGED IN ======================
  async ensureReady() {
    if (!this.browser || !this.browser.isConnected()) {
      logger.warn('⚠️ Browser disconnected, re-initializing...');
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isLoggedIn = false;
      await this.initialize();
    }

    if (!this.page || this.page.isClosed()) {
      logger.warn('⚠️ Page closed, creating new page...');
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(30000);
      this.page.setDefaultNavigationTimeout(35000);
      this.isLoggedIn = false;
    }

    const now = Date.now();
    if (!this.isLoggedIn || (now - this._lastLoginAt > 45 * 60 * 1000)) {
      await this.login();
    }
  }

  // ====================== LOGIN (supports Username + Email + Password) ======================
  async login() {
    this.ensureCredentials();

    try {
      await this.page.goto(process.env.KIMLAND_LOGIN_URL || 'https://kimland.dz/', {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      });
      await this.page.waitForTimeout(1500);

      const alreadyLoggedIn = await this.page.evaluate(() => {
        return !!(
          document.querySelector('a[href*="logout"]') ||
          document.querySelector('a[href*="deconnexion"]') ||
          document.querySelector('.account-info, .user-info, .my-account, .welcome')
        );
      });

      if (alreadyLoggedIn) {
        this.isLoggedIn = true;
        this._lastLoginAt = Date.now();
        logger.info('✅ Already logged in (session still valid)');
        return true;
      }
    } catch (e) {
      logger.warn('Quick login check failed, doing full login...');
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        logger.info(`🔐 Logging in to Kimland (attempt ${attempt})...`);

        await this.page.goto(process.env.KIMLAND_LOGIN_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        await this.page.waitForTimeout(2000);

        // ========== FILL ALL 3 FIELDS: USERNAME + EMAIL + PASSWORD ==========

        // 1. Username field
        const usernameSelectors = [
          'input[name="username"]',
          'input[id="username"]',
          'input[name="login"]',
          'input[id="login"]',
          'input[placeholder*="utilisateur" i]',
          'input[placeholder*="username" i]',
          'input[placeholder*="User" i]',
          'input[name="user"]',
          'input[id="user"]'
        ];

        for (const selector of usernameSelectors) {
          const el = await this.page.$(selector);
          if (el) {
            const value = process.env.KIMLAND_USERNAME || process.env.KIMLAND_EMAIL || '';
            if (value) {
              await el.fill(value);
              logger.info(`✅ Username filled via: ${selector} → ${value}`);
              break;
            }
          }
        }

        // 2. Email field
        const emailSelectors = [
          'input[type="email"]',
          'input[name="email"]',
          'input[id="email"]',
          'input[placeholder*="email" i]',
          'input[placeholder*="Email"]',
          'input[placeholder*="mail" i]'
        ];

        for (const selector of emailSelectors) {
          const el = await this.page.$(selector);
          if (el) {
            const alreadyFilled = await el.evaluate(node => node.value && node.value.length > 0);
            if (!alreadyFilled) {
              const value = process.env.KIMLAND_EMAIL || process.env.KIMLAND_USERNAME || '';
              if (value) {
                await el.fill(value);
                logger.info(`✅ Email filled via: ${selector} → ${value}`);
              }
            } else {
              logger.info(`✅ Email field already has value`);
            }
            break;
          }
        }

        // 3. Password
        const passwordSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          'input[id="password"]',
          'input[name="pass"]',
          'input[id="pass"]'
        ];
        for (const selector of passwordSelectors) {
          const el = await this.page.$(selector);
          if (el) {
            await el.fill(process.env.KIMLAND_PASSWORD || '');
            logger.info(`✅ Password filled via: ${selector}`);
            break;
          }
        }

        // Debug: show all input fields found
        const allInputs = await this.page.evaluate(() => {
          return Array.from(document.querySelectorAll('input')).map(i => ({
            type: i.type,
            name: i.name,
            id: i.id,
            placeholder: i.placeholder,
            value: i.value ? '***filled***' : ''
          }));
        });
        logger.info('🔍 Login form inputs found: ' + JSON.stringify(allInputs));

        // Click login button
        const loginSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Se connecter")',
          'button:has-text("Connexion")',
          'button:has-text("Login")',
          'form button'
        ];

        let clicked = false;
        for (const selector of loginSelectors) {
          try {
            const btn = await this.page.$(selector);
            if (btn) {
              await btn.click();
              clicked = true;
              break;
            }
          } catch (_) {}
        }
        if (!clicked) await this.page.keyboard.press('Enter');

        await this.page.waitForTimeout(3500);

        const success = await this.page.evaluate(() => {
          if (document.querySelector('a[href*="logout"], a[href*="deconnexion"]')) return true;
          if (document.querySelector('.account-info, .user-info, .welcome, .my-account')) return true;
          if (!document.querySelector('input[type="password"]')) return true;
          return !window.location.href.toLowerCase().includes('login');
        });

        if (success) {
          this.isLoggedIn = true;
          this._lastLoginAt = Date.now();
          logger.info('✅ Login successful! Session kept alive.');
          return true;
        }

        throw new Error('Login verification failed');
      } catch (error) {
        logger.error(`❌ Login failed on attempt ${attempt}: ${error.message}`);
        if (attempt === 2) {
          this.isLoggedIn = false;
          throw error;
        }
        await this.page.waitForTimeout(2000);
      }
    }
  }

  ensureCredentials() {
    const missing = [];
    if (!process.env.KIMLAND_LOGIN_URL) missing.push('KIMLAND_LOGIN_URL');
    if (!process.env.KIMLAND_PASSWORD) missing.push('KIMLAND_PASSWORD');

    if (!process.env.KIMLAND_EMAIL && !process.env.KIMLAND_USERNAME) {
      missing.push('KIMLAND_EMAIL or KIMLAND_USERNAME');
    }

    if (missing.length > 0) {
      throw new Error(`Missing Kimland environment variables: ${missing.join(', ')}`);
    }

    logger.info(`🔐 Login credentials: USERNAME=${process.env.KIMLAND_USERNAME || 'not set'}, EMAIL=${process.env.KIMLAND_EMAIL || 'not set'}`);
  }

  // ====================== EXTRACT PRODUCT ======================
  async extractProductFromUrl(productUrl) {
    return this.withLock(async () => {
      try {
        logger.info('📋 Extracting product from: ' + productUrl);
        await this.ensureReady();

        // Inject early price capture (before JS can overwrite the red cost price)
        await this.page.addInitScript(() => {
          window.__kimlandPriceCapture = { text: '', html: '', captured: false };

          const capture = () => {
            if (window.__kimlandPriceCapture.captured) return;
            const box = document.querySelector('.price-box') || document.querySelector('.product-info-price');
            if (box) {
              const text = (box.innerText || box.textContent || '').trim();
              if (text.includes('|') || text.includes('Prix de vente') || (text.match(/\d{1,3}[.,]\d{3}/g) || []).length >= 1) {
                window.__kimlandPriceCapture.text = text;
                window.__kimlandPriceCapture.html = box.innerHTML;
                window.__kimlandPriceCapture.captured = true;
                console.log('🔒 CAPTURED original price-box:', text);
              }
            }
          };

          const observer = new MutationObserver(capture);
          const start = () => {
            if (document.body) {
              observer.observe(document.body, { childList: true, subtree: true, characterData: true });
              let tries = 0;
              const poll = setInterval(() => {
                capture();
                tries++;
                if (window.__kimlandPriceCapture.captured || tries > 60) {
                  clearInterval(poll);
                  try { observer.disconnect(); } catch (e) {}
                }
              }, 80);
            } else {
              setTimeout(start, 30);
            }
          };
          start();
        });

        await this.page.goto(productUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 35000
        });

        await this.page.waitForTimeout(2200);

        // Force price visibility
        await this.page.evaluate(() => {
          document.querySelectorAll('.price-box, [class*="price"], .product-price, .prix').forEach(el => {
            el.style.visibility = 'visible';
            el.style.opacity = '1';
            el.style.display = 'block';
          });
        });

        try {
          await this.page.waitForFunction(() => {
            const box = document.querySelector('.price-box, .product-info-price');
            return box && /\d{1,3}[.,]?\d{3}\s*DA/.test(box.innerText || '');
          }, { timeout: 7000 });
        } catch (e) {
          logger.warn('Price box did not appear quickly, continuing...');
        }

        await this.page.waitForTimeout(600);
        await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

        // Debug screenshot
        await this.page.screenshot({ path: 'debug-scraper-view.png', fullPage: true }).catch(() => {});

        const productData = await this.page.evaluate(() => {
          // ---------- helpers ----------
          const cleanText = (text) => (text ? text.replace(/\s+/g, ' ').trim() : '');

          const parsePrice = (text) => {
            if (!text) return 0;
            let cleaned = String(text)
              .replace(/DA|DZD|dinars?|دج/gi, '')
              .replace(/\s/g, '')
              .trim();

            if (cleaned.includes(',')) {
              const parts = cleaned.split(',');
              if (parts[parts.length - 1].length === 3) {
                cleaned = cleaned.replace(/,/g, '');
              } else {
                cleaned = cleaned.replace(',', '.');
              }
            } else if (cleaned.includes('.')) {
              const parts = cleaned.split('.');
              if (parts[parts.length - 1].length === 3) {
                cleaned = cleaned.replace(/\./g, '');
              }
            }

            const num = parseFloat(cleaned);
            return isNaN(num) ? 0 : Math.round(num);
          };

          // ====================== PRICE EXTRACTION ======================
          // Handles discount products with 3 prices:
          //   <span class="price">1,600 DA</span>          ← COST (current wholesale)
          //   <span class="old-price">2,600 DA</span>      ← IGNORE (old strikethrough)
          //   <strong style="color:green">2,500 DA</strong> ← SELLING (Prix de vente)
          let costPrice = 0;
          let sellingPrice = 0;
          let oldPriceIgnored = 0;
          let debugPriceText = '';

          const extractAllPrices = (text) => {
            if (!text) return [];
            const matches = text.match(/(\d{1,3}(?:[ .,]?\d{3})*(?:[.,]\d{2})?)\s*DA/gi) || [];
            return matches
              .map(s => parsePrice(s))
              .filter(n => n > 100 && n < 1000000);
          };

          const priceBox = document.querySelector('.price-box') ||
                           document.querySelector('.product-info-price') ||
                           document.querySelector('.product-info-main');

          // ---------- PRIORITY 1: DOM structure (best for discounts) ----------
          if (priceBox) {
            debugPriceText = (priceBox.innerText || priceBox.textContent || '').trim();

            // Cost = span.price but NEVER span.old-price
            const costCandidates = priceBox.querySelectorAll('span.price, .price');
            for (const el of costCandidates) {
              if (el.classList && el.classList.contains('old-price')) continue;
              if (el.closest && el.closest('.old-price')) continue;
              // skip if this element is inside or is old-price
              const cls = (el.className || '').toString().toLowerCase();
              if (cls.includes('old-price') || cls.includes('old_price')) continue;
              const p = parsePrice(el.textContent);
              if (p > 0) {
                costPrice = p;
                break;
              }
            }

            // Explicit old-price (ignore for cost/selling, just log)
            const oldEl = priceBox.querySelector('.old-price, span.old-price, del, s, [class*="old-price"]');
            if (oldEl) {
              oldPriceIgnored = parsePrice(oldEl.textContent);
            }

            // Selling = green strong OR "Prix de vente"
            const greenStrong = priceBox.querySelector(
              'strong[style*="green"], strong[style*="color:green"], strong[style*="color: green"]'
            );
            if (greenStrong) {
              sellingPrice = parsePrice(greenStrong.textContent);
            }
            if (sellingPrice === 0) {
              // any strong after "Prix de vente" text
              const strongs = priceBox.querySelectorAll('strong');
              for (const s of strongs) {
                const p = parsePrice(s.textContent);
                if (p > 0 && p !== costPrice && p !== oldPriceIgnored) {
                  sellingPrice = p;
                  break;
                }
              }
            }
            if (sellingPrice === 0) {
              const m = debugPriceText.match(/Prix\s*de\s*vente\s*[:：]?\s*([\d\s.,]+)/i);
              if (m) sellingPrice = parsePrice(m[1]);
            }

            console.log('💰 DOM prices → cost:', costPrice, '| selling:', sellingPrice, '| old(ignored):', oldPriceIgnored);
          }

          // ---------- PRIORITY 2: Early capture text, but strip old-price numbers ----------
          if ((costPrice === 0 || sellingPrice === 0) &&
              window.__kimlandPriceCapture && window.__kimlandPriceCapture.captured) {
            let earlyText = window.__kimlandPriceCapture.text || '';
            if (!debugPriceText) debugPriceText = earlyText;

            // Remove old-price amount from text if we know it
            if (oldPriceIgnored > 0) {
              const oldStr = String(oldPriceIgnored);
              earlyText = earlyText.replace(new RegExp(oldStr.replace(/\B(?=(\d{3})+(?!\d))/g, '[,.\\s]?'), 'g'), '');
            }
            // Also remove patterns like strikethrough old prices near "old"
            earlyText = earlyText.replace(/(\d{1,3}(?:[ .,]\d{3})*)\s*DA(?=[^|]*old)/gi, '');

            const pipeMatch = earlyText.match(
              /([\d\s.,]+)\s*DA\s*\|\s*Prix\s*de\s*vente\s*[:：]?\s*([\d\s.,]+)/i
            );
            if (pipeMatch) {
              const p1 = parsePrice(pipeMatch[1]);
              const p2 = parsePrice(pipeMatch[2]);
              // p1 may still include old+new if text is "1600 2600 | Prix de vente 2500"
              // Prefer the last number before pipe as cost when multiple
              if (p1 > 0 && costPrice === 0) costPrice = p1;
              if (p2 > 0 && sellingPrice === 0) sellingPrice = p2;
            }

            // If early text has multiple numbers before pipe, take the one that is NOT old-price
            if (costPrice === 0 || (oldPriceIgnored > 0 && costPrice === oldPriceIgnored)) {
              const beforePipe = earlyText.split('|')[0] || earlyText;
              const nums = extractAllPrices(beforePipe).filter(n => n !== oldPriceIgnored);
              if (nums.length > 0) costPrice = Math.min(...nums);
            }
            if (sellingPrice === 0) {
              const m = earlyText.match(/Prix\s*de\s*vente\s*[:：]?\s*([\d\s.,]+)/i);
              if (m) sellingPrice = parsePrice(m[1]);
            }
          }

          // ---------- PRIORITY 3: Pipe on current box text (exclude old-price) ----------
          if (priceBox && (costPrice === 0 || sellingPrice === 0)) {
            // Build text WITHOUT old-price elements
            const clone = priceBox.cloneNode(true);
            clone.querySelectorAll('.old-price, del, s, [class*="old-price"]').forEach(el => el.remove());
            const cleanTextBox = (clone.innerText || clone.textContent || '').trim();

            if (sellingPrice === 0) {
              const m = cleanTextBox.match(/Prix\s*de\s*vente\s*[:：]?\s*([\d\s.,]+)/i);
              if (m) sellingPrice = parsePrice(m[1]);
            }
            if (costPrice === 0) {
              const nums = extractAllPrices(cleanTextBox.split('|')[0] || cleanTextBox)
                .filter(n => n !== sellingPrice && n !== oldPriceIgnored);
              if (nums.length > 0) costPrice = Math.min(...nums);
            }
          }

          // ---------- PRIORITY 4: Body pipe, excluding known old price ----------
          if (costPrice === 0 || sellingPrice === 0) {
            const bodyText = document.body.innerText || '';
            const m = bodyText.match(/([\d\s.,]+)\s*DA\s*\|\s*Prix\s*de\s*vente\s*[:：]?\s*([\d\s.,]+)/i);
            if (m) {
              if (sellingPrice === 0) sellingPrice = parsePrice(m[2]);
              if (costPrice === 0) {
                const leftNums = extractAllPrices(m[1] + ' DA').filter(n => n !== oldPriceIgnored && n !== sellingPrice);
                if (leftNums.length > 0) costPrice = Math.min(...leftNums);
                else {
                  const p1 = parsePrice(m[1]);
                  if (p1 > 0 && p1 !== oldPriceIgnored) costPrice = p1;
                }
              }
            }
          }

          // ---------- PRIORITY 5: min among non-old, non-selling as cost ----------
          if (costPrice === 0 && priceBox) {
            const clone = priceBox.cloneNode(true);
            clone.querySelectorAll('.old-price, del, s, [class*="old-price"]').forEach(el => el.remove());
            let nums = extractAllPrices(clone.innerText || '');
            nums = nums.filter(n => n !== sellingPrice && n !== oldPriceIgnored);
            if (nums.length > 0) costPrice = Math.min(...nums);
          }

          // ---------- Final safety ----------
          // Never use old-price as cost or selling
          if (oldPriceIgnored > 0) {
            if (costPrice === oldPriceIgnored) costPrice = 0;
            if (sellingPrice === oldPriceIgnored) sellingPrice = 0;
          }
          // Cost should usually be <= selling (wholesale)
          // Exception rare; if cost > selling and we have old, trust DOM cost already set

          if (sellingPrice === 0) {
            const m = (document.body.innerText || '').match(/Prix\s*de\s*vente\s*[:：]?\s*([\d\s.,]+)/i);
            if (m) sellingPrice = parsePrice(m[1]);
          }
          if (sellingPrice === 0 && costPrice > 0) sellingPrice = costPrice;
          if (costPrice === 0 && sellingPrice > 0) {
            costPrice = Math.round(sellingPrice * 0.52);
            console.log('⚠️ Cost not found, estimated as 52% of selling:', costPrice);
          }

          if (oldPriceIgnored > 0) {
            console.log('💰 Discount product: cost=', costPrice, 'selling=', sellingPrice, 'old(ignored)=', oldPriceIgnored);
          }

          if (window.__kimlandPriceCapture && window.__kimlandPriceCapture.captured) {
            debugPriceText = '[EARLY] ' + (window.__kimlandPriceCapture.text || '') + ' | [NOW] ' + (debugPriceText || '');
          }

          console.log(`📊 FINAL PRICES → Cost: ${costPrice} | Selling: ${sellingPrice}`);
          console.log('🔍 Capture status:', window.__kimlandPriceCapture ? window.__kimlandPriceCapture.captured : false);

          // ====================== TITLE ======================
          let title = cleanText(
            document.querySelector('h1')?.textContent ||
            document.querySelector('.page-title')?.textContent ||
            document.querySelector('.product-title')?.textContent ||
            document.querySelector('.product-name')?.textContent ||
            document.querySelector('[itemprop="name"]')?.textContent
          );

          if (!title || title.length < 5) {
            const metaTitle = document.querySelector('meta[property="og:title"]');
            if (metaTitle) title = cleanText(metaTitle.getAttribute('content'));
          }
          if (!title) title = 'Unknown Product';

          // ====================== REFERENCE ======================
          let reference = '';
          const refEl = document.querySelector(
            '.product-code, .reference, .sku, .product-ref, .product-reference, [class*="ref"]'
          );
          if (refEl) {
            reference = cleanText(refEl.textContent)
              .replace(/r[ée]f[ée]rence\s*[:：]?\s*/i, '')
              .trim();
          }
          if (!reference || reference.length < 4) {
            const refMatch =
              (document.body.innerText || '').match(/R[ée]f[ée]rence\s*[:：]\s*([A-Z0-9\-_]+)/i) ||
              title.match(/[A-Z]{2,4}[-]?\d{3,6}[-]?[A-Z0-9]{2,8}/i) ||
              (document.body.innerText || '').match(/[A-Z]{2,4}[-]?\d{3,6}[-]?[A-Z0-9]{2,8}/i);
            if (refMatch) reference = refMatch[1] || refMatch[0];
          }

          // ====================== AVAILABILITY ======================
          const availEl = document.querySelector(
            '.product-info-stock, .stock, .availability, .disponibilite, [class*="stock"]'
          );
          let availability = cleanText(availEl?.textContent) || 'En stock';
          if (/rupture|out of stock|indisponible/i.test(availability)) {
            availability = 'Rupture de stock';
          }

          // ====================== IMAGES ======================
          const images = [];
          const baseUrl = window.location.origin;

          const addImage = (rawSrc) => {
            if (!rawSrc) return;
            let src = String(rawSrc).trim();
            if (!src) return;

            if (src.startsWith('//')) src = 'https:' + src;
            else if (src.startsWith('/')) src = baseUrl + src;
            else if (!src.startsWith('http')) {
              src = baseUrl + '/' + src.replace(/^\.\//, '');
            }

            const isUpload = src.includes('upload/') || src.includes('/upload/');
            const isThumb = src.includes('/thumbs/') || src.includes('thumb') || src.includes('/slide');
            const isLogo = src.includes('logo') || src.includes('icon') || src.includes('favicon');
            const isPlaceholder = src.includes('placeholder') || src.includes('no-image');

            if (isUpload && !isThumb && !isLogo && !isPlaceholder && !images.includes(src)) {
              images.push(src);
            }
          };

          const mainImg = document.querySelector('#img_zoom');
          if (mainImg) {
            addImage(mainImg.getAttribute('data-zoom-image') || mainImg.getAttribute('src'));
          }

          document.querySelectorAll(
            '[data-zoom-image], [data-image], [data-large-image], .thumbnails a, .product_preview a, .owl-carousel a'
          ).forEach(el => {
            addImage(
              el.getAttribute('data-zoom-image') ||
              el.getAttribute('data-image') ||
              el.getAttribute('data-large-image') ||
              el.getAttribute('href')
            );
          });

          document.querySelectorAll('img').forEach(img => {
            addImage(
              img.getAttribute('data-zoom-image') ||
              img.getAttribute('data-src') ||
              img.getAttribute('data-large-image') ||
              img.getAttribute('src')
            );
          });

          const uniqueImages = [...new Set(images)];

          // ====================== VARIANTS (Sizes / Pointures / Dimensions) ======================
          // Supports: 41, 40.5, 42.5, 5-7, Standard, S, M, L, XL, etc.
          const variants = [];
          let variantType = 'taille';
          let variantLabel = 'Taille';

          const pageText = document.body.innerText;

          if (/pointure/i.test(pageText)) {
            variantType = 'pointure';
            variantLabel = 'Pointure';
          } else if (/dimension/i.test(pageText)) {
            variantType = 'dimension';
            variantLabel = 'Dimension';
          } else if (/couleur/i.test(pageText) && !/taille|pointure/i.test(pageText)) {
            variantType = 'couleur';
            variantLabel = 'Couleur';
          }

          // Helper: parse one option text into {value, quantity}
          // Supports:
          //   "2XL - 6 pièce(s)"  → 2XL / 6   (IMPORTANT: parentheses)
          //   "41 - 44 pièce(s)"  → 41 / 44
          //   "40.5 - 6 pièce(s)" → 40.5 / 6
          //   "S - 10" / "M: 45" / "Standard - 151"
          const parseVariantOption = (text) => {
            if (!text) return null;
            text = cleanText(text);
            if (!text || /choisir|select|sélection|aucune|none|^-+$/i.test(text)) return null;

            // Normalize "pièce(s)" / "pièces" / "piece(s)" noise so regex is simple
            let normalized = text
              .replace(/\s*pi[èé]ce\s*\(\s*s\s*\)/gi, '')
              .replace(/\s*pi[èé]ces?/gi, '')
              .replace(/\s*pieces?/gi, '')
              .replace(/\s*stock/gi, '')
              .replace(/\s*unités?/gi, '')
              .replace(/\s*pcs\.?/gi, '')
              .replace(/\s+/g, ' ')
              .trim();

            // "VALUE - QTY" or "VALUE – QTY" (last number = qty)
            let match = normalized.match(/^(.*?)\s*[-:–]\s*(\d+)\s*$/i);
            if (!match) {
              // original text fallback (with pièce still in string)
              match = text.match(/^(.*?)\s*[-:–]\s*(\d+)\b/i);
            }
            if (match) {
              let value = match[1].trim();
              value = value.replace(/^(taille|pointure|dimension|size|couleur)\s*[:：]?\s*/i, '').trim();
              const qty = parseInt(match[2], 10);
              // Accept 2XL, XXL, 40.5, 5-7, S, Standard, etc.
              if (value && value.length > 0 && value.length < 25 && !isNaN(qty) && qty >= 0 && qty < 10000) {
                return { value, quantity: qty };
              }
            }

            // "VALUE : QTY"
            match = normalized.match(/^(.*?)\s*[:]\s*(\d+)\s*$/i);
            if (match) {
              const value = match[1].trim();
              const qty = parseInt(match[2], 10);
              if (value && !isNaN(qty) && qty >= 0) return { value, quantity: qty };
            }

            return null;
          };

          const addVariant = (value, quantity, source) => {
            if (!value) return;
            const key = String(value).trim();
            if (!key) return;
            // Reject junk
            if (/choisir|select|prix|vente|panier|compte|unité/i.test(key)) return;
            // dedupe case-insensitive (Xl vs XL)
            if (variants.some(v => String(v.value).toLowerCase() === key.toLowerCase())) return;
            variants.push({
              value: key,
              quantity: Math.max(0, quantity || 0),
              costPrice: costPrice || 0,
              _source: source || 'unknown'
            });
          };

          // 1. Prefer ALL size-like <select> dropdowns (source of truth)
          const selectSelectors = [
            'select#forSize',
            'select[name*="taille" i]',
            'select[name*="pointure" i]',
            'select[name*="size" i]',
            'select[name*="dimension" i]',
            'select[name*="couleur" i]',
            'select.form-control',
            'select'
          ];

          let fromSelectCount = 0;
          const seenSelects = new Set();
          for (const sel of selectSelectors) {
            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(sel)); } catch (_) { nodes = []; }
            for (const el of nodes) {
              if (!el || !el.options || el.options.length < 2) continue;
              if (seenSelects.has(el)) continue;
              seenSelects.add(el);

              const rawOptions = Array.from(el.options).map(o => cleanText(o.textContent || o.innerText || ''));
              const useful = rawOptions.filter(t =>
                t && (/\d/.test(t) || /pi[èé]ce|piece|standard|unique|xxl|2xl|xl|xs/i.test(t))
              );
              if (useful.length < 1) continue;

              rawOptions.forEach(raw => {
                const parsed = parseVariantOption(raw);
                if (parsed) {
                  const before = variants.length;
                  addVariant(parsed.value, parsed.quantity, 'select');
                  if (variants.length > before) fromSelectCount++;
                }
              });
            }
          }

          // 2. Global option scan only if select gave nothing
          if (fromSelectCount === 0) {
            document.querySelectorAll('select option').forEach(opt => {
              const raw = cleanText(opt.textContent || opt.innerText || '');
              const parsed = parseVariantOption(raw);
              if (parsed) addVariant(parsed.value, parsed.quantity, 'option');
            });
          }

          // 3. Page-text regex ONLY if select failed
          //    CRITICAL: never match the "5" inside "40.5" (use (?<![\d.]) not \b)
          if (variants.length === 0) {
            const t = pageText || '';
            // Letter sizes: 2XL, XXL, S, M, L...
            const letterRe = /(?<![A-Za-z0-9])(XXL|XXXL|2XL|3XL|4XL|5XL|2XS|3XS|XXS|XXXS|XS|S|M|L|XL)(?![A-Za-z0-9])\s*[-:–]\s*(\d+)\s*pi[èé]ce/gi;
            let m;
            while ((m = letterRe.exec(t)) !== null) {
              addVariant(m[1], parseInt(m[2], 10), 'text-letter');
            }
            // Numeric sizes including decimals 40.5 — must not split 40.5 into 5
            const numRe = /(?<![\d.])(\d+(?:\.\d+)?)\s*[-:–]\s*(\d+)\s*pi[èé]ce/gi;
            while ((m = numRe.exec(t)) !== null) {
              addVariant(m[1], parseInt(m[2], 10), 'text-num');
            }
          }

          // 4. Remove ghost sizes created from decimals (e.g. "5" from "40.5")
          //    If we have "40.5" and also "5" with same qty → drop "5"
          const decimalParts = new Set();
          variants.forEach(v => {
            const s = String(v.value);
            if (/^\d+\.\d+$/.test(s)) {
              const frac = s.split('.')[1]; // "5" from "40.5"
              decimalParts.add(frac);
              decimalParts.add(s.split('.')[0]); // sometimes "40" is ok to keep if real
            }
          });
          // Only drop pure fractional ghost: value is exactly the decimal part AND
          // there exists a X.Y size ending with that part
          const cleaned = variants.filter(v => {
            const s = String(v.value);
            if (!/^\d+$/.test(s)) return true; // keep non-pure-int labels
            // If "5" and we have any "*.5" size → ghost
            for (const other of variants) {
              const o = String(other.value);
              if (/^\d+\.\d+$/.test(o) && o.endsWith('.' + s)) {
                // same qty strongly confirms ghost
                if (other.quantity === v.quantity) return false;
                // even different qty: single-digit from decimal is almost always ghost for shoe sizes
                if (s.length === 1) return false;
              }
            }
            return true;
          });
          variants.length = 0;
          cleaned.forEach(v => {
            delete v._source;
            variants.push(v);
          });

          // Sort: numbers (including decimals) first, then alphabetical
          variants.sort((a, b) => {
            const na = parseFloat(a.value);
            const nb = parseFloat(b.value);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            if (!isNaN(na)) return -1;
            if (!isNaN(nb)) return 1;
            return a.value.localeCompare(b.value, 'fr', { numeric: true });
          });

          // ====================== DESCRIPTION ======================
          const descEl = document.querySelector(
            '.description, .product-description, #description, .product-info-description, [class*="desc"]'
          );
          let description = descEl ? descEl.innerHTML : '';
          description = description
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ' ');
          description = cleanText(description);

          // ====================== PRODUCT ID ======================
          const url = window.location.href;
          const productId =
            (url.match(/\/product\/(\d+)/) || [])[1] ||
            (url.match(/id=(\d+)/) || [])[1] ||
            (url.match(/product[_-]?id=(\d+)/i) || [])[1] ||
            Date.now().toString();

          return {
            kimlandId: productId,
            url: url,
            title: title,
            reference: reference || 'N/A',
            price: sellingPrice,
            costPrice: costPrice,
            debugPriceBoxText: debugPriceText.slice(0, 400),
            availability: availability,
            images: uniqueImages,
            variantType: variantType,
            variantLabel: variantLabel,
            variants: variants,
            description: description,
            imageCount: uniqueImages.length,
            variantCount: variants.length,
            totalStock: variants.reduce((sum, v) => sum + (v.quantity || 0), 0)
          };
        });

        // Logging
        logger.info('✅ Extracted: ' + productData.title);
        logger.info('   📸 Images: ' + productData.imageCount);
        logger.info('   💰 Selling Price: ' + productData.price + ' DA');
        logger.info('   💰 Cost Price: ' + productData.costPrice + ' DA');
        logger.info('   🔍 Raw price text: ' + JSON.stringify(productData.debugPriceBoxText?.slice(0, 200)));
        logger.info('   📋 Reference: ' + productData.reference);
        logger.info(
          '   📏 Variants: ' +
            productData.variantCount +
            ' (' +
            productData.totalStock +
            ' total stock)'
        );

        if (productData.variants.length > 0) {
          logger.info('   📏 Sizes:');
          productData.variants.forEach(v => {
            logger.info(`      ${v.value}: ${v.quantity} pieces`);
          });
        }

        // Product data stays in memory only (no product-*.json on disk)
        return productData;
      } catch (error) {
        logger.error('❌ Failed to extract product:', error.message);
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
          this.isLoggedIn = false;
          this.page = null;
        }
        throw error;
      }
    });
  }

  // ====================== CLOSE ======================
  // =============================================
  // Find product page URL on Kimland by REFERENCE (SKU)
  // =============================================
  async findProductUrlByReference(reference) {
    const cleanRef = String(reference || '').trim();
    if (!cleanRef) return null;

    await this.ensureReady();

    const searchUrls = [
      `https://kimland.dz/index.php?page=products&pages=0&keyword=${encodeURIComponent(cleanRef)}`,
      `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(cleanRef)}`,
      `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(cleanRef)}&pages=0`
    ];

    for (const searchUrl of searchUrls) {
      try {
        logger.info(`🔍 Search Kimland by ref: ${cleanRef}`);
        await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this.page.waitForTimeout(2000);

        const result = await this.page.evaluate((ref) => {
          const refLower = ref.toLowerCase();
          const links = Array.from(document.querySelectorAll('a'));

          // Prefer links that look like product pages AND mention the ref
          const productHrefs = [];
          for (const link of links) {
            const href = link.href || '';
            if (!href) continue;
            const isProduct =
              href.includes('/product/') ||
              href.includes('page=product') ||
              href.includes('product.php') ||
              /\/product\/\d+/i.test(href);
            if (!isProduct) continue;

            let url = href;
            if (url.startsWith('/')) url = 'https://kimland.dz' + url;

            const text = (link.textContent || '').trim().toLowerCase();
            const parentText = (link.closest('.product, .product-item, .item, li, article, .card')?.textContent || '').toLowerCase();
            const hay = text + ' ' + parentText + ' ' + href.toLowerCase();

            productHrefs.push({ url, score: hay.includes(refLower) ? 2 : 1, text });
          }

          // Exact-ish match first
          productHrefs.sort((a, b) => b.score - a.score);
          if (productHrefs.length && productHrefs[0].score >= 2) {
            return productHrefs[0].url;
          }

          // If only one product on page, take it
          const unique = [...new Set(productHrefs.map(p => p.url.split('?')[0]))];
          if (unique.length === 1) return unique[0];
          if (productHrefs.length === 1) return productHrefs[0].url;

          // First product card
          const first = document.querySelector(
            'a[href*="/product/"], a[href*="page=product"], a[href*="product.php"]'
          );
          if (first) {
            let url = first.href;
            if (url.startsWith('/')) url = 'https://kimland.dz' + url;
            return url;
          }
          return null;
        }, cleanRef);

        if (result) {
          logger.info(`✅ Found via search: ${result}`);
          return result;
        }
      } catch (e) {
        logger.warn(`⚠️ Search attempt failed: ${e.message}`);
      }
    }

    logger.warn(`⚠️ No Kimland product found for reference: ${cleanRef}`);
    return null;
  }

  async close() {
    try {
      if (this.browser) {
        await this.browser.close();
        logger.info('Browser closed (singleton shutdown)');
      }
    } catch (e) {
      logger.warn('Error closing browser:', e.message);
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isLoggedIn = false;
      KimlandScraper.instance = null;
      KimlandScraper.initPromise = null;
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  await KimlandScraper.closeInstance();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await KimlandScraper.closeInstance();
  process.exit(0);
});

module.exports = KimlandScraper;
