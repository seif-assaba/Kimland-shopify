const assert = require('assert');
const ShopifyClient = require('../src/shopify/shopifyClient');

(async () => {
  const client = new ShopifyClient();
  const productData = {
    title: 'Test Product',
    reference: 'TEST-001',
    price: 99.99,
    sizes: [{ size: 'M', quantity: 5 }],
    images: ['https://example.com/image.jpg'],
    description: 'Example',
    availability: 'En stock'
  };

  assert.ok(typeof client.formatDescription(productData) === 'string');
  assert.ok(client.baseUrl === null || client.baseUrl.includes('/admin/api/'));
  console.log('Shopify client sanity checks passed');
})();
