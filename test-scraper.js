require('dotenv').config();
const KimlandScraper = require('./src/scrapers/kimlandScraper');

async function testScraper() {
  console.log('\n🧪 Testing Kimland scraper...\n');
  
  const scraper = new KimlandScraper();
  
  try {
    console.log('🚀 Starting browser...');
    await scraper.initialize();
    
    console.log('🔐 Logging in...');
    await scraper.login();
    console.log('✅ Login successful!\n');
    
    const testUrl = 'https://kimland.dz/product/11257/depart-polo/';
    
    console.log(`📋 Testing product extraction from: ${testUrl}\n`);
    const product = await scraper.extractProductFromUrl(testUrl);
    
    if (product) {
      console.log('\n✅ Product extracted successfully:');
      console.log(`   Title: ${product.title}`);
      console.log(`   Reference: ${product.reference}`);
      console.log(`   Price: ${product.price} DA`);
      console.log(`   Availability: ${product.availability}`);
      console.log(`   Images: ${product.imageCount} photos`);
      console.log(`   Sizes: ${product.sizeCount} variants`);
      console.log(`   Total Stock: ${product.totalStock}`);
      
      if (product.sizes.length > 0) {
        console.log('\n📏 Sizes available:');
        product.sizes.forEach(s => {
          console.log(`   ${s.size}: ${s.quantity} pieces`);
        });
      }
      
      console.log('\n💾 Product saved to:');
      console.log(`   product-${product.kimlandId}.json`);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await scraper.close();
    console.log('\n🔚 Test complete!');
  }
}

testScraper();