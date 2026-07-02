// src/shopify/shopifyClient.js

const axios = require('axios');
const logger = require('../utils/logger');

class ShopifyClient {
  constructor() {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    let apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
    if (apiVersion.startsWith('2026')) {
      logger.warn(`⚠️ Version API ${apiVersion} instable. Utilisation de 2024-01.`);
      apiVersion = '2024-01';
    }
    
    let shopifyStore = storeUrl;
    if (!storeUrl.includes('.myshopify.com') && !storeUrl.includes('.')) {
      shopifyStore = `${storeUrl}.myshopify.com`;
    }
    
    this.baseUrl = `https://${shopifyStore}/admin/api/${apiVersion}`;
    this.graphqlUrl = `https://${shopifyStore}/admin/api/${apiVersion}/graphql.json`; // ✅ GraphQL endpoint
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
        logger.warn(`⚠️ Tentative ${attempt}/${maxRetries} échouée, réessai dans ${delayMs}ms...`);
        await this.delay(delayMs);
      }
    }
  }

  // =============================================
  // PUBLIER SUR TOUS LES CANAUX (GraphQL)
  // =============================================
  async publishToAllChannels(productId) {
    try {
      logger.info("📢 Publication du produit sur tous les canaux de vente...");

      // Récupérer la liste de toutes les publications (canaux)
      const publicationsResponse = await axios.post(
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

      const publications = publicationsResponse.data.data?.publications?.nodes || [];
      logger.info(`📡 ${publications.length} publications trouvées`);

      if (publications.length === 0) {
        logger.warn("⚠️ Aucune publication trouvée. Vérifiez vos canaux de vente.");
        return;
      }

      const productGid = `gid://shopify/Product/${productId}`;

      for (const pub of publications) {
        try {
          logger.info(`📤 Publication sur ${pub.name} (${pub.id})`);

          const publishResponse = await axios.post(
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

          const errors = publishResponse.data?.data?.publishablePublish?.userErrors || [];
          if (errors.length > 0) {
            logger.warn(`⚠️ Erreurs lors de la publication sur ${pub.name}:`, errors);
          } else {
            logger.info(`✅ Publié sur ${pub.name}`);
          }
        } catch (e) {
          logger.warn(`⚠️ Impossible de publier sur ${pub.name}: ${e.message}`);
        }
      }

      logger.info("🎉 Publication terminée sur tous les canaux.");
    } catch (error) {
      logger.error("❌ Échec de la publication GraphQL:", error.response?.data || error.message);
    }
  }

  // =============================================
  // CRÉER UN PRODUIT
  // =============================================
  async createProduct(productData) {
    try {
      logger.info(`🛍️ Création du produit dans Shopify: ${productData.title}`);

      const formattedTitle = productData.reference
        ? `${productData.title} - ${productData.reference}`
        : productData.title;

      const sizes = productData.sizes || productData.variants || [];
      let variants = [];
      
      if (sizes.length > 0) {
        variants = sizes.map((size, index) => ({
          option1: size.size || size.value || 'Default',
          price: (productData.price || 0).toFixed(2),
          sku: productData.reference || `${productData.kimlandId}-${index}`,
          inventory_quantity: Math.max(0, size.quantity || 0),
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          fulfillment_service: 'manual',
          requires_shipping: true,
          taxable: true,
          position: index + 1,
          cost: (productData.costPrice || 0).toFixed(2)
        }));
      } else {
        variants = [{
          price: (productData.price || 0).toFixed(2),
          sku: productData.reference || 'PROD',
          inventory_quantity: Math.max(0, productData.totalStock || 0),
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          fulfillment_service: 'manual',
          requires_shipping: true,
          taxable: true,
          cost: (productData.costPrice || 0).toFixed(2)
        }];
      }

      const images = (productData.images || []).map((img, index) => ({
        src: img,
        position: index + 1,
        alt: `${formattedTitle} - Image ${index + 1}`
      }));

      const options = [];
      if (sizes.length > 0) {
        const optionValues = sizes.map(s => s.size || s.value || 'Default');
        const uniqueValues = [...new Set(optionValues)];
        if (uniqueValues.length > 0) {
          options.push({
            name: 'Taille',
            values: uniqueValues
          });
        }
      }

      const shopifyProduct = {
        product: {
          title: formattedTitle,
          body_html: '',
          vendor: 'Signateur Confort',
          product_type: '',
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
      logger.info(`✅ Produit créé: ${createdProduct.title} (ID: ${createdProduct.id})`);
      logger.info(`   🏷️  Fournisseur: Signateur Confort`);
      logger.info(`   📢 Publié sur tous les canaux (global)`);

      // ✅ Forcer la publication sur tous les canaux via GraphQL
      await this.publishToAllChannels(createdProduct.id);

      return createdProduct;

    } catch (error) {
      this.logApiError(error, 'createProduct');
      throw error;
    }
  }

  // =============================================
  // METTRE À JOUR UN PRODUIT
  // =============================================
  async updateProduct(productId, productData) {
    try {
      let variants = productData.variants || productData.sizes || [];
      if (variants.length === 0) {
        logger.warn(`⚠️ Aucune variante fournie pour le produit ${productId}, conservation des variantes existantes`);
        const existingProduct = await this.getProduct(productId);
        if (existingProduct && existingProduct.variants && existingProduct.variants.length > 0) {
          variants = existingProduct.variants.map(v => ({
            id: v.id,
            option1: v.option1 || 'Default',
            price: (productData.price !== undefined ? productData.price : parseFloat(v.price)).toFixed(2),
            sku: productData.reference || v.sku || '',
            cost: (productData.costPrice !== undefined ? productData.costPrice : parseFloat(v.cost || 0)).toFixed(2),
            inventory_quantity: v.inventory_quantity || 0,
            inventory_management: 'shopify',
            inventory_policy: v.inventory_policy || 'deny',
            fulfillment_service: v.fulfillment_service || 'manual',
            requires_shipping: true,
            taxable: true,
            position: v.position || 1,
          }));
          logger.info(`✅ Conservation de ${variants.length} variantes existantes`);
        } else {
          variants = [{
            option1: 'Default',
            price: (productData.price || 0).toFixed(2),
            sku: productData.reference || '',
            cost: (productData.costPrice || 0).toFixed(2),
            inventory_quantity: 0,
            inventory_management: 'shopify',
            inventory_policy: 'deny',
            fulfillment_service: 'manual',
            requires_shipping: true,
            taxable: true,
            position: 1,
          }];
          logger.info(`✅ Création d'une variante par défaut`);
        }
      } else {
        variants = variants.map((v, index) => ({
          id: v.id || undefined,
          option1: v.value || v.size || 'Default',
          price: (productData.price !== undefined ? productData.price : v.price || 0).toFixed(2),
          sku: v.sku || productData.reference || '',
          cost: (productData.costPrice !== undefined ? productData.costPrice : v.cost || 0).toFixed(2),
          inventory_quantity: v.quantity !== undefined ? v.quantity : 0,
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          fulfillment_service: 'manual',
          requires_shipping: true,
          taxable: true,
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
          product_type: '',
          variants: variants,
          images: (productData.images || []).map((img, index) => ({
            src: img,
            position: index + 1,
          })),
          published_scope: 'global'
        }
      };

      const response = await this.retryRequest(async () => {
        return await axios.put(
          `${this.baseUrl}/products/${productId}.json`,
          productPayload,
          { headers: this.headers }
        );
      });

      logger.info(`✅ Produit mis à jour: ${formattedTitle}`);

      // ✅ Forcer la publication sur tous les canaux via GraphQL
      await this.publishToAllChannels(productId);

      return response.data.product;

    } catch (error) {
      this.logApiError(error, 'updateProduct');
      throw error;
    }
  }

  // =============================================
  // RÉCUPÉRER UN PRODUIT PAR ID
  // =============================================
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

  // =============================================
  // RÉCUPÉRER UN PRODUIT PAR SKU
  // =============================================
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

  // =============================================
  // RÉCUPÉRER TOUS LES PRODUITS (avec pagination)
  // =============================================
  async getAllProducts(limit = 250) {
    try {
      let allProducts = [];
      let sinceId = 0;
      let hasMore = true;
      let pageCount = 0;
      const pageSize = Math.min(limit, 250);
      
      while (hasMore) {
        pageCount++;
        let url = `${this.baseUrl}/products.json?limit=${pageSize}&status=any`;
        if (sinceId > 0) {
          url += `&since_id=${sinceId}`;
        }
        
        logger.info(`📄 Récupération de la page ${pageCount} des produits Shopify...`);
        
        const response = await this.retryRequest(async () => {
          return await axios.get(url, { headers: this.headers });
        });
        
        const products = response.data.products || [];
        if (products.length === 0) {
          // Fallback sans status=any
          if (pageCount === 1) {
            logger.warn('⚠️ status=any ne fonctionne pas, on réessaie sans...');
            const fallbackRes = await this.retryRequest(async () => {
              return await axios.get(
                `${this.baseUrl}/products.json?limit=${pageSize}`,
                { headers: this.headers }
              );
            });
            const fallbackProducts = fallbackRes.data.products || [];
            if (fallbackProducts.length === 0) {
              hasMore = false;
            } else {
              allProducts = allProducts.concat(fallbackProducts);
              const last = fallbackProducts[fallbackProducts.length - 1];
              sinceId = last.id;
              logger.info(`✅ Page 1 (sans status=any): ${fallbackProducts.length} produits récupérés (total: ${allProducts.length})`);
              if (fallbackProducts.length < pageSize) {
                hasMore = false;
              }
              while (hasMore) {
                pageCount++;
                const nextUrl = `${this.baseUrl}/products.json?limit=${pageSize}&since_id=${sinceId}`;
                const nextRes = await this.retryRequest(async () => {
                  return await axios.get(nextUrl, { headers: this.headers });
                });
                const nextProducts = nextRes.data.products || [];
                if (nextProducts.length === 0) {
                  hasMore = false;
                } else {
                  allProducts = allProducts.concat(nextProducts);
                  const last2 = nextProducts[nextProducts.length - 1];
                  sinceId = last2.id;
                  logger.info(`✅ Page ${pageCount}: ${nextProducts.length} produits récupérés (total: ${allProducts.length})`);
                  if (nextProducts.length < pageSize) {
                    hasMore = false;
                  }
                  await this.delay(200);
                }
              }
              break;
            }
          } else {
            hasMore = false;
          }
        } else {
          allProducts = allProducts.concat(products);
          const lastProduct = products[products.length - 1];
          sinceId = lastProduct.id;
          logger.info(`✅ Page ${pageCount}: ${products.length} produits récupérés (total: ${allProducts.length})`);
          if (products.length < pageSize) {
            hasMore = false;
          }
          if (hasMore) {
            await this.delay(200);
          }
        }
      }
      
      logger.info(`📦 ${allProducts.length} produits récupérés depuis Shopify (${pageCount} pages)`);
      return allProducts;
    } catch (error) {
      this.logApiError(error, 'getAllProducts');
      return [];
    }
  }

  // =============================================
  // METTRE À JOUR L'INVENTAIRE D'UNE VARIANTE
  // =============================================
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
        throw new Error('Aucun emplacement trouvé');
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

      logger.info(`✅ Inventaire mis à jour: ${safeQuantity} unités`);
      return response.data.inventory_level;

    } catch (error) {
      this.logApiError(error, 'updateInventory');
      throw error;
    }
  }

  // =============================================
  // AFFICHER LES ERREURS API
  // =============================================
  logApiError(error, method) {
    if (error.response) {
      logger.error(`❌ Erreur API Shopify (${method}):`, {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    } else if (error.request) {
      logger.error(`❌ Erreur réseau (${method}):`, error.message);
    } else {
      logger.error(`❌ Erreur (${method}):`, error.message);
    }
  }

  // =============================================
  // DÉTERMINER LE TYPE DE PRODUIT (non utilisé)
  // =============================================
  determineProductType(title) {
    return '';
  }
}

module.exports = ShopifyClient;