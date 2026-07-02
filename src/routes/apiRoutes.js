// src/routes/apiRoutes.js

const express = require('express');
const router = express.Router();
const axios = require('axios');
const KimlandScraper = require('../scrapers/kimlandScraper');
const ShopifyClient = require('../shopify/shopifyClient');
const SyncStore = require('../database/syncStore');
const CSVExporter = require('../utils/csvExporter');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// =============================================
// VÉRIFICATION DE L'ÉTAT
// =============================================
router.get('/status', (req, res) => {
  res.json({
    status: 'en ligne',
    timestamp: new Date().toISOString()
  });
});

// =============================================
// RÉCUPÉRER LE DERNIER PRODUIT
// =============================================
router.get('/product', (req, res) => {
  const product = req.session.lastProduct;
  if (product) {
    res.json({ success: true, product });
  } else {
    res.json({ success: false, message: 'Aucun produit extrait' });
  }
});

// =============================================
// STOCKER LE PRODUIT DANS LA SESSION
// =============================================
router.post('/product', (req, res) => {
  const { product } = req.body;
  if (product) {
    req.session.lastProduct = product;
    res.json({ success: true, message: 'Produit stocké' });
  } else {
    res.status(400).json({ success: false, message: 'Aucun produit fourni' });
  }
});

