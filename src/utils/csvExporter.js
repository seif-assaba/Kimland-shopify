const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class CSVExporter {
  constructor() {
    this.fields = [
      'Handle',
      'Title',
      'Body (HTML)',
      'Vendor',
      'Product Category',
      'Type',
      'Tags',
      'Published',
      'Option1 Name',
      'Option1 Value',
      'Option1 Linked To',
      'Option2 Name',
      'Option2 Value',
      'Option2 Linked To',
      'Option3 Name',
      'Option3 Value',
      'Option3 Linked To',
      'Variant SKU',
      'Variant Grams',
      'Variant Inventory Tracker',
      'Variant Inventory Qty',
      'Variant Inventory Policy',
      'Variant Fulfillment Service',
      'Variant Price',
      'Variant Compare At Price',
      'Variant Requires Shipping',
      'Variant Taxable',
      'Unit Price Total Measure',
      'Unit Price Total Measure Unit',
      'Unit Price Base Measure',
      'Unit Price Base Measure Unit',
      'Variant Barcode',
      'Image Src',
      'Image Position',
      'Image Alt Text',
      'Gift Card',
      'SEO Title',
      'SEO Description',
      'Color (product.metafields.shopify.color-pattern)',
      'Shoe size (product.metafields.shopify.shoe-size)',
      'Size (product.metafields.shopify.size)',
      'Variant Image',
      'Variant Weight Unit',
      'Variant Tax Code',
      'Cost per item',
      'Status'
    ];
  }

  convertToShopifyCSV(product) {
    const rows = [];
    const handle = this.generateHandle(product.title);
    const basePrice = product.price || 0;
    const costPrice = product.costPrice || 0;
    const variantType = product.variantType || 'taille';
    const variantLabel = product.variantLabel || 'Taille';
    const variants = product.variants || product.sizes || [];
    
    let description = product.description || '';
    if (product.features && product.features.length > 0) {
      description += '\n\nCaractéristiques:\n';
      product.features.forEach(f => {
        description += `- ${f}\n`;
      });
    }

    if (variants.length === 0) {
      rows.push({
        Handle: handle,
        Title: product.title,
        'Body (HTML)': description,
        Vendor: 'Kimland',
        'Product Category': this.determineCategory(product.title),
        Type: this.determineType(product.title),
        Tags: 'kimland, imported',
        Published: 'TRUE',
        'Option1 Name': variantType === 'pointure' ? 'Pointure' : 'Taille',
        'Option1 Value': 'Default',
        'Option1 Linked To': '',
        'Option2 Name': '',
        'Option2 Value': '',
        'Option2 Linked To': '',
        'Option3 Name': '',
        'Option3 Value': '',
        'Option3 Linked To': '',
        'Variant SKU': product.reference || 'SKU-001',
        'Variant Grams': 0,
        'Variant Inventory Tracker': 'shopify',
        'Variant Inventory Qty': product.totalStock || 0,
        'Variant Inventory Policy': 'deny',
        'Variant Fulfillment Service': 'manual',
        'Variant Price': basePrice.toFixed(2),
        'Variant Compare At Price': costPrice > 0 ? costPrice.toFixed(2) : '',
        'Variant Requires Shipping': 'TRUE',
        'Variant Taxable': 'TRUE',
        'Unit Price Total Measure': '',
        'Unit Price Total Measure Unit': '',
        'Unit Price Base Measure': '',
        'Unit Price Base Measure Unit': '',
        'Variant Barcode': '',
        'Image Src': product.images && product.images.length > 0 ? product.images[0] : '',
        'Image Position': 1,
        'Image Alt Text': product.title,
        'Gift Card': 'FALSE',
        'SEO Title': '',
        'SEO Description': '',
        'Color (product.metafields.shopify.color-pattern)': '',
        'Shoe size (product.metafields.shopify.shoe-size)': '',
        'Size (product.metafields.shopify.size)': '',
        'Variant Image': '',
        'Variant Weight Unit': 'kg',
        'Variant Tax Code': '',
        'Cost per item': costPrice > 0 ? costPrice.toFixed(2) : '',
        'Status': 'active'
      });
    } else {
      variants.forEach((variant, index) => {
        const optionValue = variant.value || variant.size || 'Default';
        const quantity = variant.quantity || 0;
        const sku = product.reference ? `${product.reference}-${optionValue}` : `${handle}-${optionValue}`;
        
        let variantImage = '';
        if (product.images && product.images.length > index) {
          variantImage = product.images[index];
        } else if (product.images && product.images.length > 0) {
          variantImage = product.images[0];
        }

        if (index === 0) {
          rows.push({
            Handle: handle,
            Title: product.title,
            'Body (HTML)': description,
            Vendor: 'Kimland',
            'Product Category': this.determineCategory(product.title),
            Type: this.determineType(product.title),
            Tags: 'kimland, imported',
            Published: 'TRUE',
            'Option1 Name': variantType === 'pointure' ? 'Pointure' : 'Taille',
            'Option1 Value': optionValue,
            'Option1 Linked To': 'product.metafields.shopify.size',
            'Option2 Name': '',
            'Option2 Value': '',
            'Option2 Linked To': '',
            'Option3 Name': '',
            'Option3 Value': '',
            'Option3 Linked To': '',
            'Variant SKU': sku,
            'Variant Grams': 0,
            'Variant Inventory Tracker': 'shopify',
            'Variant Inventory Qty': quantity,
            'Variant Inventory Policy': 'deny',
            'Variant Fulfillment Service': 'manual',
            'Variant Price': basePrice.toFixed(2),
            'Variant Compare At Price': costPrice > 0 ? costPrice.toFixed(2) : '',
            'Variant Requires Shipping': 'TRUE',
            'Variant Taxable': 'TRUE',
            'Unit Price Total Measure': '',
            'Unit Price Total Measure Unit': '',
            'Unit Price Base Measure': '',
            'Unit Price Base Measure Unit': '',
            'Variant Barcode': '',
            'Image Src': product.images && product.images.length > 0 ? product.images[0] : '',
            'Image Position': 1,
            'Image Alt Text': product.title,
            'Gift Card': 'FALSE',
            'SEO Title': '',
            'SEO Description': '',
            'Color (product.metafields.shopify.color-pattern)': '',
            'Shoe size (product.metafields.shopify.shoe-size)': variantType === 'pointure' ? optionValue : '',
            'Size (product.metafields.shopify.size)': variantType === 'taille' ? optionValue : '',
            'Variant Image': variantImage,
            'Variant Weight Unit': 'kg',
            'Variant Tax Code': '',
            'Cost per item': costPrice > 0 ? costPrice.toFixed(2) : '',
            'Status': 'active'
          });
        } else {
          rows.push({
            Handle: handle,
            Title: '',
            'Body (HTML)': '',
            Vendor: '',
            'Product Category': '',
            'Type': '',
            'Tags': '',
            'Published': '',
            'Option1 Name': '',
            'Option1 Value': optionValue,
            'Option1 Linked To': '',
            'Option2 Name': '',
            'Option2 Value': '',
            'Option2 Linked To': '',
            'Option3 Name': '',
            'Option3 Value': '',
            'Option3 Linked To': '',
            'Variant SKU': sku,
            'Variant Grams': 0,
            'Variant Inventory Tracker': 'shopify',
            'Variant Inventory Qty': quantity,
            'Variant Inventory Policy': 'deny',
            'Variant Fulfillment Service': 'manual',
            'Variant Price': basePrice.toFixed(2),
            'Variant Compare At Price': costPrice > 0 ? costPrice.toFixed(2) : '',
            'Variant Requires Shipping': 'TRUE',
            'Variant Taxable': 'TRUE',
            'Unit Price Total Measure': '',
            'Unit Price Total Measure Unit': '',
            'Unit Price Base Measure': '',
            'Unit Price Base Measure Unit': '',
            'Variant Barcode': '',
            'Image Src': '',
            'Image Position': '',
            'Image Alt Text': '',
            'Gift Card': '',
            'SEO Title': '',
            'SEO Description': '',
            'Color (product.metafields.shopify.color-pattern)': '',
            'Shoe size (product.metafields.shopify.shoe-size)': '',
            'Size (product.metafields.shopify.size)': '',
            'Variant Image': variantImage,
            'Variant Weight Unit': 'kg',
            'Variant Tax Code': '',
            'Cost per item': costPrice > 0 ? costPrice.toFixed(2) : '',
            'Status': ''
          });
        }
      });
    }

    return rows;
  }

  generateHandle(title) {
    if (!title) return 'product';
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }

  determineCategory(title) {
    const lower = title.toLowerCase();
    if (lower.includes('chaussure') || lower.includes('shoe')) {
      return 'Apparel & Accessories > Shoes';
    }
    if (lower.includes('robe') || lower.includes('dress')) {
      return 'Apparel & Accessories > Clothing > Dresses';
    }
    if (lower.includes('pantalon') || lower.includes('jeans')) {
      return 'Apparel & Accessories > Clothing > Pants';
    }
    if (lower.includes('veste') || lower.includes('jacket')) {
      return 'Apparel & Accessories > Clothing > Jackets & Coats';
    }
    return 'Apparel & Accessories > Clothing > Clothing Tops > T-Shirts';
  }

  determineType(title) {
    const lower = title.toLowerCase();
    if (lower.includes('chaussure') || lower.includes('shoe')) return 'Shoes';
    if (lower.includes('robe') || lower.includes('dress')) return 'Dress';
    if (lower.includes('pantalon') || lower.includes('jeans')) return 'Pants';
    if (lower.includes('veste') || lower.includes('jacket')) return 'Jacket';
    if (lower.includes('polo')) return 'Polo';
    if (lower.includes('t-shirt') || lower.includes('tshirt')) return 'T-Shirt';
    return 'Clothing';
  }

  exportToCSV(product, filename = null) {
    try {
      const rows = this.convertToShopifyCSV(product);
      
      if (!filename) {
        const handle = this.generateHandle(product.title);
        filename = `products_export_${handle}_${Date.now()}.csv`;
      }

      const parser = new Parser({
        fields: this.fields,
        withBOM: true,
        delimiter: ',',
        quote: '"',
        escapedQuote: '""',
        eol: '\n'
      });

      const csv = parser.parse(rows);
      
      const filePath = path.join(__dirname, '../../exports', filename);
      
      const exportsDir = path.join(__dirname, '../../exports');
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }

      fs.writeFileSync(filePath, csv, 'utf8');
      logger.info(`📊 CSV exported to: ${filePath}`);
      
      return {
        success: true,
        filePath: filePath,
        filename: filename,
        rows: rows.length
      };
    } catch (error) {
      logger.error('❌ CSV export failed:', error.message);
      throw error;
    }
  }

  exportMultipleToCSV(products) {
    const allRows = [];
    products.forEach(product => {
      const rows = this.convertToShopifyCSV(product);
      allRows.push(...rows);
    });

    try {
      const filename = `products_export_batch_${Date.now()}.csv`;
      const parser = new Parser({
        fields: this.fields,
        withBOM: true,
        delimiter: ','
      });

      const csv = parser.parse(allRows);
      const filePath = path.join(__dirname, '../../exports', filename);
      
      const exportsDir = path.join(__dirname, '../../exports');
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }

      fs.writeFileSync(filePath, csv, 'utf8');
      logger.info(`📊 Batch CSV exported to: ${filePath}`);
      
      return {
        success: true,
        filePath: filePath,
        filename: filename,
        rows: allRows.length,
        products: products.length
      };
    } catch (error) {
      logger.error('❌ Batch CSV export failed:', error.message);
      throw error;
    }
  }
}

module.exports = CSVExporter;