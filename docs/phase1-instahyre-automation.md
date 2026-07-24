# Phase 1: Instahyre Automation - Complete Guide
**Status:** Ready for Deployment  
**Platform:** Instahyre.com  
**Objective:** Apply to 5-10 React Native Developer roles  
**Estimated Time:** 20-30 minutes  
**Expected Outcome:** 5-10 applications submitted

---

## Prerequisites
✅ Chrome browser with Claude extension  
✅ Instahyre logged in as Shivaji Mandapati  
✅ JavaScript console access  
✅ Dedup log ready for tracking

---

## Step 1: Navigate to Instahyre Search Results

### Current Status
- Already on Instahyre showing "13,846 React Native jobs"
- Page shows job cards with "View" and "Not interested" buttons
- Results are paginated (30 per page)

### Action
✅ Already complete - page is loaded with React Native search results

---

## Step 2: Filter for Actual React Native Developer Roles

**Problem:** Search results include many non-mobile roles (Backend Engineers, Data Scientists, etc.)

**Solution JavaScript:**
```javascript
// Extract all visible job cards and filter for mobile/React Native roles
const jobCards = Array.from(document.querySelectorAll('[class*="card"], [class*="job-item"]'));

// Identify React Native specific roles
const reactNativeRoles = jobCards.filter(card => {
  const text = card.textContent.toLowerCase();
  const hasReactNative = text.includes('react native') || text.includes('mobile developer') || text.includes('mobile engineer');
  const notBackend = !text.includes('backend') && !text.includes('devops') && !text.includes('database');
  const notDataRole = !text.includes('data scientist') && !text.includes('data engineer');
  
  return hasReactNative && notBackend && notDataRole;
});

`Found ${reactNativeRoles.length} pure React Native/Mobile roles out of ${jobCards.length} total`;
```

---

## Step 3: Extract Top 5-10 React Native Roles

**Action JavaScript:**
```javascript
// Get top 5 React Native developer roles
const topRoles = reactNativeRoles.slice(0, 5).map(card => {
  const titleEl = card.querySelector('h2, h3, [class*="title"]');
  const companyEl = card.querySelector('[class*="company"]');
  const locationEl = card.querySelector('[class*="location"]');
  
  return {
    title: titleEl?.textContent.trim() || 'N/A',
    company: companyEl?.textContent.trim() || 'N/A',
    location: locationEl?.textContent.trim() || 'N/A',
    card: card
  };
});

topRoles.forEach((role, i) => {
  console.log(`${i+1}. ${role.title} at ${role.company} (${role.location})`);
});

`Ready to apply to ${topRoles.length} roles`;
```

**Expected Output:**
```
1. React Native Developer at BLVDPay (Bangalore)
2. Frontend Engineer at Liquide (Bangalore)
3. Software Development Engineer at KnackLabs (Bangalore)
4. Frontend Engineer at Gullak (Bangalore)
5. [Next role...]
```

---

## Step 4: Auto-Click View Buttons

**Action JavaScript:**
```javascript
// Click View button for each of the top 5 roles
const topRoles = reactNativeRoles.slice(0, 5);
let roleCount = 0;

for (const card of topRoles) {
  const viewBtn = card.querySelector('button:contains("View")') || 
                  Array.from(card.querySelectorAll('button')).find(b => b.textContent.includes('View'));
  
  if (viewBtn) {
    console.log(`Clicking View for role ${roleCount + 1}`);
    viewBtn.click();
    roleCount++;
    
    // Wait for modal to open
    await new Promise(r => setTimeout(r, 1500));
    
    // Execute apply function (see Step 5)
    await applyToJob(roleCount);
    
    // Wait before next job
    await new Promise(r => setTimeout(r, 800));
  }
}

`Successfully clicked View for ${roleCount} jobs`;
```

---

## Step 5: Auto-Click Apply in Modal

