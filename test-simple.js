require('dotenv').config();
const KimlandScraper = require('./src/scrapers/kimlandScraper.js');

async function test() {
  console.log('\n🧪 SIMPLE TEST\n');
  
  const scraper = new KimlandScraper();
  
  try {
    console.log('1️⃣ Initializing...');
    await scraper.initialize();
    
    console.log('2️⃣ Logging in...');
    await scraper.login();
    console.log('   ✅ Logged in');
    
    console.log('3️⃣ Extracting product...');
    const product = await scraper.extractProductFromUrl('https://kimland.dz/product/11257/depart-polo/');
    
    console.log('\n📦 RESULT:');
    console.log('   Title:', product.title);
    console.log('   Images:', product.imageCount);
    console.log('   Variant Type:', product.variantType);
    console.log('   Variants:', product.variantCount);
    console.log('   Stock:', product.totalStock);
    
    if (product.variants && product.variants.length > 0) {
      console.log('\n   📏 ' + product.variantLabel + 's:');
      product.variants.forEach(v => {
        console.log('      ' + v.value + ':', v.quantity);
      });
    }
    
    console.log('\n✅ Test complete!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await scraper.close();
  }
}

test();