// =============================================
// EXTRAIRE UN PRODUIT
// =============================================
router.post('/extract', async (req, res) => {
  const { url } = req.body;

  console.log('\n========================================');
  console.log('📋 Extraction du produit depuis:', url);
  console.log('========================================\n');

  if (!url) {
    return res.status(400).json({
      success: false,
      message: 'L\'URL du produit est requise'
    });
  }

  let scraper = null;

  try {
    scraper = new KimlandScraper();
    await scraper.initialize();
    await scraper.login();
    const product = await scraper.extractProductFromUrl(url);
    await scraper.close();
    
    if (product) {
      req.session.lastProduct = product;
      res.json({
        success: true,
        message: 'Produit extrait avec succès !',
        product: product
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Impossible d\'extraire le produit'
      });
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    if (scraper) await scraper.close();
    res.status(500).json({
      success: false,
      message: 'Échec de l\'extraction du produit',
      error: error.message
    });
  }
});

// =============================================
// RÉCUPÉRER UN PRODUIT KIMLAND PAR RÉFÉRENCE
// =============================================
router.post('/get-kimland-product', async (req, res) => {
  const { reference } = req.body;
  
  if (!reference) {
    return res.status(400).json({
      success: false,
      message: 'La référence est requise'
    });
  }

  let scraper = null;

  try {
    scraper = new KimlandScraper();
    await scraper.initialize();
    await scraper.login();
    
    console.log(`🔍 Recherche de: ${reference}`);
    
    const cleanRef = reference.trim();
    
    const searchUrls = [
      `https://kimland.dz/index.php?page=products&pages=0&keyword=${encodeURIComponent(cleanRef)}`,
      `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(cleanRef)}`,
      `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(cleanRef)}&pages=0`
    ];

    let productUrl = null;

    for (const searchUrl of searchUrls) {
      console.log(`📋 Essai: ${searchUrl}`);
      
      try {
        await scraper.page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        
        await scraper.page.waitForTimeout(2000);
        
        const productLinks = await scraper.page.evaluate((ref) => {
          const links = [];
          const seen = new Set();
          const allLinks = document.querySelectorAll('a');
          
          for (const link of allLinks) {
            const href = link.href || '';
            const text = (link.textContent || '').trim();
            
            const isProductLink = 
              href.includes('page=product') ||
              href.includes('/product/') ||
              href.includes('product.php') ||
              text.toLowerCase().includes(ref.toLowerCase()) ||
              href.toLowerCase().includes(ref.toLowerCase());
            
            if (isProductLink && href && !seen.has(href)) {
              seen.add(href);
              links.push({ href, text: text || 'Lien produit' });
            }
          }
          
          return links;
        }, cleanRef);
        
        console.log(`📊 ${productLinks.length} liens produits trouvés`);
        
        if (productLinks.length > 0) {
          for (const link of productLinks) {
            const href = link.href || '';
            const text = link.text || '';
            
            if (href.toLowerCase().includes(cleanRef.toLowerCase()) || 
                text.toLowerCase().includes(cleanRef.toLowerCase())) {
              productUrl = href;
              console.log(`✅ Correspondance exacte trouvée: ${link.text} -> ${href}`);
              break;
            }
          }
          
          if (!productUrl && productLinks.length > 0) {
            productUrl = productLinks[0].href;
            console.log(`✅ Utilisation du premier résultat: ${productLinks[0].text} -> ${productUrl}`);
          }
          
          if (productUrl) break;
        }
        
      } catch (error) {
        console.log(`❌ Erreur: ${error.message}`);
      }
    }
    
    if (productUrl) {
      if (productUrl.startsWith('/')) {
        productUrl = 'https://kimland.dz' + productUrl;
      }
      if (!productUrl.startsWith('http')) {
        productUrl = 'https://kimland.dz/' + productUrl;
      }
      
      console.log(`🔄 Navigation vers la page produit: ${productUrl}`);
      
      await scraper.page.goto(productUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      
      await scraper.page.waitForTimeout(2000);
      
      const product = await scraper.extractProductFromUrl(productUrl);
      await scraper.close();
      
      if (product) {
        console.log('✅ Produit extrait avec succès:', product.title);
        res.json({
          success: true,
          product: product,
          url: productUrl,
          reference: reference
        });
        return;
      }
    }
    
    await scraper.close();
    
    res.json({
      success: false,
      message: 'Produit non trouvé',
      reference: reference
    });
    
  } catch (error) {
    console.error('❌ Erreur lors de la récupération du produit Kimland:', error.message);
    if (scraper) await scraper.close();
    res.status(500).json({
      success: false,
      message: 'Échec de la récupération du produit Kimland',
      error: error.message
    });
  }
});

// =============================================
// RECHERCHER DANS KIMLAND - VERSION SIMPLE
// =============================================
router.post('/search-kimland', async (req, res) => {
  const { reference } = req.body;
  
  if (!reference) {
    return res.status(400).json({
      success: false,
      message: 'La référence est requise'
    });
  }

  let scraper = null;

  try {
    scraper = new KimlandScraper();
    await scraper.initialize();
    await scraper.login();
    
    const cleanRef = reference.trim();
    
    const searchUrls = [
      `https://kimland.dz/index.php?page=products&pages=0&keyword=${encodeURIComponent(cleanRef)}`,
      `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(cleanRef)}`,
      `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(cleanRef)}&pages=0`
    ];

    let productUrl = null;

    for (const searchUrl of searchUrls) {
      console.log(`📋 Essai de recherche: ${searchUrl}`);
      
      try {
        await scraper.page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        
        await scraper.page.waitForTimeout(2000);
        
        const result = await scraper.page.evaluate((ref) => {
          const allLinks = document.querySelectorAll('a');
          
          for (const link of allLinks) {
            const href = link.href || '';
            const text = (link.textContent || '').trim();
            
            if (href.includes('page=product') || href.includes('/product/') || href.includes('product.php')) {
              if (text.toLowerCase().includes(ref.toLowerCase()) || href.toLowerCase().includes(ref.toLowerCase())) {
                let url = href;
                if (url.startsWith('/')) {
                  url = 'https://kimland.dz' + url;
                }
                return url;
              }
            }
          }
          
          const firstProductLink = document.querySelector('a[href*="page=product"], a[href*="/product/"], a[href*="product.php"]');
          if (firstProductLink) {
            let url = firstProductLink.href;
            if (url.startsWith('/')) {
              url = 'https://kimland.dz' + url;
            }
            return url;
          }
          
          return null;
        }, cleanRef);
        
        if (result) {
          productUrl = result;
          console.log(`✅ URL du produit trouvée: ${productUrl}`);
          break;
        }
        
      } catch (error) {
        console.log(`❌ Erreur de recherche: ${error.message}`);
      }
    }
    
    await scraper.close();
    
    if (productUrl) {
      res.json({
        success: true,
        url: productUrl,
        reference: reference
      });
    } else {
      res.json({
        success: false,
        message: 'Produit non trouvé',
        reference: reference
      });
    }
    
  } catch (error) {
    console.error('❌ Erreur lors de la recherche Kimland:', error.message);
    if (scraper) await scraper.close();
    res.status(500).json({
      success: false,
      message: 'Échec de la recherche Kimland',
      error: error.message
    });
  }
});

// =============================================
// IMPORTER VERS SHOPIFY
// =============================================
router.post('/upload', async (req, res) => {
  const product = req.body.product || req.session.lastProduct;

  if (!product) {
    return res.status(400).json({
      success: false,
      message: 'Aucun produit trouvé. Extrayez un produit d\'abord.'
    });
  }

  try {
    if (!process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN === 'shpat_xxxxxxxxxxxxxxxxxxxxxxxx') {
      return res.status(400).json({
        success: false,
        message: 'Shopify non configuré. Veuillez ajouter vos identifiants Shopify.'
      });
    }

    const shopify = new ShopifyClient();
    const store = new SyncStore();
    
    let existingProduct = null;
    
    const formattedTitle = product.reference 
      ? `${product.title} - ${product.reference}` 
      : product.title;
    
    console.log(`🔍 Vérification de l'existence du produit avec le titre: "${formattedTitle}"`);
    
    try {
      const allProducts = await shopify.getAllProducts(250);
      
      for (const p of allProducts) {
        if (p.title === formattedTitle || p.title === product.title) {
          existingProduct = p;
          console.log(`✅ Produit existant trouvé par titre: "${p.title}" (ID: ${p.id})`);
          break;
        }
        
        if (product.reference && p.variants) {
          for (const v of p.variants) {
            if (v.sku === product.reference) {
              existingProduct = p;
              console.log(`✅ Produit existant trouvé par SKU: "${p.title}"`);
              break;
            }
          }
          if (existingProduct) break;
        }
      }
    } catch (e) {
      console.log('⚠️ Erreur lors de la recherche des produits:', e.message);
    }

    if (!existingProduct) {
      const existingMapping = store.getMapping(product.kimlandId);
      if (existingMapping) {
        console.log(`🔍 Correspondance trouvée pour l'ID Kimland ${product.kimlandId}`);
        existingProduct = await shopify.getProduct(existingMapping.shopifyId);
        if (existingProduct) {
          console.log(`✅ Produit existant trouvé par correspondance: ${existingProduct.title}`);
        }
      }
    }
    
    let result;
    
    if (existingProduct) {
      console.log(`🔄 MISE À JOUR du produit existant: ${existingProduct.title} (ID: ${existingProduct.id})`);
      
      result = await shopify.updateProduct(existingProduct.id, product);
      store.saveMapping(product.kimlandId, result.id, product);
      
      res.json({
        success: true,
        message: 'Produit mis à jour dans Shopify !',
        action: 'updated',
        product: result,
        wasExisting: true
      });
    } else {
      console.log(`🆕 CRÉATION du nouveau produit: ${product.title}`);
      
      result = await shopify.createProduct(product);
      store.saveMapping(product.kimlandId, result.id, product);
      
      res.json({
        success: true,
        message: 'Produit créé dans Shopify !',
        action: 'created',
        product: result,
        wasExisting: false
      });
    }
    
  } catch (error) {
    console.error('❌ Erreur d\'importation:', error.message);
    console.error('📄 Erreur complète:', error);
    res.status(500).json({
      success: false,
      message: 'Échec de l\'importation vers Shopify: ' + error.message,
      error: error.message
    });
  }
});

// =============================================
// RÉCUPÉRER UN PRODUIT SHOPIFY PAR SKU
// =============================================
router.get('/shopify-product', async (req, res) => {
  const { sku } = req.query;
  
  if (!sku) {
    return res.status(400).json({
      success: false,
      message: 'Le SKU est requis'
    });
  }

  try {
    const shopify = new ShopifyClient();
    const product = await shopify.getProductBySku(sku);
    
    res.json({
      success: true,
      product: product
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération du produit:', error.message);
    res.status(500).json({
      success: false,
      message: 'Échec de la récupération du produit',
      error: error.message
    });
  }
});

// =============================================
// RÉCUPÉRER UN PRODUIT SHOPIFY PAR ID
// =============================================
router.get('/shopify-product-by-id', async (req, res) => {
  const { id } = req.query;
  
  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'L\'ID du produit est requis'
    });
  }

  try {
    const shopify = new ShopifyClient();
    const product = await shopify.getProduct(id);
    
    res.json({
      success: true,
      product: product
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération du produit:', error.message);
    res.status(500).json({
      success: false,
      message: 'Échec de la récupération du produit',
      error: error.message
    });
  }
});

// =============================================
// METTRE À JOUR LES VARIANTES SHOPIFY (RÉPARATION)
// =============================================
router.post('/shopify-update-variants', async (req, res) => {
  const { productId, variants } = req.body;

  if (!productId || !variants || variants.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'L\'ID du produit et les variantes sont requis'
    });
  }

  try {
    const shopify = new ShopifyClient();
    
    const existingProduct = await shopify.getProduct(productId);
    
    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé'
      });
    }

    const existingVariants = existingProduct.variants || [];
    const updatedVariants = existingVariants.map(function(existingVariant) {
      const update = variants.find(function(v) {
        return v.id === existingVariant.id;
      });
      
      if (update) {
        return {
          ...existingVariant,
          ...update
        };
      }
      return existingVariant;
    });

    const response = await axios.put(
      `${shopify.baseUrl}/products/${productId}.json`,
      {
        product: {
          id: productId,
          variants: updatedVariants,
          vendor: 'Signateur Confort',
          product_type: '',
          published_scope: 'global'
        }
      },
      { headers: shopify.headers }
    );

    logger.info(`✅ Produit réparé: ${existingProduct.title} - ${variants.length} variantes mises à jour`);
    
    res.json({
      success: true,
      message: 'Produit réparé avec succès',
      product: response.data.product
    });
  } catch (error) {
    logger.error('❌ Échec de la réparation du produit:', error.message);
    if (error.response) {
      logger.error('❌ Erreur API Shopify:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({
      success: false,
      message: 'Échec de la réparation du produit',
      error: error.message
    });
  }
});

