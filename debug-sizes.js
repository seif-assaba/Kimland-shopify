require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

async function debugSizes() {
  console.log('🔍 Debugging size selectors...\n');
  
  const browser = await chromium.launch({
    headless: false,
  });
  
  const page = await browser.newPage();
  
  try {
    // Login
    console.log('🔐 Logging in...');
    await page.goto(process.env.KIMLAND_LOGIN_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.fill('input[type="email"]', process.env.KIMLAND_EMAIL);
    await page.fill('input[type="password"]', process.env.KIMLAND_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle' });
    console.log('✅ Login successful!\n');
    
    // Go to product page
    const productUrl = 'https://kimland.dz/product/11257/depart-polo/';
    console.log(`📋 Going to: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    // Wait for product info
    await page.waitForSelector('.product-info-main', { timeout: 15000 });
    
    // Method 1: Look for the select dropdown
    console.log('\n🔍 Looking for select dropdowns...');
    const selects = await page.$$eval('select', (els) => {
      return els.map(el => ({
        id: el.id,
        name: el.name,
        className: el.className,
        options: Array.from(el.options).map(opt => opt.textContent.trim())
      }));
    });
    console.log('Found selects:', JSON.stringify(selects, null, 2));
    
    // Method 2: Look for elements containing size patterns
    console.log('\n🔍 Looking for size patterns in all elements...');
    const sizeElements = await page.evaluate(() => {
      const results = [];
      const allElements = document.querySelectorAll('*');
      allElements.forEach(el => {
        const text = el.textContent;
        if (text && text.match(/([A-Z0-9]+)\s*[-:]\s*(\d+)\s*pi[èe]ce/i)) {
          results.push({
            tag: el.tagName,
            id: el.id,
            className: el.className,
            text: text.trim().substring(0, 200)
          });
        }
      });
      return results;
    });
    
    console.log('Found size elements:', JSON.stringify(sizeElements, null, 2));
    
    // Method 3: Look specifically for the size select
    console.log('\n🔍 Looking for size select specifically...');
    const sizeSelect = await page.$('#forSize');
    if (sizeSelect) {
      console.log('✅ Found #forSize!');
      const options = await page.$$eval('#forSize option', (opts) => {
        return opts.map(opt => opt.textContent.trim());
      });
      console.log('Options:', options);
    } else {
      console.log('❌ #forSize not found');
    }
    
    // Method 4: Try to find by name
    console.log('\n🔍 Looking for select[name="pointure"]...');
    const pointureSelect = await page.$('select[name="pointure"]');
    if (pointureSelect) {
      console.log('✅ Found select[name="pointure"]!');
    } else {
      console.log('❌ select[name="pointure"] not found');
    }
    
    // Method 5: Get all text content with sizes
    console.log('\n🔍 Getting all text with sizes...');
    const allText = await page.evaluate(() => document.body.innerText);
    const lines = allText.split('\n');
    const sizeLines = lines.filter(line => line.match(/([A-Z0-9]+)\s*[-:]\s*(\d+)\s*pi[èe]ce/i));
    console.log('Size lines found:', sizeLines);
    
    // Save full HTML for inspection
    const html = await page.content();
    fs.writeFileSync('debug-full.html', html);
    console.log('\n📄 Full HTML saved to debug-full.html');
    
    // Save screenshot
    await page.screenshot({ path: 'debug-page.png' });
    console.log('📸 Screenshot saved to debug-page.png');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
    console.log('\n🔚 Debug complete!');
  }
}

debugSizes();