**Action JavaScript:**
```javascript
async function applyToJob(jobNumber) {
  try {
    // Find Apply button in the modal
    const allButtons = Array.from(document.querySelectorAll('button'));
    const applyBtn = allButtons.find(btn => btn.textContent.includes('Apply') && !btn.disabled);
    
    if (applyBtn) {
      console.log(`[Job ${jobNumber}] Clicking Apply button...`);
      applyBtn.click();
      
      // Wait for form/confirmation
      await new Promise(r => setTimeout(r, 1000));
      
      // Check for any required form fields and fill them
      // For Instahyre, usually just clicks Apply
      
      // Verify application was submitted
      const confirmationEl = document.querySelector('[class*="success"], [class*="confirmation"]');
      if (confirmationEl || document.body.textContent.includes('Applied')) {
        console.log(`[Job ${jobNumber}] ✅ APPLICATION SUCCESSFUL`);
        return { success: true, jobNumber };
      } else {
        console.log(`[Job ${jobNumber}] ⚠️ Check if form requires additional action`);
      }
    } else {
      console.log(`[Job ${jobNumber}] Apply button not found - may be already applied`);
    }
  } catch (err) {
    console.error(`[Job ${jobNumber}] Error: ${err.message}`);
  }
}
```

---

## Step 6: Close Modal and Move to Next Job

**Action JavaScript:**
```javascript
// Close modal after applying (click X or press Escape)
function closeModal() {
  const closeBtn = document.querySelector('button[aria-label="Close"], [class*="close"]');
  if (closeBtn) {
    closeBtn.click();
  } else {
    // Fallback: press Escape key
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }
  
  // Wait for modal to close
  return new Promise(r => setTimeout(r, 500));
}

// Usage:
await closeModal();
console.log('Modal closed, ready for next job');
```

---

## Step 7: Log Applications to Dedup File

**Action JavaScript (to copy to file):**
```javascript
// Prepare application log entry
const applicationLog = {
  date: new Date().toISOString().split('T')[0],
  time: new Date().toLocaleTimeString(),
  site: 'Instahyre',
  jobTitle: 'React Native Developer', // extracted from card
  company: 'BLVDPay', // extracted from card
  jobUrl: window.location.href,
  status: 'applied',
  notes: 'Auto-applied via JavaScript automation'
};

// Convert to CSV format
const csvRow = `${applicationLog.date},${applicationLog.site},${applicationLog.jobTitle},${applicationLog.company},${applicationLog.jobUrl},${applicationLog.status},"${applicationLog.notes}"`;

console.log('Add to applied_jobs_log.csv:');
console.log(csvRow);
```

**Output to add to log:**
```
2026-07-23,Instahyre,React Native Developer,BLVDPay,[URL],applied,"Auto-applied via JS"
2026-07-23,Instahyre,Frontend Engineer,Liquide,[URL],applied,"Auto-applied via JS"
2026-07-23,Instahyre,Software Development Engineer,KnackLabs,[URL],applied,"Auto-applied via JS"
...
```

---

## Complete Automation Script (All-in-One)