// =============================================
// RÉPARER UN PRODUIT - RÉPARATION SHOPIFY
// =============================================
router.post('/fix-product', async (req, res) => {
  const { productId, product } = req.body;

  if (!productId) {
    return res.status(400).json({
      success: false,
      message: 'L\'ID du produit est requis'
    });
  }

  try {
    const shopify = new ShopifyClient();
    
    const existingProduct = await shopify.getProduct(productId);
    
    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé dans Shopify'
      });
    }

    const kimlandVariants = product.variants || product.sizes || [];
    const shopifyVariants = existingProduct.variants || [];
    
    const updatedVariants = shopifyVariants.map(function(shopifyVariant, index) {
      const kimlandVariant = kimlandVariants[index] || {};
      
      return {
        id: shopifyVariant.id,
        option1: shopifyVariant.option1 || kimlandVariant.value || 'Default',
        price: shopifyVariant.price || (product.price || 0).toFixed(2),
        sku: shopifyVariant.sku || kimlandVariant.sku || product.reference || '',
        cost: shopifyVariant.cost || kimlandVariant.cost || 0,
        barcode: shopifyVariant.barcode || kimlandVariant.barcode || '',
        inventory_management: 'shopify',
        inventory_policy: 'deny',
        inventory_quantity: kimlandVariant.quantity !== undefined ? Math.max(0, kimlandVariant.quantity) : (shopifyVariant.inventory_quantity || 0),
        fulfillment_service: shopifyVariant.fulfillment_service || 'manual',
        requires_shipping: true,
        taxable: true,
        position: index + 1
      };
    });

    const updateData = {
      product: {
        id: productId,
        variants: updatedVariants,
        vendor: 'Signateur Confort',
        product_type: '',
        published_scope: 'global'
      }
    };

    const shopifyImages = existingProduct.images || [];
    const kimlandImages = product.images || [];
    if (shopifyImages.length === 0 && kimlandImages.length > 0) {
      updateData.product.images = kimlandImages.map(function(img, idx) {
        return {
          src: img,
          position: idx + 1
        };
      });
    }

    const response = await axios.put(
      `${shopify.baseUrl}/products/${productId}.json`,
      updateData,
      { headers: shopify.headers }
    );

    logger.info(`✅ Produit réparé: ${existingProduct.title} (ID: ${productId})`);
    
    res.json({
      success: true,
      message: 'Produit réparé avec succès',
      product: response.data.product
    });
    
  } catch (error) {
    logger.error('❌ Échec de la réparation du produit:', error.message);
    if (error.response) {
      logger.error('❌ Erreur API Shopify:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({
      success: false,
      message: 'Échec de la réparation du produit',
      error: error.message
    });
  }
});

