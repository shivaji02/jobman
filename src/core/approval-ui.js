const http = require('http');

const escJson = (x) => JSON.stringify(x).replace(/</g, '\\u003c');

function decideSelected(store, ids, status) {
  if (!Array.isArray(ids) || !ids.length || !['approved', 'declined'].includes(status)) throw new Error('Select jobs and choose approve or reject.');
  const jobs = store.list();
  const exact = ids.map((id) => jobs.find((j) => j.id === String(id) || j.key === String(id)));
  if (exact.some((j) => !j || j.status !== 'pending')) throw new Error('One or more selected jobs are no longer pending. Refresh and review the selection again.');
  return store.decide(exact.map((j) => j.id), status);
}

function viewJob(job) {
  const { ADAPTERS } = require('./submit');
  const requirements = (job.applicationRequirements || job.flags || []).filter((x) => !/submitted by the .* bot the next time it lists/i.test(x));
  let displayStatus = job.status;
  if (job.status === 'approved' && !ADAPTERS[job.portal]) displayStatus = 'approved · needs user action';
  else if (job.status === 'submitted') displayStatus = job.workflowStatus || 'submitted';
  else if (job.status === 'declined') displayStatus = 'rejected';
  else if (job.status === 'unconfirmed') displayStatus = 'needs verification';
  return {
    id: job.id, key: job.key, url: job.url, status: job.status, displayStatus,
    title: job.title || '', company: job.company || '', location: job.location || '',
    experienceText: job.experienceText || '', experienceRequirement: job.experienceRequirement || null,
    technologyMatch: job.technologyMatch || [], score: job.score ?? null, resume: job.resume || '',
    applicationRequirements: requirements, flags: requirements, why: job.why || '', evidence: job.evidence || '',
    channel: job.channel || '', portal: job.portal || '', preparedAt: job.preparedAt || '',
  };
}

