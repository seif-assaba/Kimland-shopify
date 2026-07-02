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
        // VARIANTES - Depuis le sélecteur déroulant
        // =============================================
        const variants = [];
        let variantType = 'taille';
        let variantLabel = 'Taille';

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

        // Trouver le sélecteur déroulant
        const selectors = [
          'select#forSize',
          'select[name="pointure"]',
          '.form-configurable select',
          '.attribute-select',
          'select'
        ];

        let select = null;
        for (const selector of selectors) {
          select = document.querySelector(selector);
          if (select) break;
        }

        if (select) {
          const options = select.querySelectorAll('option');
          options.forEach(opt => {
            const text = cleanText(opt.textContent);
            const match = text.match(/^([\d.]+)\s*[-:]\s*(\d+)/i);
            if (match) {
              const value = match[1].trim();
              const quantity = parseInt(match[2]);
              if (value && !isNaN(quantity) && quantity > 0) {
                if (/^[\d.]+$/.test(value)) {
                  const existing = variants.find(v => v.value === value);
                  if (!existing) {
                    variants.push({ value, quantity });
                  }
                }
              }
            }
          });
        }

        // Fallback: variantes textuelles (ex: "Standard - 151")
        if (variants.length === 0) {
          const dimMatch = pageText.match(/Dimension\s*[:：]\s*([A-Za-z0-9\s]+?)\s*[-:]\s*(\d+)\s*pi[èé]ce/i);
          if (dimMatch) {
            const value = dimMatch[1].trim();
            const quantity = parseInt(dimMatch[2]);
            if (value && !isNaN(quantity) && quantity > 0) {
              variants.push({ value, quantity });
            }
          }

          if (variants.length === 0) {
            const pattern = /([A-Za-z0-9\s]+?)\s*[-:]\s*(\d+)\s*pi[èé]ce/gi;
            let match;
            while ((match = pattern.exec(pageText)) !== null) {
              const rawValue = match[1].trim();
              const quantity = parseInt(match[2]);
              if (rawValue && !isNaN(quantity) && quantity > 0) {
                const upperValue = rawValue.toUpperCase();
                if (!['VENTE', 'RENCE', 'UNITÉS', 'UNITES', 'TOTAL', 'STOCK', 
                      'DISPONIBILITÉ', 'DISPONIBILITE', 'REFERENCE', 'RÉFÉRENCE', 'CODE',
                      'GARANTIE', 'SERVICE', 'COULEUR', 'MATIÈRE', 'MATIERE',
                      'PRIX', 'VENTE', 'HT'].includes(upperValue) &&
                    !upperValue.includes('TAILLE') && !upperValue.includes('SIZE') &&
                    !upperValue.includes('POINTURE') && !upperValue.includes('DIMENSION') &&
                    !upperValue.includes('PRIX') && !upperValue.includes('VENTE')) {
                  
                  const existing = variants.find(v => v.value === rawValue);
                  if (!existing) {
                    variants.push({ value: rawValue, quantity });
                  } else if (quantity > existing.quantity) {
                    existing.quantity = quantity;
                  }
                }
              }
            }
          }
        }

        // Trier les variantes
        variants.sort((a, b) => {
          const numA = parseFloat(a.value);
          const numB = parseFloat(b.value);
          if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
          }
          return a.value.localeCompare(b.value);
        });

        const totalStock = variants.reduce((sum, v) => sum + v.quantity, 0);
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