// =============================================
// RÉCUPÉRER TOUS LES PRODUITS SHOPIFY
// =============================================
router.get('/shopify-products', async (req, res) => {
  try {
    const shopify = new ShopifyClient();
    const products = await shopify.getAllProducts(250);
    
    if (!products || !Array.isArray(products)) {
      return res.json({
        success: true,
        products: []
      });
    }
    
    res.json({
      success: true,
      products: products
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des produits:', error.message);
    res.status(500).json({
      success: false,
      message: 'Échec de la récupération des produits',
      error: error.message
    });
  }
});

// =============================================
// RÉCUPÉRER LES PRODUITS SHOPIFY AVEC PAGINATION
// =============================================
router.get('/shopify-products-paginated', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  try {
    const shopify = new ShopifyClient();
    const allProducts = await shopify.getAllProducts(250);
    
    // Calcul de la pagination
    const totalProducts = allProducts.length;
    const totalPages = Math.ceil(totalProducts / limit);
    const paginatedProducts = allProducts.slice(offset, offset + limit);
    
    res.json({
      success: true,
      products: paginatedProducts,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalProducts: totalProducts,
        limit: limit,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des produits paginés:', error.message);
    res.status(500).json({
      success: false,
      message: 'Échec de la récupération des produits',
      error: error.message
    });
  }
});

// =============================================
// SYNCHRONISER L'INVENTAIRE - PAR SKU
// =============================================
router.post('/sync-inventory', async (req, res) => {
  const { product, reference } = req.body;

  if (!reference && !product?.reference) {
    return res.status(400).json({
      success: false,
      message: 'La référence (SKU) est requise'
    });
  }

  const sku = reference || product.reference;

  try {
    const shopify = new ShopifyClient();
    const shopifyProduct = await shopify.getProductBySku(sku);
    
    if (!shopifyProduct) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé dans Shopify'
      });
    }

    const variants = product?.variants || product?.sizes || [];
    
    if (variants.length === 0) {
      return res.json({
        success: true,
        message: 'Produit trouvé, aucune mise à jour de stock nécessaire',
        stock: 0,
        variants: []
      });
    }

    const shopifyVariants = shopifyProduct.variants || [];
    for (let i = 0; i < Math.min(shopifyVariants.length, variants.length); i++) {
      const quantity = Math.max(0, variants[i]?.quantity || 0);
      await shopify.updateInventory(shopifyVariants[i].id, quantity);
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    const totalStock = variants.reduce((sum, v) => sum + Math.max(0, v.quantity || 0), 0);

    res.json({
      success: true,
      message: 'Inventaire mis à jour avec succès',
      stock: totalStock,
      variants: variants
    });
  } catch (error) {
    logger.error('❌ Erreur de synchronisation de l\'inventaire:', error.message);
    res.status(500).json({
      success: false,
      message: 'Échec de la synchronisation de l\'inventaire',
      error: error.message
    });
  }
});

// =============================================
// COMPARER ET RÉPARER UN PRODUIT (FORCE les champs vendor/product_type/published_scope)
// =============================================
function compareAndRepairProduct(shopifyProduct, kimlandProduct) {
  const repairs = [];
  const shopifyVariants = shopifyProduct.variants || [];
  const kimlandVariants = kimlandProduct.variants || [];

  // --- Vérifier la référence (SKU) ---
  const shopifySku = shopifyVariants.length > 0 ? shopifyVariants[0].sku : null;
  const kimlandSku = kimlandProduct.reference || (kimlandVariants.length > 0 ? kimlandVariants[0].sku : null);
  if (shopifySku !== kimlandSku && kimlandSku) {
    repairs.push({ field: 'sku', old: shopifySku, new: kimlandSku });
  }

  // --- Vérifier le titre ---
  if (shopifyProduct.title !== kimlandProduct.title) {
    repairs.push({ field: 'title', old: shopifyProduct.title, new: kimlandProduct.title });
  }

  // --- Vérifier le prix ---
  const shopifyPrice = shopifyVariants.length > 0 ? parseFloat(shopifyVariants[0].price) : 0;
  const kimlandPrice = kimlandProduct.price || 0;
  if (shopifyPrice !== kimlandPrice && kimlandPrice > 0) {
    repairs.push({ field: 'price', old: shopifyPrice, new: kimlandPrice });
  }

  // --- Vérifier le coût ---
  const shopifyCost = shopifyVariants.length > 0 ? shopifyVariants[0].cost || 0 : 0;
  const kimlandCost = kimlandProduct.costPrice || 0;
  if (shopifyCost !== kimlandCost && kimlandCost > 0) {
    repairs.push({ field: 'cost', old: shopifyCost, new: kimlandCost });
  }

  // --- Vérifier le nombre de variantes ---
  if (shopifyVariants.length !== kimlandVariants.length) {
    repairs.push({ field: 'variantCount', old: shopifyVariants.length, new: kimlandVariants.length });
  }

  // --- Vérifier les noms et quantités des variantes ---
  const variantMismatches = [];
  for (let i = 0; i < Math.min(shopifyVariants.length, kimlandVariants.length); i++) {
    const sv = shopifyVariants[i];
    const kv = kimlandVariants[i];
    if (sv.option1 !== kv.value) {
      variantMismatches.push({ index: i, field: 'option', old: sv.option1, new: kv.value });
    }
    if (sv.inventory_quantity !== kv.quantity) {
      variantMismatches.push({ index: i, field: 'quantity', old: sv.inventory_quantity, new: kv.quantity });
    }
    if (sv.sku !== kv.sku && kv.sku) {
      variantMismatches.push({ index: i, field: 'variantSku', old: sv.sku, new: kv.sku });
    }
  }
  if (variantMismatches.length > 0) {
    repairs.push({ field: 'variants', details: variantMismatches });
  }

  // --- Vérifier le nombre d'images ---
  const shopifyImages = shopifyProduct.images || [];
  const kimlandImages = kimlandProduct.images || [];
  if (shopifyImages.length !== kimlandImages.length) {
    repairs.push({ field: 'imageCount', old: shopifyImages.length, new: kimlandImages.length });
  }

  // --- 🔥 FORCER les champs à corriger ---
  // Fournisseur
  if (shopifyProduct.vendor !== 'Signateur Confort') {
    repairs.push({ field: 'vendor', old: shopifyProduct.vendor || 'vide', new: 'Signateur Confort' });
  }
  // Type de produit (doit être vide)
  if (shopifyProduct.product_type !== '' && shopifyProduct.product_type !== null) {
    repairs.push({ field: 'product_type', old: shopifyProduct.product_type || 'vide', new: '' });
  }
  // Canaux (published_scope = global)
  if (shopifyProduct.published_scope !== 'global') {
    repairs.push({ field: 'published_scope', old: shopifyProduct.published_scope || 'web', new: 'global' });
  }

  const needsRepair = repairs.length > 0;

  let repairData = null;
  if (needsRepair) {
    // Construire les variantes mises à jour
    const updatedVariants = shopifyVariants.map((sv, idx) => {
      const kv = kimlandVariants[idx] || {};
      return {
        id: sv.id,
        option1: kv.value || sv.option1,
        price: kimlandProduct.price !== undefined ? kimlandProduct.price.toFixed(2) : sv.price,
        sku: kv.sku || sv.sku || kimlandProduct.reference || '',
        cost: (kimlandProduct.costPrice !== undefined ? kimlandProduct.costPrice : sv.cost || 0).toFixed(2),
        inventory_quantity: kv.quantity !== undefined ? kv.quantity : sv.inventory_quantity,
        inventory_management: 'shopify',
        inventory_policy: sv.inventory_policy || 'deny',
        fulfillment_service: sv.fulfillment_service || 'manual',
        requires_shipping: true,
        taxable: true,
        position: idx + 1
      };
    });

    // Construction du produit avec les champs forcés
    repairData = {
      product: {
        id: shopifyProduct.id,
        title: kimlandProduct.title || shopifyProduct.title,
        body_html: kimlandProduct.description || shopifyProduct.body_html,
        vendor: 'Signateur Confort',          // FORCÉ
        product_type: '',                     // FORCÉ (vide)
        variants: updatedVariants,
        images: (kimlandImages.length > 0) ? kimlandImages.map((src, idx) => ({ src, position: idx + 1 })) : shopifyImages,
        published_scope: 'global'             // FORCÉ (tous les canaux)
      }
    };
  }

  return { needsRepair, repairs, repairData };
}

// =============================================
// VÉRIFIER L'ÉTAT DE RÉPARATION D'UN PRODUIT
// =============================================
router.post('/check-product-repair', async (req, res) => {
  const { productId, product } = req.body;

  if (!productId || !product) {
    return res.status(400).json({
      success: false,
      message: 'L\'ID du produit et les données du produit sont requis'
    });
  }

  try {
    const shopify = new ShopifyClient();
    const shopifyProduct = await shopify.getProduct(productId);
    if (!shopifyProduct) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé dans Shopify'
      });
    }

    const { needsRepair, repairs } = compareAndRepairProduct(shopifyProduct, product);
    res.json({
      success: true,
      needsRepair,
      repairs
    });
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'état de réparation:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =============================================
// SYNCHRONISER L'INVENTAIRE - PAR ID SHOPIFY
// =============================================
router.post('/sync-inventory-by-id', async (req, res) => {
  const { productId, product } = req.body;

  console.log('📦 Demande de synchronisation par ID reçue:');
  console.log('   productId:', productId);
  console.log('   product title:', product?.title);

  if (!productId) {
    console.log('❌ Aucun productId fourni');
    return res.status(400).json({
      success: false,
      message: 'L\'ID du produit est requis'
    });
  }

  try {
    const shopify = new ShopifyClient();
    
    console.log('🔍 Récupération du produit depuis Shopify:', productId);
    const shopifyProduct = await shopify.getProduct(productId);
    
    if (!shopifyProduct) {
      console.log('❌ Produit non trouvé dans Shopify:', productId);
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé dans Shopify'
      });
    }

    console.log('✅ Produit trouvé dans Shopify:', shopifyProduct.title);

    if (!product) {
      const totalStock = shopifyProduct.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
      return res.json({
        success: true,
        message: 'Stock actuel du produit',
        stock: totalStock,
        variants: shopifyProduct.variants.map(v => ({
          value: v.option1 || 'Default',
          quantity: v.inventory_quantity || 0
        }))
      });
    }

    // === ÉTAPE 1: Comparer et réparer si nécessaire ===
    const { needsRepair, repairs, repairData } = compareAndRepairProduct(shopifyProduct, product);

    if (needsRepair) {
      console.log('⚠️ Le produit a besoin d\'être réparé. Problèmes détectés:', repairs);
      console.log('🔄 Réparation du produit...');
      const repairResponse = await axios.put(
        `${shopify.baseUrl}/products/${productId}.json`,
        repairData,
        { headers: shopify.headers }
      );
      console.log('✅ Produit réparé avec succès.');
      shopifyProduct.title = repairData.product.title;
      shopifyProduct.variants = repairData.product.variants;
      shopifyProduct.images = repairData.product.images;
      shopifyProduct.vendor = repairData.product.vendor;
      shopifyProduct.product_type = repairData.product.product_type;
      shopifyProduct.published_scope = repairData.product.published_scope;
    } else {
      console.log('✅ Le produit est à jour, aucune réparation nécessaire.');
    }

    // === ÉTAPE 2: Synchroniser l'inventaire ===
    const shopifyVariants = shopifyProduct.variants || [];
    const kimlandVariants = product.variants || product.sizes || [];

    console.log('📏 Variantes Shopify:', shopifyVariants.length);
    console.log('📏 Variantes Kimland:', kimlandVariants.length);

    if (kimlandVariants.length === 0) {
      const totalStock = shopifyVariants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
      return res.json({
        success: true,
        message: 'Produit trouvé, stock actuel: ' + totalStock,
        stock: totalStock,
        variants: shopifyVariants.map(v => ({
          value: v.option1 || 'Default',
          quantity: v.inventory_quantity || 0
        }))
      });
    }

    console.log('🔄 Synchronisation de l\'inventaire...');
    
    let totalStock = 0;
    let updatedCount = 0;
    let matchedVariants = [];

    for (let i = 0; i < shopifyVariants.length; i++) {
      const shopifyVariant = shopifyVariants[i];
      const shopifyOption = shopifyVariant.option1 || '';
      
      let kimlandVariant = null;
      
      if (shopifyVariant.sku) {
        for (const kv of kimlandVariants) {
          if (kv.sku && kv.sku === shopifyVariant.sku) {
            kimlandVariant = kv;
            break;
          }
        }
      }
      
      if (!kimlandVariant) {
        const cleanShopifyOption = shopifyOption.replace(/\s/g, '').toUpperCase();
        for (const kv of kimlandVariants) {
          const kvValue = kv.value || kv.size || '';
          const cleanKvValue = kvValue.replace(/\s/g, '').toUpperCase();
          if (cleanKvValue === cleanShopifyOption) {
            kimlandVariant = kv;
            break;
          }
        }
      }
      
      if (!kimlandVariant) {
        const shopifyNum = parseFloat(shopifyOption);
        if (!isNaN(shopifyNum)) {
          for (const kv of kimlandVariants) {
            const kvNum = parseFloat(kv.value || kv.size || '');
            if (!isNaN(kvNum) && kvNum === shopifyNum) {
              kimlandVariant = kv;
              break;
            }
          }
        }
      }
      
      if (kimlandVariant) {
        const kimlandStock = Math.max(0, kimlandVariant.quantity || 0);
        console.log(`   Variante ${i}: ${shopifyOption} → ${kimlandStock} unités`);
        
        await shopify.updateInventory(shopifyVariant.id, kimlandStock);
        totalStock += kimlandStock;
        updatedCount++;
        matchedVariants.push({
          shopify: shopifyOption,
          kimland: kimlandVariant.value || kimlandVariant.size || '',
          stock: kimlandStock
        });
      } else {
        console.log(`   ⚠️ Variante ${i}: ${shopifyOption} → AUCUNE CORRESPONDANCE trouvée, conservation du stock actuel`);
        totalStock += shopifyVariant.inventory_quantity || 0;
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`✅ Synchronisation terminée ! ${updatedCount}/${shopifyVariants.length} variantes mises à jour`);
    console.log('   📊 Stock total depuis Kimland:', totalStock);

    res.json({
      success: true,
      message: `Inventaire mis à jour avec succès (${updatedCount}/${shopifyVariants.length} variantes mises à jour)`,
      stock: totalStock,
      variants: kimlandVariants.map(v => ({
        value: v.value || v.size || 'Default',
        quantity: Math.max(0, v.quantity || 0)
      })),
      matched: matchedVariants,
      repaired: needsRepair,
      repairs: needsRepair ? repairs : null
    });

  } catch (error) {
    console.error('❌ Erreur de synchronisation de l\'inventaire:', error.message);
    console.error('📄 Erreur complète:', error);
    res.status(500).json({
      success: false,
      message: 'Échec de la synchronisation de l\'inventaire: ' + error.message,
      error: error.message
    });
  }
});

