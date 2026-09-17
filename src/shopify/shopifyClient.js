// src/shopify/shopifyClient.js

const axios = require('axios');
const logger = require('../utils/logger');

class ShopifyClient {
  constructor() {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-07';

    let shopifyStore = storeUrl;
    if (!storeUrl.includes('.myshopify.com') && !storeUrl.includes('.')) {
      shopifyStore = `${storeUrl}.myshopify.com`;
    }

    this.baseUrl = `https://${shopifyStore}/admin/api/${apiVersion}`;
    this.graphqlUrl = `https://${shopifyStore}/admin/api/${apiVersion}/graphql.json`;
    this.headers = {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json',
    };

    logger.info(`🔧 Shopify config: Store=${shopifyStore}, API=${apiVersion}`);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retryRequest(fn, maxRetries = 3, baseDelay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (error.response) {
          const status = error.response.status;
          if (![429, 500, 502, 503, 504].includes(status)) {
            throw error;
          }
        }
        if (attempt === maxRetries) throw error;
        const delayMs = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(`⚠️ Retry ${attempt}/${maxRetries} failed, waiting ${delayMs}ms...`);
        await this.delay(delayMs);
      }
    }
  }

  // =============================================
  // EXTRACT NEXT PAGE URL FROM LINK HEADER
  // =============================================
  getNextPageUrl(linkHeader) {
    if (!linkHeader) {
      return null;
    }

    const linkPattern = /<([^>]+)>;\s*rel="([^"]+)"/g;
    let match;
    const links = {};

    while ((match = linkPattern.exec(linkHeader)) !== null) {
      const url = match[1];
      const rel = match[2];
      links[rel] = url;
    }

    return links.next || null;
  }

  // =============================================
  // GET ALL PRODUCTS - WITH LINK HEADER PAGINATION
  // =============================================
  async getAllProducts(limit = 250) {
    try {
      let allProducts = [];
      let pageCount = 0;
      const pageSize = Math.min(limit, 250);
      // Newest first (same as Shopify admin: new → old)
      let nextUrl = `${this.baseUrl}/products.json?limit=${pageSize}&order=created_at+desc`;

      while (nextUrl) {
        pageCount++;
        logger.info(`📄 Fetching page ${pageCount} of Shopify products...`);

        const response = await this.retryRequest(async () => {
          return await axios.get(nextUrl, { headers: this.headers });
        });

        const products = response.data.products || [];
        
        if (products.length === 0) {
          logger.warn(`⚠️ Page ${pageCount} returned 0 products, stopping pagination`);
          break;
        }

        allProducts = allProducts.concat(products);
        logger.info(`✅ Page ${pageCount}: ${products.length} products (total: ${allProducts.length})`);

        const linkHeader = response.headers.link;
        nextUrl = this.getNextPageUrl(linkHeader);

        if (nextUrl) {
          logger.info(`🔄 Next page URL found, continuing...`);
          await this.delay(200);
        }
      }

      // Safety sort: newest first (created_at desc, then id desc)
      allProducts.sort((a, b) => {
        const da = new Date(a.created_at || 0).getTime();
        const db = new Date(b.created_at || 0).getTime();
        if (db !== da) return db - da;
        return Number(b.id || 0) - Number(a.id || 0);
      });

      logger.info(`📦 ${allProducts.length} total products fetched from Shopify (${pageCount} pages) — newest first`);

      const activeCount = allProducts.filter(p => p.status === 'active' || p.published_status === 'published').length;
      const draftCount = allProducts.filter(p => p.status === 'draft' || p.published_status === 'unpublished').length;
      const archivedCount = allProducts.filter(p => p.status === 'archived').length;
      
      logger.info(`   ✅ Active: ${activeCount}`);
      logger.info(`   📝 Draft: ${draftCount}`);
      logger.info(`   📦 Archived: ${archivedCount}`);

      allProducts.forEach(p => {
        if (p.status === 'active' || p.published_status === 'published') {
          p.display_status = 'active';
        } else if (p.status === 'draft' || p.published_status === 'unpublished') {
          p.display_status = 'draft';
        } else if (p.status === 'archived') {
          p.display_status = 'archived';
        } else {
          p.display_status = p.status || 'unknown';
        }
      });

      return allProducts;
    } catch (error) {
      this.logApiError(error, 'getAllProducts');
      return [];
    }
  }

  /**
   * Normalize collection title for comparison (ignore emoji, case, extra spaces)
   */
  normalizeCollectionTitle(title) {
    return String(title || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Product IDs that belong to collections to SKIP during sync
   * Default: BASKET FEMME + Parfum Testeur Original
   * Override with env SYNC_EXCLUDE_COLLECTIONS=BASKET FEMME,Parfum Testeur
   */
  async getExcludedCollectionProductIds(extraTitles = []) {
    const fromEnv = String(process.env.SYNC_EXCLUDE_COLLECTIONS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const defaults = ['BASKET FEMME', 'PARFUM TESTEUR ORIGINAL', 'Parfum Testeur original'];
    const wanted = [...defaults, ...fromEnv, ...extraTitles].map((t) =>
      this.normalizeCollectionTitle(t)
    );
    const wantedSet = new Set(wanted.filter(Boolean));
    const productIds = new Set();

    try {
      const collections = [];
      for (const endpoint of ['custom_collections', 'smart_collections']) {
        let nextUrl = `${this.baseUrl}/${endpoint}.json?limit=250`;
        while (nextUrl) {
          const response = await this.retryRequest(async () => {
            return await axios.get(nextUrl, { headers: this.headers });
          });
          const key = endpoint;
          const list = response.data[key] || [];
          collections.push(...list);
          nextUrl = this.getNextPageUrl(response.headers.link);
          if (nextUrl) await this.delay(150);
        }
      }

      const matched = collections.filter((c) =>
        wantedSet.has(this.normalizeCollectionTitle(c.title))
      );

      if (matched.length === 0) {
        logger.warn(
          `⚠️ Aucune collection exclue trouvée (cherché: ${[...wantedSet].join(', ')})`
        );
        return productIds;
      }

      for (const col of matched) {
        logger.info(`🚫 Collection exclue du sync: "${col.title}" (id=${col.id})`);
        let nextUrl = `${this.baseUrl}/collections/${col.id}/products.json?limit=250`;
        while (nextUrl) {
          const response = await this.retryRequest(async () => {
            return await axios.get(nextUrl, { headers: this.headers });
          });
          const products = response.data.products || [];
          products.forEach((p) => productIds.add(String(p.id)));
          nextUrl = this.getNextPageUrl(response.headers.link);
          if (nextUrl) await this.delay(150);
        }
      }

      logger.info(`🚫 ${productIds.size} produit(s) exclus (collections filtrées)`);
    } catch (error) {
      this.logApiError(error, 'getExcludedCollectionProductIds');
    }

    return productIds;
  }

  async publishToAllChannels(productId) {
    try {
      logger.info('📢 Publishing product to all sales channels...');

      const publicationsResponse = await this.retryRequest(async () => {
        return await axios.post(
          this.graphqlUrl,
          {
            query: `
              query {
                publications(first: 100) {
                  nodes {
                    id
                    name
                  }
                }
              }
            `
          },
          { headers: this.headers }
        );
      });

      const publications = publicationsResponse.data?.data?.publications?.nodes || [];
      logger.info(`📡 Found ${publications.length} publications`);

      if (publications.length === 0) {
        logger.warn('⚠️ No publications found. Check your sales channels.');
        return;
      }

      const productGid = `gid://shopify/Product/${productId}`;

      for (const pub of publications) {
        try {
          logger.info(`📤 Publishing to ${pub.name} (${pub.id})`);

          const publishResponse = await this.retryRequest(async () => {
            return await axios.post(
              this.graphqlUrl,
              {
                query: `
                  mutation Publish($id: ID!, $publicationId: ID!) {
                    publishablePublish(
                      id: $id
                      input: [{publicationId: $publicationId}]
                    ) {
                      userErrors {
                        field
                        message
                      }
                    }
                  }
                `,
                variables: {
                  id: productGid,
                  publicationId: pub.id
                }
              },
              { headers: this.headers }
            );
          });

          const errors = publishResponse.data?.data?.publishablePublish?.userErrors || [];
          if (errors.length > 0) {
            logger.warn(`⚠️ Errors publishing to ${pub.name}:`, errors);
          } else {
            logger.info(`✅ Published to ${pub.name}`);
          }
        } catch (e) {
          logger.warn(`⚠️ Could not publish to ${pub.name}: ${e.message}`);
        }
      }

      logger.info('🎉 Publication completed for all channels.');
    } catch (error) {
      logger.error('❌ GraphQL publication failed:', error.response?.data || error.message);
    }
  }

  async createProduct(productData) {
    try {
      logger.info(`🛍️ Creating product in Shopify: ${productData.title}`);

      const formattedTitle = productData.reference
        ? `${productData.title} - ${productData.reference}`
        : productData.title;

      const sizes = productData.sizes || productData.variants || [];
      let variants = [];

      // Never use Shopify "Default Title" — always a real label (Standard, S, 42…)
      const optionName =
        productData.variantLabel ||
        productData.variantType ||
        (String(productData.title || '').toLowerCase().includes('montre') ? 'Dimension' : 'Taille');

      if (sizes.length > 0) {
        variants = sizes.map((size, index) => {
          const label = String(size.size || size.value || 'Standard').trim() || 'Standard';
          return {
            option1: label,
            price: (productData.price || 0).toFixed(2),
            sku: productData.reference || `${productData.kimlandId}-${index}`,
            inventory_quantity: Math.max(0, size.quantity || 0),
            inventory_management: 'shopify',
            inventory_policy: 'deny',
            fulfillment_service: 'manual',
            requires_shipping: true,
            taxable: false,
            position: index + 1,
            cost: (productData.costPrice || 0).toFixed(2)
          };
        });
      } else {
        // Single product (montre, accessoire…) → option "Standard", not Default Title
        variants = [{
          option1: 'Standard',
          price: (productData.price || 0).toFixed(2),
          sku: productData.reference || 'PROD',
          inventory_quantity: Math.max(0, productData.totalStock || 0),
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          fulfillment_service: 'manual',
          requires_shipping: true,
          taxable: false,
          cost: (productData.costPrice || 0).toFixed(2)
        }];
      }

      const images = (productData.images || []).map((img, index) => ({
        src: img,
        position: index + 1,
        alt: `${formattedTitle} - Image ${index + 1}`
      }));

      // Always send options so Shopify does not invent "Default Title"
      const optionValues = variants.map(v => v.option1);
      const uniqueValues = [...new Set(optionValues)];
      const options = [{
        name: optionName === 'pointure' ? 'Pointure' : (optionName === 'dimension' ? 'Dimension' : (optionName || 'Taille')),
        values: uniqueValues
      }];

      const shopifyProduct = {
        product: {
          title: formattedTitle,
          body_html: '',
          vendor: 'Signateur Confort',
          product_type: this.determineProductType(productData.title || ''),
          variants: variants,
          options: options,
          images: images,
          status: 'active',
          published_at: new Date().toISOString(),
          published_scope: 'global'
        }
      };

      if (productData.reference) {
        shopifyProduct.product.metafields = [
          {
            namespace: 'custom',
            key: 'kimland_reference',
            value: productData.reference,
            type: 'single_line_text_field'
          },
          {
            namespace: 'custom',
            key: 'kimland_id',
            value: productData.kimlandId || '',
            type: 'single_line_text_field'
          }
        ];
      }

      const response = await this.retryRequest(async () => {
        return await axios.post(
          `${this.baseUrl}/products.json`,
          shopifyProduct,
          { headers: this.headers }
        );
      });

      const createdProduct = response.data.product;
      logger.info(`✅ Created product: ${createdProduct.title} (ID: ${createdProduct.id})`);

      await this.publishToAllChannels(createdProduct.id);

      return createdProduct;

    } catch (error) {
      this.logApiError(error, 'createProduct');
      throw error;
    }
  }

  async updateProduct(productId, productData) {
    try {
      let variants = productData.variants || productData.sizes || [];
      if (variants.length === 0) {
        logger.warn(`⚠️ No variants provided for product ${productId}, keeping existing variants`);
        const existingProduct = await this.getProduct(productId);
        if (existingProduct && existingProduct.variants && existingProduct.variants.length > 0) {
          variants = existingProduct.variants.map(v => ({
            id: v.id,
            option1: v.option1 || 'Standard',
            price: (productData.price !== undefined ? productData.price : parseFloat(v.price)).toFixed(2),
            sku: productData.reference || v.sku || '',
            cost: (productData.costPrice !== undefined ? productData.costPrice : parseFloat(v.cost || 0)).toFixed(2),
            inventory_quantity: v.inventory_quantity || 0,
            inventory_management: 'shopify',
            inventory_policy: v.inventory_policy || 'deny',
            fulfillment_service: v.fulfillment_service || 'manual',
            requires_shipping: true,
            taxable: false,
            position: v.position || 1,
          }));
          logger.info(`✅ Keeping ${variants.length} existing variants`);
        } else {
          variants = [{
            option1: 'Standard',
            price: (productData.price || 0).toFixed(2),
            sku: productData.reference || '',
            cost: (productData.costPrice || 0).toFixed(2),
            inventory_quantity: 0,
            inventory_management: 'shopify',
            inventory_policy: 'deny',
            fulfillment_service: 'manual',
            requires_shipping: true,
            taxable: false,
            position: 1,
          }];
          logger.info(`✅ Created default variant`);
        }
      } else {
        variants = variants.map((v, index) => ({
          id: v.id || undefined,
          option1: v.value || v.size || 'Standard',
          price: (productData.price !== undefined ? productData.price : v.price || 0).toFixed(2),
          sku: v.sku || productData.reference || '',
          cost: (productData.costPrice !== undefined ? productData.costPrice : v.cost || 0).toFixed(2),
          inventory_quantity: v.quantity !== undefined ? v.quantity : 0,
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          fulfillment_service: 'manual',
          requires_shipping: true,
          taxable: false,
          position: index + 1,
        }));
      }

      const formattedTitle = productData.reference
        ? `${productData.title} - ${productData.reference}`
        : productData.title;

      const productPayload = {
        product: {
          id: productId,
          title: formattedTitle,
          body_html: productData.description || '',
          vendor: 'Signateur Confort',
          product_type: this.determineProductType(productData.title || ''),
          variants: variants,
          images: (productData.images || []).map((img, index) => ({
            src: img,
            position: index + 1,
          })),
          published_scope: 'global',
          status: 'active'
        }
      };

      const response = await this.retryRequest(async () => {
        return await axios.put(
          `${this.baseUrl}/products/${productId}.json`,
          productPayload,
          { headers: this.headers }
        );
      });

      logger.info(`✅ Updated product: ${formattedTitle}`);

      await this.publishToAllChannels(productId);

      return response.data.product;

    } catch (error) {
      this.logApiError(error, 'updateProduct');
      throw error;
    }
  }

  async getProduct(productId) {
    try {
      const response = await this.retryRequest(async () => {
        return await axios.get(
          `${this.baseUrl}/products/${productId}.json`,
          { headers: this.headers }
        );
      });
      return response.data.product;
    } catch (error) {
      this.logApiError(error, 'getProduct');
      return null;
    }
  }

  async getProductBySku(sku) {
    try {
      const products = await this.getAllProducts(250);
      for (const product of products) {
        if (product.variants && product.variants.length > 0) {
          for (const variant of product.variants) {
            if (variant.sku === sku) {
              return product;
            }
          }
        }
      }
      return null;
    } catch (error) {
      this.logApiError(error, 'getProductBySku');
      return null;
    }
  }

  async updateInventory(variantId, quantity) {
    try {
      const variantResponse = await this.retryRequest(async () => {
        return await axios.get(
          `${this.baseUrl}/variants/${variantId}.json`,
          { headers: this.headers }
        );
      });

      const inventoryItemId = variantResponse.data.variant.inventory_item_id;

      const locationsResponse = await this.retryRequest(async () => {
        return await axios.get(
          `${this.baseUrl}/locations.json`,
          { headers: this.headers }
        );
      });

      const locationId = locationsResponse.data.locations[0]?.id;
      if (!locationId) {
        throw new Error('No location found');
      }

      const safeQuantity = Math.max(0, quantity);

      const response = await this.retryRequest(async () => {
        return await axios.post(
          `${this.baseUrl}/inventory_levels/set.json`,
          {
            inventory_item_id: inventoryItemId,
            location_id: locationId,
            available: safeQuantity
          },
          { headers: this.headers }
        );
      });

      logger.info(`✅ Updated inventory: ${safeQuantity} units`);
      return response.data.inventory_level;

    } catch (error) {
      this.logApiError(error, 'updateInventory');
      throw error;
    }
  }

  // =============================================
  // SIZE NORMALIZATION (Kimland 2XL = Shopify XXL)
  // =============================================
  normalizeSize(size) {
    if (!size) return '';
    let s = String(size).trim().toLowerCase().replace(/\s+/g, '');
    s = s.replace(/[_]/g, '');

    const aliases = {
      // 2XL = XXL (same size)
      '2xl': 'xxl', 'xxl': 'xxl', 'xxlarge': 'xxl', '2x': 'xxl',
      // 3XL = XXXL
      '3xl': 'xxxl', 'xxxl': 'xxxl', '3x': 'xxxl',
      '4xl': 'xxxxl', 'xxxxl': 'xxxxl', '4x': 'xxxxl',
      '5xl': 'xxxxxl', 'xxxxxl': 'xxxxxl',
      // extra small
      '2xs': 'xxs', 'xxs': 'xxs', 'xxsmall': 'xxs',
      '3xs': 'xxxs', 'xxxs': 'xxxs',
      // standard
      'xs': 'xs', 'xsmall': 'xs', 'extra-small': 'xs', 'extrasmall': 'xs',
      's': 's', 'small': 's',
      'm': 'm', 'medium': 'm', 'med': 'm',
      'l': 'l', 'large': 'l',
      'xl': 'xl', 'xlarge': 'xl', 'extra-large': 'xl', 'extralarge': 'xl',
      // one size
      'unique': 'unique', 'onesize': 'unique', 'one-size': 'unique', 'os': 'unique',
      'standard': 'standard', 'tu': 'unique', 'u': 'unique'
    };

    if (aliases[s]) return aliases[s];
    return s;
  }

  // Preferred label on Shopify (always XXL not 2XL)
  toShopifySizeLabel(kimlandValue) {
    const norm = this.normalizeSize(kimlandValue);
    const preferred = {
      xxl: 'XXL',
      xxxl: 'XXXL',
      xxxxl: 'XXXXL',
      xxxxxl: 'XXXXXL',
      xxs: 'XXS',
      xxxs: 'XXXS',
      xs: 'XS',
      s: 'S',
      m: 'M',
      l: 'L',
      xl: 'XL'
    };
    if (preferred[norm]) return preferred[norm];
    // numeric / other (40.5, 42, Standard...) keep Kimland text
    return String(kimlandValue || '').trim();
  }

  // Find Kimland size entry that matches a Shopify option1 (2XL = XXL)
  matchKimlandSize(shopifyOption, kimlandSizeMap) {
    const raw = String(shopifyOption || '').trim().toLowerCase();
    // Shopify leftover "Default Title" → match unique Kimland size (ex: Standard)
    if (raw === 'default title' || raw === 'default' || raw === 'title') {
      if (kimlandSizeMap.size === 1) {
        return kimlandSizeMap.values().next().value;
      }
      for (const [, v] of kimlandSizeMap) {
        const n = this.normalizeSize(v.value);
        if (n === 'standard' || n === 'unique') return v;
      }
    }

    const key = this.normalizeSize(shopifyOption);
    for (const [k, v] of kimlandSizeMap) {
      if (this.normalizeSize(k) === key || this.normalizeSize(v.value) === key) return v;
    }
    return null;
  }

  // =============================================
  // FULL REPAIR PRODUCT
  // Kimland = source of truth for sizes/stock/price/sku
  // =============================================
  async repairProduct(shopifyProductId, kimlandData) {
    try {
      logger.info(`🛠️ Starting FULL REPAIR for Shopify product #${shopifyProductId}`);

      const existing = await this.getProduct(shopifyProductId);
      if (!existing) {
        throw new Error(`Shopify product ${shopifyProductId} not found`);
      }

      const kimlandVariants = kimlandData.variants || kimlandData.sizes || [];
      const kimlandImages = kimlandData.images || [];
      const sellingPrice = (kimlandData.price || 0).toFixed(2);
      const costPrice = (kimlandData.costPrice || 0).toFixed(2);
      const reference = kimlandData.reference || '';

      // Kimland sizes (keep original label as display value)
      const kimlandSizeMap = new Map(); // normalizedKey -> { value: original, quantity }
      for (const v of kimlandVariants) {
        const original = String(v.value || v.size || '').trim();
        if (!original) continue;
        const norm = this.normalizeSize(original);
        kimlandSizeMap.set(norm, {
          value: original, // Kimland label wins (e.g. 2XL)
          quantity: Math.max(0, v.quantity || 0),
          norm
        });
      }

      const existingVariants = existing.variants || [];
      logger.info(`📏 Kimland sizes: ${[...kimlandSizeMap.values()].map(v => v.value + ':' + v.quantity).join(', ')}`);
      logger.info(`📏 Shopify sizes: ${existingVariants.map(v => v.option1).join(', ')}`);

      // --------------------------------------------------
      // STEP 1: Title / status (no options)
      // --------------------------------------------------
      const formattedTitle = reference
        ? `${kimlandData.title} - ${reference}`
        : (kimlandData.title || existing.title);

      try {
        await this.retryRequest(async () => {
          return await axios.put(
            `${this.baseUrl}/products/${shopifyProductId}.json`,
            {
              product: {
                id: shopifyProductId,
                title: formattedTitle,
                body_html: kimlandData.description || existing.body_html || '',
                vendor: existing.vendor || 'Signateur Confort',
                product_type: this.determineProductType(kimlandData.title || existing.title || ''),
                status: 'active',
                published_scope: 'global'
              }
            },
            { headers: this.headers }
          );
        });
        logger.info(`✅ Title/status updated: ${formattedTitle}`);
      } catch (e) {
        logger.warn(`⚠️ Title update failed (continuing): ${e.message}`);
      }

      // --------------------------------------------------
      // STEP 2: Match Shopify variants ↔ Kimland (aliases)
      // Try to RENAME option1 to Kimland label (2XL not XXL)
      // If metafield blocks rename → keep name, still sync stock
      // --------------------------------------------------
      const inventoryResults = [];
      const usedKimNorm = new Set();
      let updatedCount = 0;
      let renamedCount = 0;
      let matchedCount = 0;

      for (const sv of existingVariants) {
        const kim = this.matchKimlandSize(sv.option1, kimlandSizeMap);
        const shopifyLabel = String(sv.option1 || '').trim();

        if (kim) {
          matchedCount++;
          usedKimNorm.add(kim.norm);

          // Prefer Kimland label on Shopify
          // 2XL (Kimland) = XXL (Shopify) — prefer Shopify-style label XXL
          const desiredLabel = this.toShopifySizeLabel(kim.value);
          // Only rename for case fixes (Xl→XL), NEVER force 2XL over XXL
          // If already same size via alias (XXL ↔ 2XL), keep Shopify name
          const sameByAlias = this.normalizeSize(shopifyLabel) === this.normalizeSize(kim.value);
          const needsRename = sameByAlias
            && shopifyLabel.toLowerCase() !== desiredLabel.toLowerCase()
            && this.normalizeSize(shopifyLabel) !== 'xxl'; // keep XXL as-is when Kimland says 2XL

          // Update variant: price, sku, barcode, optionally option1
          const variantBody = {
            id: sv.id,
            price: sellingPrice,
            sku: reference || sv.sku || '',
            barcode: reference || sv.barcode || '',
            inventory_management: 'shopify',
            inventory_policy: 'deny'
          };

          if (needsRename) {
            variantBody.option1 = desiredLabel;
          }

          let renameOk = true;
          try {
            await this.retryRequest(async () => {
              return await axios.put(
                `${this.baseUrl}/variants/${sv.id}.json`,
                { variant: variantBody },
                { headers: this.headers }
              );
            });
            updatedCount++;
            if (needsRename) {
              renamedCount++;
              logger.info(`✅ Variant ${shopifyLabel} → renamed to "${desiredLabel}" + SKU/price set`);
            } else {
              logger.info(`✅ Variant ${shopifyLabel} → SKU=${reference || '(keep)'} price=${sellingPrice}`);
            }
          } catch (ve) {
            const errData = ve.response?.data ? JSON.stringify(ve.response.data) : ve.message;
            // If rename failed (metafield), retry WITHOUT option1 change
            if (needsRename) {
              logger.warn(`⚠️ Rename ${shopifyLabel}→${desiredLabel} blocked, retry without rename: ${errData}`);
              renameOk = false;
              try {
                await this.retryRequest(async () => {
                  return await axios.put(
                    `${this.baseUrl}/variants/${sv.id}.json`,
                    {
                      variant: {
                        id: sv.id,
                        price: sellingPrice,
                        sku: reference || sv.sku || '',
                        barcode: reference || sv.barcode || '',
                        inventory_management: 'shopify',
                        inventory_policy: 'deny'
                      }
                    },
                    { headers: this.headers }
                  );
                });
                updatedCount++;
                logger.info(`✅ Variant ${shopifyLabel} updated (kept name, stock will use Kimland ${kim.value})`);
              } catch (ve2) {
                logger.warn(`⚠️ Variant update failed for ${shopifyLabel}: ${ve2.message}`);
              }
            } else {
              logger.warn(`⚠️ Variant update failed for ${shopifyLabel}: ${errData}`);
            }
          }

          // Cost
          try {
            if (sv.inventory_item_id) {
              await this.retryRequest(async () => {
                return await axios.put(
                  `${this.baseUrl}/inventory_items/${sv.inventory_item_id}.json`,
                  { inventory_item: { id: sv.inventory_item_id, cost: costPrice } },
                  { headers: this.headers }
                );
              });
            }
          } catch (ce) {
            logger.warn(`⚠️ Cost update failed for ${shopifyLabel}: ${ce.message}`);
          }

          // Inventory from Kimland
          try {
            await this.updateInventory(sv.id, kim.quantity);
            inventoryResults.push({
              size: renameOk && needsRename ? desiredLabel : shopifyLabel,
              kimlandSize: kim.value,
              quantity: kim.quantity,
              success: true,
              matched: true,
              renamed: needsRename && renameOk
            });
          } catch (invErr) {
            inventoryResults.push({
              size: shopifyLabel,
              kimlandSize: kim.value,
              quantity: kim.quantity,
              success: false,
              error: invErr.message
            });
          }
        } else {
          // No Kimland match → set stock 0, still fix SKU/price
          logger.warn(`⚠️ Shopify size "${shopifyLabel}" has no Kimland match → stock 0`);
          try {
            await this.retryRequest(async () => {
              return await axios.put(
                `${this.baseUrl}/variants/${sv.id}.json`,
                {
                  variant: {
                    id: sv.id,
                    price: sellingPrice,
                    sku: reference || sv.sku || '',
                    barcode: reference || sv.barcode || '',
                    inventory_management: 'shopify',
                    inventory_policy: 'deny'
                  }
                },
                { headers: this.headers }
              );
            });
            updatedCount++;
          } catch (_) {}

          try {
            if (sv.inventory_item_id) {
              await axios.put(
                `${this.baseUrl}/inventory_items/${sv.inventory_item_id}.json`,
                { inventory_item: { id: sv.inventory_item_id, cost: costPrice } },
                { headers: this.headers }
              ).catch(() => {});
            }
          } catch (_) {}

          try {
            await this.updateInventory(sv.id, 0);
            inventoryResults.push({ size: shopifyLabel, quantity: 0, success: true, matched: false });
          } catch (e) {
            inventoryResults.push({ size: shopifyLabel, quantity: 0, success: false, error: e.message });
          }
        }
      }

      // --------------------------------------------------
      // STEP 3: ADD Kimland sizes that don't exist on Shopify
      // (e.g. Kimland has 2XL, Shopify only had L/M/S → add 2XL)
      // --------------------------------------------------
      const missingKim = [];
      for (const [norm, kim] of kimlandSizeMap) {
        if (!usedKimNorm.has(norm)) missingKim.push(kim);
      }

      let addedCount = 0;
      if (missingKim.length > 0 && existingVariants.length > 0) {
        logger.info(`📦 Adding missing Kimland sizes to Shopify: ${missingKim.map(k => k.value).join(', ')}`);

        // Refresh product (ids may be same)
        const fresh = await this.getProduct(shopifyProductId);
        const keepExisting = (fresh.variants || []).map((sv, i) => ({
          id: sv.id,
          option1: sv.option1,
          position: i + 1
        }));

        const newVars = missingKim.map((kim, i) => ({
          option1: this.toShopifySizeLabel(kim.value), // 2XL → XXL on Shopify
          price: sellingPrice,
          sku: reference || `${kimlandData.kimlandId || 'KIM'}`,
          barcode: reference || '',
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          fulfillment_service: 'manual',
          requires_shipping: true,
          taxable: false,
          position: keepExisting.length + i + 1
        }));

        try {
          const addRes = await this.retryRequest(async () => {
            return await axios.put(
              `${this.baseUrl}/products/${shopifyProductId}.json`,
              {
                product: {
                  id: shopifyProductId,
                  variants: [...keepExisting, ...newVars]
                  // no options field → avoids metafield rename errors
                }
              },
              { headers: this.headers }
            );
          });

          const after = addRes.data.product;
          const beforeIds = new Set(keepExisting.map(v => v.id));
          for (const sv of (after.variants || [])) {
            if (beforeIds.has(sv.id)) continue;
            addedCount++;
            const kim = this.matchKimlandSize(sv.option1, kimlandSizeMap);
            const qty = kim ? kim.quantity : 0;
            try {
              if (sv.inventory_item_id) {
                await axios.put(
                  `${this.baseUrl}/inventory_items/${sv.inventory_item_id}.json`,
                  { inventory_item: { id: sv.inventory_item_id, cost: costPrice } },
                  { headers: this.headers }
                );
              }
            } catch (_) {}
            try {
              await this.updateInventory(sv.id, qty);
              inventoryResults.push({ size: sv.option1, quantity: qty, success: true, matched: true, added: true });
              logger.info(`✅ Added size ${sv.option1} with stock ${qty}`);
            } catch (e) {
              inventoryResults.push({ size: sv.option1, quantity: qty, success: false, added: true, error: e.message });
            }
          }
        } catch (addErr) {
          const errMsg = addErr.response?.data ? JSON.stringify(addErr.response.data) : addErr.message;
          logger.warn(`⚠️ Could not add missing sizes: ${errMsg}`);
        }
      }

      // --------------------------------------------------
      // STEP 4: Images
      // --------------------------------------------------
      let imagesAdded = 0;
      const existingImageSrcs = (existing.images || []).map(img => img.src || '');
      for (const src of kimlandImages) {
        const alreadyExists = existingImageSrcs.some(existingSrc => {
          const a = (existingSrc || '').split('/').pop();
          const b = (src || '').split('/').pop();
          return a && b && (existingSrc.includes(b) || src.includes(a));
        });
        if (alreadyExists) continue;
        try {
          await this.retryRequest(async () => {
            return await axios.post(
              `${this.baseUrl}/products/${shopifyProductId}/images.json`,
              { image: { src, alt: formattedTitle } },
              { headers: this.headers }
            );
          });
          imagesAdded++;
        } catch (imgErr) {
          logger.warn(`⚠️ Image add failed: ${imgErr.message}`);
        }
      }

      // --------------------------------------------------
      // STEP 5: Publish
      // --------------------------------------------------
      try {
        await this.publishToAllChannels(shopifyProductId);
      } catch (e) {
        logger.warn('Publish after repair failed (non-critical):', e.message);
      }

      const repaired = await this.getProduct(shopifyProductId);

      const report = {
        shopifyId: shopifyProductId,
        title: repaired?.title || formattedTitle,
        variantsBefore: existingVariants.length,
        variantsAfter: (repaired?.variants || []).length,
        variantsUpdated: updatedCount,
        variantsMatched: matchedCount,
        variantsRenamed: renamedCount,
        variantsAdded: addedCount,
        imagesAdded,
        imagesTotal: (repaired?.images || []).length,
        inventoryUpdates: inventoryResults,
        referenceSet: reference,
        costPrice,
        sellingPrice
      };

      logger.info(`🎉 FULL REPAIR COMPLETE for #${shopifyProductId}`);
      logger.info(`   Matched: ${matchedCount} | Renamed: ${renamedCount} | Added: ${addedCount}`);
      logger.info(`   Images added: ${imagesAdded}`);
      logger.info(`   SKU on all variants: ${reference}`);
      logger.info(`   Price: ${sellingPrice} DA | Cost: ${costPrice} DA`);

      return { success: true, product: repaired, report };

    } catch (error) {
      this.logApiError(error, 'repairProduct');
      throw error;
    }
  }

  // =============================================
  // SYNC PRICE + STOCK ONLY (no title / description / photos)
  // Option B: also ADD missing sizes from Kimland
  // =============================================
  async syncPriceAndStock(shopifyProductId, kimlandData) {
    try {
      logger.info(`🔄 SYNC price+stock for Shopify #${shopifyProductId}`);

      // Hard safety: never overwrite Shopify with empty/failed scrape
      const title = String(kimlandData?.title || '').trim();
      const price = Number(kimlandData?.price || 0);
      const variants = kimlandData?.variants || kimlandData?.sizes || [];
      if (!title || /^not\s*found$/i.test(title) || price <= 0) {
        throw new Error(
          `Refusing sync: invalid Kimland data (title="${title}", price=${price}, variants=${variants.length})`
        );
      }

      const existing = await this.getProduct(shopifyProductId);
      if (!existing) throw new Error(`Shopify product ${shopifyProductId} not found`);

      const kimlandVariants = kimlandData.variants || kimlandData.sizes || [];
      const sellingPrice = (kimlandData.price || 0).toFixed(2);
      const costPrice = (kimlandData.costPrice || 0).toFixed(2);
      const reference = kimlandData.reference || '';

      const kimlandSizeMap = new Map();
      for (const v of kimlandVariants) {
        const original = String(v.value || v.size || '').trim();
        if (!original) continue;
        const norm = this.normalizeSize(original);
        kimlandSizeMap.set(norm, {
          value: original,
          quantity: Math.max(0, v.quantity || 0),
          norm
        });
      }

      const existingVariants = existing.variants || [];
      const usedKimNorm = new Set();
      const inventoryResults = [];
      let updatedCount = 0;
      let matchedCount = 0;
      let addedCount = 0;

      // --- Update existing variants (price + cost + stock), do not touch title/images ---
      for (const sv of existingVariants) {
        const kim = this.matchKimlandSize(sv.option1, kimlandSizeMap);
        const shopifyLabel = String(sv.option1 || '').trim();

        try {
          await this.retryRequest(async () => {
            return await axios.put(
              `${this.baseUrl}/variants/${sv.id}.json`,
              {
                variant: {
                  id: sv.id,
                  price: sellingPrice,
                  sku: reference || sv.sku || '',
                  barcode: reference || sv.barcode || '',
                  inventory_management: 'shopify',
                  inventory_policy: 'deny'
                }
              },
              { headers: this.headers }
            );
          });
          updatedCount++;
        } catch (e) {
          logger.warn(`⚠️ Variant price update failed ${shopifyLabel}: ${e.message}`);
        }

        try {
          if (sv.inventory_item_id) {
            await this.retryRequest(async () => {
              return await axios.put(
                `${this.baseUrl}/inventory_items/${sv.inventory_item_id}.json`,
                { inventory_item: { id: sv.inventory_item_id, cost: costPrice } },
                { headers: this.headers }
              );
            });
          }
        } catch (e) {
          logger.warn(`⚠️ Cost update failed ${shopifyLabel}: ${e.message}`);
        }

        if (kim) {
          matchedCount++;
          usedKimNorm.add(kim.norm);
          try {
            await this.updateInventory(sv.id, kim.quantity);
            inventoryResults.push({ size: shopifyLabel, kimlandSize: kim.value, quantity: kim.quantity, success: true });
          } catch (e) {
            inventoryResults.push({ size: shopifyLabel, quantity: kim.quantity, success: false, error: e.message });
          }
        } else {
          // size only on Shopify → set 0 so stock matches Kimland
          try {
            await this.updateInventory(sv.id, 0);
            inventoryResults.push({ size: shopifyLabel, quantity: 0, success: true, matched: false });
          } catch (e) {
            inventoryResults.push({ size: shopifyLabel, quantity: 0, success: false, error: e.message });
          }
        }
      }

      // --- Option B: ADD missing Kimland sizes ---
      const missingKim = [];
      for (const [norm, kim] of kimlandSizeMap) {
        if (!usedKimNorm.has(norm)) missingKim.push(kim);
      }

      if (missingKim.length > 0 && existingVariants.length > 0) {
        logger.info(`📦 Sync adding missing sizes: ${missingKim.map(k => k.value).join(', ')}`);
        const fresh = await this.getProduct(shopifyProductId);
        const keepExisting = (fresh.variants || []).map((sv, i) => ({
          id: sv.id,
          option1: sv.option1,
          position: i + 1
        }));

        const newVars = missingKim.map((kim, i) => ({
          option1: this.toShopifySizeLabel(kim.value),
          price: sellingPrice,
          sku: reference || `${kimlandData.kimlandId || 'KIM'}`,
          barcode: reference || '',
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          fulfillment_service: 'manual',
          requires_shipping: true,
          taxable: false,
          position: keepExisting.length + i + 1
        }));

        try {
          const addRes = await this.retryRequest(async () => {
            return await axios.put(
              `${this.baseUrl}/products/${shopifyProductId}.json`,
              {
                product: {
                  id: shopifyProductId,
                  variants: [...keepExisting, ...newVars]
                }
              },
              { headers: this.headers }
            );
          });

          const after = addRes.data.product;
          const beforeIds = new Set(keepExisting.map(v => v.id));
          for (const sv of (after.variants || [])) {
            if (beforeIds.has(sv.id)) continue;
            addedCount++;
            const kim = this.matchKimlandSize(sv.option1, kimlandSizeMap);
            const qty = kim ? kim.quantity : 0;
            try {
              if (sv.inventory_item_id) {
                await axios.put(
                  `${this.baseUrl}/inventory_items/${sv.inventory_item_id}.json`,
                  { inventory_item: { id: sv.inventory_item_id, cost: costPrice } },
                  { headers: this.headers }
                );
              }
            } catch (_) {}
            try {
              await this.updateInventory(sv.id, qty);
              inventoryResults.push({ size: sv.option1, quantity: qty, success: true, added: true });
              logger.info(`✅ Added size ${sv.option1} stock=${qty}`);
            } catch (e) {
              inventoryResults.push({ size: sv.option1, quantity: qty, success: false, added: true, error: e.message });
            }
          }
        } catch (addErr) {
          const errMsg = addErr.response?.data ? JSON.stringify(addErr.response.data) : addErr.message;
          logger.warn(`⚠️ Could not add missing sizes during sync: ${errMsg}`);
        }
      }

      const report = {
        shopifyId: shopifyProductId,
        title: existing.title,
        reference,
        sellingPrice,
        costPrice,
        variantsUpdated: updatedCount,
        variantsMatched: matchedCount,
        variantsAdded: addedCount,
        inventoryUpdates: inventoryResults,
        // title / description / images intentionally NOT changed
        touchedTitle: false,
        touchedDescription: false,
        touchedImages: false
      };

      logger.info(`🎉 SYNC COMPLETE #${shopifyProductId} | matched=${matchedCount} added=${addedCount} price=${sellingPrice} cost=${costPrice}`);
      return { success: true, report };

    } catch (error) {
      this.logApiError(error, 'syncPriceAndStock');
      throw error;
    }
  }

  // Find best matching Shopify product for a Kimland product
  findBestMatch(kimlandProduct, shopifyProducts) {
    if (!kimlandProduct || !shopifyProducts || shopifyProducts.length === 0) {
      return null;
    }

    const ref = (kimlandProduct.reference || '').toLowerCase().trim();
    const title = (kimlandProduct.title || '').toLowerCase().trim();
    const cleanTitle = title.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const titleWords = cleanTitle.split(' ').filter(w => w.length > 2);

    let best = null;
    let bestScore = 0;

    for (const p of shopifyProducts) {
      let score = 0;
      let method = 'none';
      const pTitle = (p.title || '').toLowerCase();
      const pTitleClean = pTitle.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

      // 1. Strong SKU / barcode match
      for (const v of (p.variants || [])) {
        const sku = (v.sku || '').toLowerCase();
        const barcode = (v.barcode || '').toLowerCase();
        if (ref) {
          if (sku === ref || barcode === ref) {
            return { product: p, method: 'exact_sku', confidence: 100 };
          }
          if (sku.includes(ref) || barcode.includes(ref) || (ref.includes(sku) && sku.length > 3)) {
            score = Math.max(score, 95);
            method = 'partial_sku';
          }
        }
      }

      // 2. Reference appears in Shopify title
      if (ref && pTitle.includes(ref)) {
        score = Math.max(score, 92);
        method = 'reference_in_title';
      }

      // 3. Full title containment
      if (cleanTitle && pTitleClean) {
        if (pTitleClean === cleanTitle) {
          score = Math.max(score, 90);
          method = 'exact_title';
        } else if (pTitleClean.includes(cleanTitle) || cleanTitle.includes(pTitleClean)) {
          score = Math.max(score, 85);
          method = 'title_contains';
        }
      }

      // 4. Word overlap (ADIDAS + MULTIX + H04470)
      if (titleWords.length > 0) {
        const pWords = new Set(pTitleClean.split(' ').filter(w => w.length > 2));
        let common = 0;
        for (const w of titleWords) {
          if (pWords.has(w)) common++;
        }
        const wordScore = (common / titleWords.length) * 100;
        if (common >= 2) {
          const bonusScore = Math.min(88, wordScore + 15);
          if (bonusScore > score) {
            score = bonusScore;
            method = 'word_overlap';
          }
        } else if (wordScore > score) {
          score = wordScore;
          method = 'word_overlap';
        }
      }

      // 5. Product code core match (H04470, G21-000175, etc.)
      if (ref && ref.length >= 4) {
        const refCore = ref.replace(/[^a-z0-9]/g, '');
        if (refCore.length >= 4) {
          for (const v of (p.variants || [])) {
            const skuCore = (v.sku || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (skuCore.includes(refCore) || refCore.includes(skuCore)) {
              score = Math.max(score, 88);
              method = 'sku_core_match';
            }
          }
          if (pTitle.replace(/[^a-z0-9]/g, '').includes(refCore)) {
            score = Math.max(score, 86);
            method = 'ref_in_title_core';
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = { product: p, method, confidence: Math.round(score) };
      }
    }

    // Accept from 50% (was too strict at 60/65)
    if (best && best.confidence >= 50) {
      return best;
    }
    return null;
  }

  isDefaultTitleLabel(label) {
    const s = String(label || '').trim().toLowerCase();
    return (
      s === 'default title' ||
      s === 'default' ||
      s === 'title' ||
      s === 'titre par défaut' ||
      s === 'titre par defaut' ||
      s === 'défaut' ||
      s === 'defaut'
    );
  }

  /**
   * Fix "Default Title" on one Shopify product.
   * - 1 variant Default Title → rename to Standard
   * - Default Title + other real sizes → remove Default Title variant from product
   * - Default Title only among many → rename to Standard if no Standard exists
   */
  async fixDefaultTitleOnProduct(productId) {
    const product = await this.getProduct(productId);
    if (!product) return { fixed: false, reason: 'not_found' };

    const variants = product.variants || [];
    const defaults = variants.filter((v) => this.isDefaultTitleLabel(v.option1));
    if (defaults.length === 0) {
      return { fixed: false, reason: 'none', title: product.title };
    }

    const realVariants = variants.filter((v) => !this.isDefaultTitleLabel(v.option1));

    // Case A: only default variant(s), no real sizes
    if (realVariants.length === 0) {
      for (const v of defaults) {
        try {
          await this.retryRequest(async () => {
            return await axios.put(
              `${this.baseUrl}/variants/${v.id}.json`,
              { variant: { id: v.id, option1: 'Standard' } },
              { headers: this.headers }
            );
          });
        } catch (e) {
          logger.warn(`⚠️ Rename Default→Standard failed #${v.id}: ${e.message}`);
          return { fixed: false, reason: e.message, title: product.title };
        }
      }
      // Ensure product option values include Standard
      try {
        await this.retryRequest(async () => {
          return await axios.put(
            `${this.baseUrl}/products/${productId}.json`,
            {
              product: {
                id: productId,
                options: [{ name: (product.options && product.options[0] && product.options[0].name) || 'Dimension', values: ['Standard'] }]
              }
            },
            { headers: this.headers }
          );
        });
      } catch (_) {}
      logger.info(`✅ Fixed Default Title → Standard: ${product.title}`);
      return { fixed: true, action: 'renamed_to_standard', title: product.title };
    }

    // Case B: has real sizes + Default Title ghost → rebuild product variants without Default Title
    try {
      const kept = realVariants.map((v, index) => ({
        id: v.id,
        option1: v.option1,
        price: v.price,
        sku: v.sku,
        barcode: v.barcode,
        inventory_management: v.inventory_management || 'shopify',
        inventory_policy: v.inventory_policy || 'deny',
        fulfillment_service: v.fulfillment_service || 'manual',
        requires_shipping: v.requires_shipping !== false,
        taxable: false,
        position: index + 1
      }));

      const optionValues = [...new Set(kept.map((v) => v.option1))];
      const optionName = (product.options && product.options[0] && product.options[0].name) || 'Taille';

      await this.retryRequest(async () => {
        return await axios.put(
          `${this.baseUrl}/products/${productId}.json`,
          {
            product: {
              id: productId,
              variants: kept,
              options: [{ name: optionName, values: optionValues }]
            }
          },
          { headers: this.headers }
        );
      });

      logger.info(`✅ Removed Default Title ghost from: ${product.title} (kept ${kept.length} sizes)`);
      return { fixed: true, action: 'removed_default_kept_sizes', title: product.title, kept: kept.length };
    } catch (e) {
      logger.warn(`⚠️ Remove Default Title failed ${product.title}: ${e.message}`);
      return { fixed: false, reason: e.message, title: product.title };
    }
  }

  determineProductType(title) {
    const lower = title.toLowerCase();
    if (lower.includes('chaussure') || lower.includes('shoe') || lower.includes('pointure')) return 'Shoes';
    if (lower.includes('robe') || lower.includes('dress')) return 'Dress';
    if (lower.includes('pantalon') || lower.includes('jeans') || lower.includes('short')) return 'Pants';
    if (lower.includes('veste') || lower.includes('jacket')) return 'Jacket';
    if (lower.includes('polo')) return 'Polo';
    if (lower.includes('t-shirt') || lower.includes('tshirt')) return 'T-Shirt';
    return 'Clothing';
  }

  logApiError(error, method) {
    if (error.response) {
      logger.error(`❌ Shopify API Error (${method}):`, {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    } else if (error.request) {
      logger.error(`❌ Network Error (${method}):`, error.message);
    } else {
      logger.error(`❌ Error (${method}):`, error.message);
    }
  }
}

module.exports = ShopifyClient;