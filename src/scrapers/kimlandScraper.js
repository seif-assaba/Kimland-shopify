// src/scrapers/kimlandScraper.js - Version Française

const { chromium } = require('playwright');
const fs = require('fs');
const logger = require('../utils/logger');

class KimlandScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  async initialize() {
    try {
      const isHeadless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
      this.browser = await chromium.launch({
        headless: isHeadless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
      this.page = await this.browser.newPage();
      this.page.setDefaultTimeout(30000);
      this.page.setDefaultNavigationTimeout(30000);
      await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
      logger.info('Navigateur initialisé');
      return true;
    } catch (error) {
      logger.error('Échec de l\'initialisation du navigateur:', error);
      throw error;
    }
  }

  async login() {
    if (this.isLoggedIn) return true;

    this.ensureCredentials();

    try {
      logger.info('Connexion à Kimland...');

      await this.page.goto(process.env.KIMLAND_LOGIN_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await this.page.waitForSelector('input[type="email"], input[name="email"], input[type="text"]', {
        timeout: 15000
      });

      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[id="email"]',
        'input[placeholder*="email"]',
        'input[placeholder*="Email"]'
      ];

      for (const selector of emailSelectors) {
        const element = await this.page.$(selector);
        if (element) {
          await this.page.fill(selector, process.env.KIMLAND_EMAIL);
          logger.info('✅ Email rempli');
          break;
        }
      }

      const usernameSelectors = [
        'input[name="username"]',
        'input[id="username"]',
        'input[placeholder*="Nom d\'utilisateur"]',
        'input[placeholder*="username"]',
        'input[placeholder*="utilisateur"]'
      ];

      for (const selector of usernameSelectors) {
        const element = await this.page.$(selector);
        if (element) {
          await this.page.fill(selector, process.env.KIMLAND_USERNAME);
          logger.info('✅ Nom d\'utilisateur rempli');
          break;
        }
      }

      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[id="password"]'
      ];

      for (const selector of passwordSelectors) {
        const element = await this.page.$(selector);
        if (element) {
          await this.page.fill(selector, process.env.KIMLAND_PASSWORD);
          logger.info('✅ Mot de passe rempli');
          break;
        }
      }

      const loginSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        '.login-button',
        '.btn-login'
      ];

      let loginClicked = false;
      for (const selector of loginSelectors) {
        try {
          const element = await this.page.$(selector);
          if (element) {
            await this.page.click(selector);
            loginClicked = true;
            break;
          }
        } catch (e) {}
      }

      if (!loginClicked) {
        const buttons = await this.page.$$('button');
        if (buttons.length > 0) {
          await buttons[0].click();
        }
      }

      await this.page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: 15000
      }).catch(() => {});

      const currentUrl = this.page.url();
      logger.info(`URL actuelle après connexion: ${currentUrl}`);

      if (currentUrl.includes('dashboard') || currentUrl.includes('admin') || !currentUrl.includes('login')) {
        this.isLoggedIn = true;
        logger.info('✅ Connexion réussie !');
        return true;
      }

      throw new Error('Échec de la connexion');
    } catch (error) {
      logger.error('❌ Échec de la connexion:', error.message);
      throw error;
    }
  }

  ensureCredentials() {
    const missing = ['KIMLAND_LOGIN_URL', 'KIMLAND_EMAIL', 'KIMLAND_PASSWORD'].filter(key => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Variables d'environnement Kimland manquantes: ${missing.join(', ')}`);
    }
  }

  // =============================================
  // EXTRAIRE LE PRODUIT - Version Française
  // =============================================
  async extractProductFromUrl(productUrl) {
    try {
      logger.info('📋 Extraction depuis: ' + productUrl);

      await this.page.goto(productUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await this.page.waitForTimeout(3000);
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Attendre que le sélecteur de taille soit présent
      try {
        await this.page.waitForSelector('select#forSize, select[name="pointure"], .form-configurable select', {
          timeout: 10000
        });
        logger.info('✅ Sélecteur de taille trouvé');
      } catch (e) {
        logger.warn('⚠️ Sélecteur de taille non trouvé, tentative alternative...');
      }

      const productData = await this.page.evaluate(() => {
        const cleanText = (text) => {
          if (!text) return '';
          return text.replace(/\s+/g, ' ').trim();
        };

        const parsePrice = (text) => {
          if (!text) return 0;
          let priceStr = text.replace(/[^\d,.]/g, '');
          if (priceStr.includes(',')) {
            if (!priceStr.includes('.') && priceStr.split(',')[1].length <= 2) {
              priceStr = priceStr.replace(',', '.');
            } else if (!priceStr.includes('.') && priceStr.split(',')[1].length === 3) {
              priceStr = priceStr.replace(/,/g, '');
            } else if (priceStr.includes('.')) {
              priceStr = priceStr.replace(/,/g, '');
            }
          }
          return parseFloat(priceStr) || 0;
        };

        const pageText = document.body.innerText;
        const lines = pageText.split('\n');

        // =============================================
        // TITRE
        // =============================================
        const titleEl = document.querySelector('.page-title, h1, .product-title, .product-name');
        const title = cleanText(titleEl?.textContent) || 'Produit inconnu';

        // =============================================
        // RÉFÉRENCE - depuis l'élément .product-code
        // =============================================
        let reference = '';
        
        const productCodeEl = document.querySelector('.product-code');
        if (productCodeEl) {
          let refText = cleanText(productCodeEl.textContent);
          refText = refText.replace(/r[ée]f[ée]rence\s*[:：]/i, '').trim();
          refText = refText.replace(/^["']|["']$/g, '').trim();
          if (refText && refText.length > 3) {
            reference = refText;
          }
        }

        // Fallback: essayer depuis le texte de la page
        if (!reference || reference === '') {
          const refPatterns = [
            /([A-Z]{2,4}\d{6,8}-[A-Z0-9]{3,4})/i,
            /([A-Z]{2}\d{6}-[A-Z]{4,8}\/[A-Z]{4,8})/i,
            /([A-Z]{2}\d{6}-[A-Z]{4,8})/i,
            /(S\d{5,6}-[A-Z]{2,4}\d{3,4})/i,
            /([A-Z]{2,4}\d{3,6}-[A-Z]{2,4})/i,
            /([A-Z]{2,4}\d{3,4})/i,
            /(?:REF|SKU|CODE)\s*[:：]\s*([A-Z0-9-/]{6,})/i
          ];
          
          for (const pattern of refPatterns) {
            const match = pageText.match(pattern);
            if (match) {
              reference = (match[1] || match[0]).trim();
              if (reference && reference.length > 3) break;
            }
          }
        }

        // =============================================
        // IMAGES
        // =============================================
        const images = [];
        const baseUrl = window.location.origin;

        const allImgElements = document.querySelectorAll('img');
        allImgElements.forEach(img => {
          let src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-image');
          if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            else if (src.startsWith('/')) src = baseUrl + src;
            else if (!src.startsWith('http')) src = baseUrl + '/' + src;
            
            if (src.includes('/upload/') && 
                !src.includes('/thumbs/') && 
                !src.includes('/thumb/') &&
                !src.includes('/slide/') &&
                !src.includes('/logo/') &&
                !src.includes('/icon/') &&
                !src.includes('placeholder') &&
                !src.includes('loading') &&
                !src.includes('ajax') &&
                !src.includes('loader')) {
              const cleanSrc = src.split('?')[0].split('#')[0];
              if (!images.includes(cleanSrc)) {
                images.push(cleanSrc);
              }
            }
          }
        });

        const dataElements = document.querySelectorAll('[data-zoom-image], [data-image]');
        dataElements.forEach(el => {
          let src = el.getAttribute('data-zoom-image') || el.getAttribute('data-image');
          if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            else if (src.startsWith('/')) src = baseUrl + src;
            else if (!src.startsWith('http')) src = baseUrl + '/' + src;
            
            const cleanSrc = src.split('?')[0].split('#')[0];
            if (src.includes('/upload/') && !images.includes(cleanSrc)) {
              images.push(cleanSrc);
            }
          }
        });

        const uniqueImages = [...new Set(images)];

        // =============================================
        // PRIX - Seulement le prix de vente (en vert)
        // =============================================
        let sellingPrice = 0;

        // Chercher "Prix de vente : X DA" (le prix en vert)
        const sellingMatch = pageText.match(/Prix\s*de\s*vente\s*[:：]\s*([\d,.\s]+)\s*DA/i);
        if (sellingMatch) {
          sellingPrice = parsePrice(sellingMatch[1]);
        }

        // Si non trouvé, essayer de trouver le prix dans .price-box
        if (sellingPrice === 0) {
          const priceBox = document.querySelector('.product-info-price .price-box');
          if (priceBox) {
            // Chercher le prix en vert (strong)
            const greenPrice = priceBox.querySelector('strong[style*="color:green"]');
            if (greenPrice) {
              sellingPrice = parsePrice(cleanText(greenPrice.textContent));
            }
            
            // Si pas trouvé, prendre le dernier prix
            if (sellingPrice === 0) {
              const allPrices = priceBox.querySelectorAll('.price');
              if (allPrices.length > 0) {
                // Prendre le dernier prix (qui est généralement le prix de vente)
                const lastPrice = allPrices[allPrices.length - 1];
                sellingPrice = parsePrice(cleanText(lastPrice.textContent));
              }
            }
          }
        }

        // Si toujours 0, essayer de trouver n'importe quel prix
        if (sellingPrice === 0) {
          const priceEl = document.querySelector('.price-box .price, .price, .product-price');
          if (priceEl) {
            sellingPrice = parsePrice(cleanText(priceEl.textContent));
          }
        }

        // =============================================
        // VARIANTES - Support select ET boutons
        // =============================================
        const variants = [];
        let variantType = 'taille';
        let variantLabel = 'Taille';

        // Détection du type de variante
        if (pageText.includes('Pointure') || pageText.includes('pointure')) {
          variantType = 'pointure';
          variantLabel = 'Pointure';
        } else if (pageText.includes('Dimensions') || pageText.includes('dimensions')) {
          variantType = 'dimension';
          variantLabel = 'Dimension';
        } else if (pageText.includes('Taille') || pageText.includes('taille')) {
          variantType = 'taille';
          variantLabel = 'Taille';
        }

        // --- 1. Chercher un select déroulant (cas classique) ---
        const select = document.querySelector('select#forSize, select[name="pointure"], .form-configurable select, .attribute-select, select');
        if (select) {
          const options = select.querySelectorAll('option');
          options.forEach(opt => {
            const text = cleanText(opt.textContent);
            // Format "42 - 17 pièce(s)" ou "40.5 - 6"
            const match = text.match(/^([\d.]+)\s*[-:]\s*(\d+)/);
            if (match) {
              const value = match[1].trim();
              const quantity = parseInt(match[2]);
              if (value && !isNaN(quantity) && quantity > 0) {
                if (!variants.some(v => v.value === value)) {
                  variants.push({ value, quantity });
                }
              }
            }
          });
        }

        // --- 2. Si pas de select, chercher des boutons / éléments de taille ---
        if (variants.length === 0) {
          // Sélecteurs pour les éléments de taille (boutons, swatches, etc.)
          const sizeSelectors = [
            '.size-option',
            '.swatch-option',
            '.variant-option',
            '.product-option',
            '.size-selector button',
            '.option-selector button',
            '.product-variants button',
            '.swatch-element',
            '.size-list .size-item',
            '.option-list .option',
            'button[data-size]',
            'button[data-value]',
            'li.size-option',
            'li.variant-option',
            '.product-options .option',
            '.size-options .option',
            '.variant-options .option'
          ];

          let sizeElements = [];
          for (const sel of sizeSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              sizeElements = els;
              break;
            }
          }

          // Si on a trouvé des éléments, on extrait la valeur (le texte)
          if (sizeElements.length > 0) {
            sizeElements.forEach(el => {
              let value = el.textContent.trim();
              // Nettoyer : enlever les unités (ex: "39" ou "40.5")
              // Ne garder que les nombres et points
              const cleanValue = value.match(/^[\d.]+/);
              if (cleanValue) {
                value = cleanValue[0];
                // On ne peut pas connaître la quantité ici, on la laisse à 0
                // (elle sera peut-être ailleurs, mais on fait au mieux)
                if (!variants.some(v => v.value === value)) {
                  variants.push({ value, quantity: 0 });
                }
              }
            });
          }
        }

        // --- 3. Fallback : scanner le texte de la page pour les patterns ---
        if (variants.length === 0) {
          // Patterns pour trouver des lignes comme "42 - 17" ou "40.5 - 6"
          const patterns = [
            /([\d.]+)\s*[-:]\s*(\d+)\s*pi[èé]ce/gi,
            /([\d.]+)\s*[-:]\s*(\d+)/gi
          ];
          const matches = [];
          for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(pageText)) !== null) {
              const value = match[1].trim();
              const quantity = parseInt(match[2]);
              if (value && !isNaN(quantity) && quantity > 0) {
                matches.push({ value, quantity });
              }
            }
          }
          // Déduplication
          const seen = new Set();
          for (const m of matches) {
            if (!seen.has(m.value)) {
              seen.add(m.value);
              variants.push(m);
            } else {
              // Si déjà présent, garder la plus grande quantité
              const existing = variants.find(v => v.value === m.value);
              if (existing && m.quantity > existing.quantity) {
                existing.quantity = m.quantity;
              }
            }
          }
        }

        // --- 4. Si on a des variants mais sans quantités, essayer de récupérer les quantités depuis la page ---
        if (variants.length > 0 && variants.every(v => v.quantity === 0)) {
          // Chercher un total stock ou des quantités par taille
          const stockMatch = pageText.match(/Stock\s*[:：]\s*(\d+)\s*pi[èé]ce/i);
          if (stockMatch) {
            const total = parseInt(stockMatch[1]);
            // Si une seule variante, on lui attribue le total
            if (variants.length === 1) {
              variants[0].quantity = total;
            }
            // Sinon, on ne peut pas répartir, on laisse 0.
          }
          // Sinon, on garde 0.
        }

        // Trier les variantes (numériquement)
        variants.sort((a, b) => {
          const numA = parseFloat(a.value);
          const numB = parseFloat(b.value);
          if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
          return a.value.localeCompare(b.value);
        });

        // Mettre à jour le stock total à partir des quantités
        const totalStock = variants.reduce((sum, v) => sum + (v.quantity || 0), 0);
        const productId = window.location.href.match(/\/product\/(\d+)/)?.[1] || Date.now().toString();

        return {
          kimlandId: productId,
          url: window.location.href,
          title: title,
          reference: reference || '',
          price: sellingPrice,
          images: uniqueImages,
          variantType: variantType,
          variantLabel: variantLabel,
          variants: variants,
          totalStock: totalStock || 0,
          imageCount: uniqueImages.length,
          variantCount: variants.length
        };
      });

      // =============================================
      // CORRECTION DE LA RÉFÉRENCE - si toujours vide
      // =============================================
      if (!productData.reference || productData.reference === '') {
        const urlParts = productUrl.split('/');
        const lastPart = urlParts[urlParts.length - 1] || '';
        const refMatch = lastPart.match(/([A-Z]{2}\d{6}-[A-Z]{4,8}\/[A-Z]{4,8})|([A-Z]{2}\d{6}-[A-Z]{4,8})|([A-Z]{2,4}\d{3,4})/i);
        if (refMatch) {
          productData.reference = refMatch[1] || refMatch[2] || refMatch[3];
          logger.info(`📋 Référence depuis l'URL: ${productData.reference}`);
        } else {
          productData.reference = productData.kimlandId;
          logger.warn(`⚠️ Utilisation de l'ID comme référence: ${productData.reference}`);
        }
      }

      logger.info(`✅ Extrait: ${productData.title}`);
      logger.info(`   📋 Référence: ${productData.reference}`);
      logger.info(`   💰 Prix de vente: ${productData.price} DA`);
      logger.info(`   📸 Images: ${productData.imageCount}`);
      logger.info(`   📏 Type de variante: ${productData.variantLabel} (${productData.variantType})`);
      logger.info(`   📏 Variantes: ${productData.variantCount}`);
      logger.info(`   📦 Stock total: ${productData.totalStock}`);

      if (productData.variants.length > 0) {
        logger.info('   📏 Variantes:');
        productData.variants.forEach(v => {
          logger.info(`      ${v.value}: ${v.quantity} pièces`);
        });
      }

      return productData;

    } catch (error) {
      logger.error('❌ Échec de l\'extraction du produit:', error.message);
      throw error;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.isLoggedIn = false;
      logger.info('Navigateur fermé');
    }
  }
}

module.exports = KimlandScraper;