// =============================================
// METTRE À JOUR L'INVENTAIRE
// =============================================
router.post('/update-inventory', async (req, res) => {
  const { productId, variants, totalStock } = req.body;

  if (!productId) {
    return res.status(400).json({
      success: false,
      message: 'L\'ID du produit est requis'
    });
  }

  try {
    const shopify = new ShopifyClient();
    const product = await shopify.getProduct(productId);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé'
      });
    }

    const shopifyVariants = product.variants || [];
    
    for (let i = 0; i < Math.min(shopifyVariants.length, variants?.length || 0); i++) {
      const quantity = Math.max(0, variants[i]?.quantity || 0);
      await shopify.updateInventory(shopifyVariants[i].id, quantity);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    res.json({
      success: true,
      message: 'Inventaire mis à jour avec succès'
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la mise à jour de l\'inventaire:', error.message);
    res.status(500).json({
      success: false,
      message: 'Échec de la mise à jour de l\'inventaire',
      error: error.message
    });
  }
});

// =============================================
// EXPORTER EN CSV - PRODUIT UNIQUE
// =============================================
router.post('/export-csv', async (req, res) => {
  console.log('📊 Route d\'exportation CSV appelée');

  const product = req.session.lastProduct;

  if (!product) {
    return res.status(400).json({
      success: false,
      message: '❌ Aucun produit trouvé. Extrayez un produit d\'abord.'
    });
  }

  try {
    console.log('📦 Produit trouvé:', product.title);
    
    const exporter = new CSVExporter();
    const result = exporter.exportToCSV(product);
    
    console.log('✅ CSV exporté:', result.filename);
    
    res.json({
      success: true,
      message: '✅ CSV exporté avec succès !',
      filename: result.filename,
      rows: result.rows,
      downloadUrl: `/api/download-csv/${result.filename}`
    });
  } catch (error) {
    console.error('❌ Erreur d\'exportation CSV:', error.message);
    res.status(500).json({
      success: false,
      message: '❌ Échec de l\'exportation CSV',
      error: error.message
    });
  }
});