function page(jobs) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jobman approvals</title>
<style>body{font:14px system-ui;margin:24px;background:#f5f7fa;color:#18212f}h1{margin:0 0 8px} .bar{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}input,select,button{padding:9px;border:1px solid #bac4d0;border-radius:6px;background:white}button{cursor:pointer;font-weight:600}.approve{background:#176b45;color:white}.decline{background:#9b2c2c;color:white}.table{overflow:auto;background:white;border:1px solid #dce2e8;border-radius:8px}table{border-collapse:collapse;width:100%;min-width:1050px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e8edf1;vertical-align:top}th{position:sticky;top:0;background:#edf1f5}small{color:#596779}.reason{max-width:260px}dialog{max-width:720px;border:0;border-radius:10px;box-shadow:0 10px 50px #0004}dialog::backdrop{background:#10203088}#confirmList{max-height:45vh;overflow:auto;padding-left:24px}</style></head><body>
<h1>Jobman approval queue</h1><small>Approving a job only queues its saved application. Submission is handled by the bounded worker command.</small>
<div class="bar"><input id="q" placeholder="Search company, title, technology…"><select id="status"><option value="pending">Pending approval</option><option value="approved">Approved</option><option value="all">All applications</option></select><select id="sort"><option value="score">Score: high to low</option><option value="company">Company</option><option value="date">Prepared: newest</option><option value="title">Job title</option></select><button id="refresh">Refresh</button><button id="all">Select visible</button><button class="approve" id="approve">Approve selected</button><button class="decline" id="decline">Reject selected</button></div>
<div id="notice"></div><div class="table"><table><thead><tr><th>Select</th><th>Company / title</th><th>Location / experience</th><th>Technology match / score</th><th>Resume / requirements</th><th>URL / status</th></tr></thead><tbody id="rows"></tbody></table></div>
<dialog id="confirm"><h2 id="confirmTitle"></h2><p>Review the exact jobs below before continuing.</p><ol id="confirmList"></ol><div class="bar"><button id="cancel">Cancel</button><button class="approve" id="confirmAction">Confirm</button></div></dialog>
<script>const initial=${escJson(jobs)};let jobs=initial, action='approved';const $=id=>document.getElementById(id);const text=(e,s)=>{e.textContent=s||'—'};function draw(){const q=$('q').value.toLowerCase(), st=$('status').value, sort=$('sort').value;let a=jobs.filter(j=>(st==='all'||j.status===st)&&JSON.stringify(j).toLowerCase().includes(q));a.sort((x,y)=>sort==='score'?(y.score||0)-(x.score||0):sort==='company'?String(x.company).localeCompare(y.company):sort==='title'?String(x.title).localeCompare(y.title):String(y.preparedAt).localeCompare(x.preparedAt));const body=$('rows');body.replaceChildren();for(const j of a){const tr=document.createElement('tr'),check=document.createElement('input');check.type='checkbox';check.dataset.id=j.id;check.disabled=j.status!=='pending';const td0=document.createElement('td');td0.append(check);tr.append(td0);const cells=[(j.company||'Employer')+'\n'+(j.title||'Title'),(j.location||'Location n/a')+'\nExperience: '+(j.experienceText||fmtExp(j.experienceRequirement)),(j.technologyMatch||[]).join(', ')+'\nScore: '+(j.score??'—'),(j.resume||'No resume selected')+'\n'+(j.applicationRequirements||j.flags||[]).join('; '),(j.url||'')+'\nStatus: '+(j.displayStatus||j.status||'pending')];for(let i=0;i<cells.length;i++){const td=document.createElement('td');td.textContent=cells[i];if(i===0||i===1||i===2||i===3)td.style.whiteSpace='pre-line';if(i===4&&j.url){td.replaceChildren();let safe=false;try{safe=['http:','https:'].includes(new URL(j.url).protocol)}catch{}if(safe){const link=document.createElement('a');link.href=j.url;link.textContent=j.url;link.target='_blank';link.rel='noreferrer';td.append(link)}else td.textContent=j.url;td.append(document.createElement('br'),document.createTextNode('Status: '+(j.displayStatus||j.status||'pending')))}tr.append(td)}body.append(tr)}text($('notice'),a.length+' shown · '+jobs.filter(j=>j.status==='pending').length+' pending · '+jobs.filter(j=>j.status==='approved').length+' approved')}
function fmtExp(x){return x&&typeof x==='object'?[x.min??'?','–',x.max??'?',' years'].join(''):'Not stated'}async function refresh(){jobs=await fetch('/api/jobs').then(r=>r.json());draw()}function selected(){return [...document.querySelectorAll('#rows input:checked')].map(c=>jobs.find(j=>j.id===c.dataset.id)).filter(Boolean)}function ask(status){const chosen=selected();if(!chosen.length)return alert('Select one or more pending jobs first.');action=status;$('confirmTitle').textContent=status==='approved'?'Approve selected applications?':'Reject selected applications?';$('confirmList').replaceChildren(...chosen.map(j=>{const li=document.createElement('li');li.textContent=(j.company||'')+' — '+(j.title||'')+' · '+(j.location||'')+' · '+j.id;return li}));$('confirmAction').textContent=status==='approved'?'Confirm approval':'Confirm rejection';$('confirm').showModal()}$('confirmAction').onclick=async()=>{const ids=selected().map(j=>j.id);const r=await fetch('/api/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids,status:action})});const out=await r.json();$('confirm').close();text($('notice'),out.error||('Updated '+out.changed.length+' application(s). '+out.missing.join('; ')));await refresh()};$('cancel').onclick=()=>$('confirm').close();$('approve').onclick=()=>ask('approved');$('decline').onclick=()=>ask('declined');$('refresh').onclick=refresh;$('q').oninput=draw;$('status').onchange=draw;$('sort').onchange=draw;$('all').onclick=()=>document.querySelectorAll('#rows input:not(:disabled)').forEach(c=>c.checked=true);draw();</script></body></html>`;
}

function createApprovalServer(store, { port = 0, onApproved = null } = {}) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin)) { res.writeHead(403).end('Forbidden'); return; }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(store.list().map(viewJob))); return;
    }
    if (req.method === 'GET' && req.url === '/api/jobs') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(store.list().map(viewJob))); return;
    }
    if (req.method === 'POST' && req.url === '/api/decision') {
      let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const out = decideSelected(store, data.ids, data.status);
          if (data.status === 'approved' && out.changed.length && onApproved) Promise.resolve().then(() => onApproved(out.changed)).catch((err) => console.error(`[approvals] submit worker could not start: ${err.message}`));
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
        } catch (err) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
      }); return;
    }
    res.writeHead(404).end('Not found');
  });
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address())); }), close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { createApprovalServer, decideSelected, page, viewJob };