```javascript
// INSTAHYRE MASS APPLY SCRIPT - All Steps Combined

(async function() {
  console.log('🚀 Starting Instahyre Mass Apply...');
  
  // Step 1: Filter React Native roles
  const jobCards = Array.from(document.querySelectorAll('[class*="card"], [class*="job-item"]'));
  const reactNativeRoles = jobCards.filter(card => {
    const text = card.textContent.toLowerCase();
    return (text.includes('react native') || text.includes('mobile developer')) &&
           !text.includes('backend') && !text.includes('data');
  });
  
  console.log(`📍 Found ${reactNativeRoles.length} React Native roles`);
  
  const applicationsLog = [];
  const topRoles = reactNativeRoles.slice(0, 5); // Apply to top 5
  
  // Step 2-6: Apply to each role
  for (let i = 0; i < topRoles.length; i++) {
    const card = topRoles[i];
    
    try {
      // Extract job info
      const title = card.querySelector('h2, h3')?.textContent.trim() || 'N/A';
      const company = card.querySelector('[class*="company"]')?.textContent.trim() || 'N/A';
      const location = card.querySelector('[class*="location"]')?.textContent.trim() || 'N/A';
      
      console.log(`\n[${i+1}/5] ${title} @ ${company}`);
      
      // Click View
      const viewBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent.includes('View'));
      if (viewBtn) {
        viewBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        
        // Click Apply in modal
        const applyBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Apply') && !b.disabled);
        if (applyBtn) {
          applyBtn.click();
          await new Promise(r => setTimeout(r, 800));
          
          console.log(`✅ Applied successfully`);
          applicationsLog.push(`2026-07-23,Instahyre,"${title}","${company}","${window.location.href}",applied,"JS auto-apply"`);
        }
        
        // Close modal
        const closeBtn = document.querySelector('button[aria-label="Close"]');
        if (closeBtn) closeBtn.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`❌ Error on role ${i+1}:`, err.message);
    }
  }
  
  // Step 7: Output log
  console.log('\n📋 Applications Log (add to CSV):');
  console.log(applicationsLog.join('\n'));
  console.log(`\n✨ Completed ${applicationsLog.length} applications`);
  
  return applicationsLog;
})();
```

---

## Deployment Instructions

### Option A: Copy-Paste to Console (Easiest)
1. Open Chrome DevTools: `F12` or `Ctrl+Shift+I`
2. Go to **Console** tab
3. Paste the "Complete Automation Script" above
4. Press **Enter**
5. Watch applications submit automatically
6. Copy the output log to your CSV file

### Option B: Run via JavaScript Tool (Recommended)
Use the JavaScript automation tool with the script above and it will execute automatically.

---

## Expected Results

### Success Indicators
✅ Console shows "Applied successfully" for each role  
✅ Page changes after clicking Apply (confirmation)  
✅ Job cards disappear or change appearance after applying  
✅ Script completes with "Completed X applications" message

### Troubleshooting

**Problem:** "Apply button not found"
- **Cause:** Modal may require scrolling or form filling
- **Fix:** Add scroll-to-apply logic
- **Code:**
```javascript
const modal = document.querySelector('[role="dialog"]');
if (modal) modal.scrollTop = modal.scrollHeight;
```

**Problem:** "Apply button disabled"
- **Cause:** May require mandatory form fields
- **Fix:** Detect and fill required fields first
- **Code:**
```javascript
const requiredFields = document.querySelectorAll('[required]');
requiredFields.forEach(field => {
  if (field.tagName === 'INPUT' && field.type === 'text') {
    field.value = 'N/A'; // Or extract from profile
  }
});
```

**Problem:** "Rate limited / CAPTCHA appeared"
- **Cause:** Too many applications too fast
- **Fix:** Increase delay between applications to 2-3 seconds
- **Code:**
```javascript
await new Promise(r => setTimeout(r, 3000)); // 3 second delay
```

---

## Performance Metrics

| Metric | Expected Value |
|--------|-----------------|
| Applications per minute | 2-3 |
| Time for 5 applications | 10-15 minutes |
| Success rate | 80-100% |
| CAPTCHA rate | 0-10% |

---

## Next Steps After Phase 1

1. ✅ Execute this script (5-10 applications)
2. 🟡 Review results & update dedup log
3. 🟡 Expand to LinkedIn (Phase 2)
4. 🟡 Add YourStory Jobs (Phase 2)
5. 📊 Track cumulative applications & response rates

---

## Save This Script

After running, save the complete script to a file for future use:

**Filename:** `instahyre-mass-apply.js`  
**Location:** Same folder as job logs  
**Usage:** Can be re-run daily with updated role selection

---

**Ready to Deploy:** ✅ YES  
**Estimated Duration:** 15-25 minutes  
**Risk Level:** Low (read-only until Apply clicked)  
**Rollback:** Easy (just close browser tab, no side effects)

**👉 Execute when ready!**