// =============================================
// TÉLÉCHARGER UN FICHIER CSV
// =============================================
router.get('/download-csv/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(__dirname, '../../exports', filename);
  
  console.log('📥 Téléchargement:', filePath);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: '❌ Fichier non trouvé'
    });
  }

  res.download(filePath, filename, (err) => {
    if (err) {
      logger.error('❌ Erreur de téléchargement:', err.message);
      res.status(500).json({
        success: false,
        message: '❌ Échec du téléchargement du fichier'
      });
    }
  });
});

// =============================================
// EXPORTATION MULTIPLE EN CSV
// =============================================
router.post('/bulk-export-csv', async (req, res) => {
  const { products } = req.body;
  
  if (!products || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: '❌ Aucun produit à exporter'
    });
  }

  try {
    const exporter = new CSVExporter();
    const result = exporter.exportMultipleToCSV(products);
    
    res.json({
      success: true,
      message: '✅ CSV exporté avec succès !',
      filename: result.filename,
      rows: result.rows,
      products: result.products,
      downloadUrl: `/api/download-csv/${result.filename}`
    });
  } catch (error) {
    logger.error('❌ Erreur d\'exportation CSV groupée:', error.message);
    res.status(500).json({
      success: false,
      message: '❌ Échec de l\'exportation CSV',
      error: error.message
    });
  }
});

