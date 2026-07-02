const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class SyncStore {
  constructor() {
    this.filePath = path.join(__dirname, '../../sync-data.json');
    this.mappings = {};
    this.loadMappings();
  }

  loadMappings() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        this.mappings = JSON.parse(data);
        logger.info(`📂 Loaded ${Object.keys(this.mappings).length} mappings`);
      } else {
        this.mappings = {};
        logger.info('📂 No existing mappings found');
      }
    } catch (error) {
      logger.error('❌ Failed to load mappings:', error.message);
      this.mappings = {};
    }
  }

  saveMappings() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.mappings, null, 2));
      logger.info(`💾 Saved ${Object.keys(this.mappings).length} mappings`);
    } catch (error) {
      logger.error('❌ Failed to save mappings:', error.message);
    }
  }

  saveMapping(kimlandId, shopifyId, productData = null) {
    this.mappings[kimlandId] = {
      shopifyId: shopifyId,
      lastSync: new Date().toISOString(),
      productData: productData,
      version: (this.mappings[kimlandId]?.version || 0) + 1
    };
    this.saveMappings();
    logger.info(`✅ Mapped Kimland ${kimlandId} → Shopify ${shopifyId}`);
  }

  getMapping(kimlandId) {
    return this.mappings[kimlandId] || null;
  }

  getAllMappings() {
    return this.mappings;
  }

  // ✅ NEW: Delete a mapping
  deleteMapping(kimlandId) {
    if (this.mappings[kimlandId]) {
      delete this.mappings[kimlandId];
      this.saveMappings();
      logger.info(`🗑️ Deleted mapping for ${kimlandId}`);
      return true;
    }
    return false;
  }

  getTotalProducts() {
    return Object.keys(this.mappings).length;
  }

  // Get products that need sync (based on last sync time)
  getProductsNeedingSync(hoursThreshold = 24) {
    const now = new Date();
    const needsSync = [];
    
    for (const [kimlandId, data] of Object.entries(this.mappings)) {
      const lastSync = new Date(data.lastSync);
      const hoursSince = (now - lastSync) / (1000 * 60 * 60);
      
      if (hoursSince > hoursThreshold) {
        needsSync.push({
          kimlandId,
          shopifyId: data.shopifyId,
          lastSync: data.lastSync,
          productData: data.productData
        });
      }
    }
    
    return needsSync;
  }
}

module.exports = SyncStore;