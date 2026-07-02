const test = require('node:test');
const assert = require('node:assert/strict');
const { needsRepair } = require('../src/utils/productRepair');

test('needsRepair detects mismatched Shopify reference', () => {
  const shopifyProduct = {
    id: 1001,
    title: 'UMBRO PULL',
    variants: [{ sku: 'UMBROPUL-4851-1', cost: 1800, inventory_management: 'shopify' }],
  };
  const kimlandProduct = {
    title: 'UMBRO PULL. UAA241M009-001',
    reference: 'UAA241M009-001',
    costPrice: 1800,
  };

  assert.equal(needsRepair(shopifyProduct, kimlandProduct), true);
});

test('needsRepair detects missing cost or disabled inventory', () => {
  const shopifyProduct = {
    id: 1002,
    title: 'Test product',
    variants: [{ sku: 'ABC123', cost: 0, inventory_management: null }],
  };
  const kimlandProduct = {
    title: 'Test product',
    reference: 'ABC123',
    costPrice: 2500,
  };

  assert.equal(needsRepair(shopifyProduct, kimlandProduct), true);
});