// =============================================
// EXPORTER TOUS LES PRODUITS SYNCHRONISÉS EN CSV
// =============================================
router.post('/export-all-csv', async (req, res) => {
  try {
    const store = new SyncStore();
    const mappings = store.getAllMappings();
    const products = Object.values(mappings)
      .map(m => m.productData)
      .filter(p => p !== null);
    
    if (products.length === 0) {
      return res.status(400).json({
        success: false,
        message: '❌ Aucun produit trouvé à exporter'
      });
    }

    const exporter = new CSVExporter();
    const result = exporter.exportMultipleToCSV(products);
    
    res.json({
      success: true,
      message: '✅ Tous les produits ont été exportés en CSV !',
      filename: result.filename,
      products: result.products,
      rows: result.rows,
      downloadUrl: `/api/download-csv/${result.filename}`
    });
  } catch (error) {
    logger.error('❌ Erreur d\'exportation de tous les produits:', error.message);
    res.status(500).json({
      success: false,
      message: '❌ Échec de l\'exportation de tous les produits',
      error: error.message
    });
  }
});

// =============================================
// RÉPARER UN PRODUIT UNIQUE RAPIDEMENT
// =============================================
router.post('/fix-product-fast', async (req, res) => {
  const { productId } = req.body;

  if (!productId) {
    return res.status(400).json({
      success: false,
      message: 'L\'ID du produit est requis'
    });
  }

  let scraper = null;

  try {
    const shopify = new ShopifyClient();
    
    const shopifyProduct = await shopify.getProduct(productId);
    if (!shopifyProduct) {
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé dans Shopify'
      });
    }

    const title = shopifyProduct.title || '';
    const refMatch = title.match(/([A-Z]{2,4}\d{3,4})/i);
    const reference = refMatch ? refMatch[0] : null;

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: 'Aucune référence trouvée dans le titre du produit',
        title: title
      });
    }

    scraper = new KimlandScraper();
    await scraper.initialize();
    await scraper.login();

    const searchUrls = [
      `https://kimland.dz/index.php?page=products&pages=0&keyword=${encodeURIComponent(reference)}`,
      `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(reference)}`
    ];

    let productUrl = null;
    for (const url of searchUrls) {
      await scraper.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await scraper.page.waitForTimeout(1000);
      
      const found = await scraper.page.evaluate((ref) => {
        const links = document.querySelectorAll('a');
        for (const link of links) {
          const href = link.href || '';
          const text = link.textContent || '';
          if ((href.includes('page=product') || href.includes('/product/')) && 
              (text.toLowerCase().includes(ref.toLowerCase()) || href.toLowerCase().includes(ref.toLowerCase()))) {
            return href;
          }
        }
        const first = document.querySelector('a[href*="page=product"], a[href*="/product/"]');
        return first ? first.href : null;
      }, reference);
      
      if (found) {
        productUrl = found;
        break;
      }
    }

    if (!productUrl) {
      await scraper.close();
      return res.status(404).json({
        success: false,
        message: 'Produit non trouvé sur Kimland',
        reference: reference
      });
    }

    if (productUrl.startsWith('/')) productUrl = 'https://kimland.dz' + productUrl;
    if (!productUrl.startsWith('http')) productUrl = 'https://kimland.dz/' + productUrl;

    const kimlandProduct = await scraper.extractProductFromUrl(productUrl);
    await scraper.close();

    if (!kimlandProduct) {
      return res.status(500).json({
        success: false,
        message: 'Échec de l\'extraction depuis Kimland'
      });
    }

    await shopify.updateProduct(productId, kimlandProduct);
    
    if (kimlandProduct.variants && kimlandProduct.variants.length > 0) {
      await shopify.syncInventory(productId, kimlandProduct);
    }

    res.json({
      success: true,
      message: 'Produit réparé avec succès !',
      product: {
        id: productId,
        title: kimlandProduct.title,
        reference: kimlandProduct.reference,
        stock: kimlandProduct.totalStock,
        variants: kimlandProduct.variants
      }
    });

  } catch (error) {
    if (scraper) await scraper.close();
    console.error('❌ Erreur lors de la réparation du produit:', error.message);
    res.status(500).json({
      success: false,
      message: 'Échec de la réparation du produit',
      error: error.message
    });
  }
});

// =============================================
// RÉPARER TOUS LES PRODUITS EN LOT RAPIDEMENT
// =============================================
router.post('/fix-all-products-fast', async (req, res) => {
  const { productIds } = req.body;
  
  if (!productIds || productIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Les IDs des produits sont requis'
    });
  }

  const shopify = new ShopifyClient();
  const results = [];
  const concurrency = 2;

  console.log(`🔄 Début de la réparation automatique pour ${productIds.length} produits...`);

  const processBatch = async (batch) => {
    const promises = batch.map(async (productId) => {
      let scraper = null;
      try {
        console.log(`🔍 Traitement du produit ${productId}...`);

        const shopifyProduct = await shopify.getProduct(productId);
        if (!shopifyProduct) {
          return { productId, success: false, error: 'Produit non trouvé dans Shopify' };
        }

        const title = shopifyProduct.title || '';
        const refMatch = title.match(/([A-Z]{2,4}\d{3,4})/i);
        const reference = refMatch ? refMatch[0] : null;

        if (!reference) {
          return { 
            productId, 
            success: false, 
            error: 'Aucune référence trouvée dans le titre',
            title: title 
          };
        }

        console.log(`📋 Référence depuis le titre: ${reference}`);

        scraper = new KimlandScraper();
        await scraper.initialize();
        await scraper.login();

        const searchUrls = [
          `https://kimland.dz/index.php?page=products&pages=0&keyword=${encodeURIComponent(reference)}`,
          `https://kimland.dz/index.php?page=products&keyword=${encodeURIComponent(reference)}`
        ];

        let productUrl = null;
        for (const url of searchUrls) {
          await scraper.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await scraper.page.waitForTimeout(1500);
          
          const found = await scraper.page.evaluate((ref) => {
            const links = document.querySelectorAll('a');
            for (const link of links) {
              const href = link.href || '';
              const text = link.textContent || '';
              if ((href.includes('page=product') || href.includes('/product/')) && 
                  (text.toLowerCase().includes(ref.toLowerCase()) || href.toLowerCase().includes(ref.toLowerCase()))) {
                return href;
              }
            }
            const first = document.querySelector('a[href*="page=product"], a[href*="/product/"]');
            return first ? first.href : null;
          }, reference);
          
          if (found) {
            productUrl = found;
            break;
          }
        }

        if (!productUrl) {
          await scraper.close();
          return { 
            productId, 
            success: false, 
            error: 'Produit non trouvé sur Kimland',
            reference: reference 
          };
        }

        if (productUrl.startsWith('/')) productUrl = 'https://kimland.dz' + productUrl;
        if (!productUrl.startsWith('http')) productUrl = 'https://kimland.dz/' + productUrl;

        const kimlandProduct = await scraper.extractProductFromUrl(productUrl);
        await scraper.close();

        if (!kimlandProduct) {
          return { 
            productId, 
            success: false, 
            error: 'Échec de l\'extraction depuis Kimland' 
          };
        }

        await shopify.updateProduct(productId, kimlandProduct);
        
        if (kimlandProduct.variants && kimlandProduct.variants.length > 0) {
          await shopify.syncInventory(productId, kimlandProduct);
        }

        console.log(`✅ Produit mis à jour: ${kimlandProduct.title} | Réf: ${kimlandProduct.reference}`);

        return {
          productId,
          success: true,
          reference: kimlandProduct.reference,
          title: kimlandProduct.title,
          stock: kimlandProduct.totalStock,
          variants: kimlandProduct.variantCount
        };

      } catch (error) {
        if (scraper) await scraper.close();
        console.error(`❌ Erreur lors du traitement ${productId}:`, error.message);
        return { productId, success: false, error: error.message };
      }
    });

    return await Promise.all(promises);
  };

  const batches = [];
  for (let i = 0; i < productIds.length; i += concurrency) {
    batches.push(productIds.slice(i, i + concurrency));
  }

  let totalProcessed = 0;
  for (const batch of batches) {
    console.log(`📦 Traitement du lot ${totalProcessed + 1}/${batches.length}...`);
    const batchResults = await processBatch(batch);
    results.push(...batchResults);
    totalProcessed += batch.length;
    console.log(`✅ Lot terminé: ${batchResults.filter(r => r.success).length}/${batch.length} succès`);
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  console.log(`🎉 Réparation automatique terminée: ${successCount}/${productIds.length} produits réparés`);

  res.json({
    success: true,
    message: `${successCount}/${productIds.length} produits réparés`,
    results: {
      total: productIds.length,
      success: successCount,
      failed: failCount,
      details: results
    }
  });
});

module.exports = router;