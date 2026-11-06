/**
 * Generic application-form engine shared by the ATS adapters.
 *
 *   collectQuestions(page, root)  → [{ qid, label, kind, required, options, multiple }]
 *       Every visible question in the form, with the label the candidate sees.
 *       The primary element of each question is tagged data-jm-q="<qid>".
 *   fillQuestion(page, q, value)  → true when the value was applied
 *   unfilledRequired(page, root)  → labels of required questions still empty
 *   challengeVisible(page)        → name of a visible CAPTCHA challenge, or ''
 *
 * Values are written the way a person would (click, type, choose), with
 * React-safe events, so ATS front-ends register them.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Containers that hold one question (label + control), most specific first. */
const QUESTION_CONTAINERS = [
  '.ashby-application-form-field-entry',
  '.application-question',
  '.field-wrapper',
  '[data-test="question"]',
  'fieldset',
  '.form-group',
  '.field',
  'li',
].join(',');

/**
 * Shadow-DOM support (SmartRecruiters renders its form inside open shadow roots
 * of <spl-*> web components). Installed into the page once per document:
 *   __jmQA(sel, root)  querySelectorAll that also searches every open shadow root
 *   __jmQ(sel)         first match, light DOM first
 *   __jmClosest(el, s) closest() that climbs out through shadow hosts
 *   __jmLabel(el, id)  label[for=id] in the element's own root (shadow or document)
 * Closed shadow roots stay closed — nothing is forced open.
 */
async function installDeepHelpers(page) {
  await page.evaluate(() => {
    if (window.__jmQA) return;
    window.__jmQA = (sel, root = document) => {
      const out = [...root.querySelectorAll(sel)];
      const walk = (r) => {
        for (const e of r.querySelectorAll('*')) {
          if (e.shadowRoot) {
            out.push(...e.shadowRoot.querySelectorAll(sel));
            walk(e.shadowRoot);
          }
        }
      };
      walk(root);
      return out;
    };
    window.__jmQ = (sel) => document.querySelector(sel) || window.__jmQA(sel)[0] || null;
    window.__jmClosest = (el, sel) => {
      let n = el;
      while (n) {
        const c = n.closest ? n.closest(sel) : null;
        if (c) return c;
        const r = n.getRootNode && n.getRootNode();
        n = r && r.host ? r.host : null;
      }
      return null;
    };
    window.__jmLabel = (el, id) => {
      const r = el.getRootNode ? el.getRootNode() : document;
      return (r.querySelector && r.querySelector(`label[for="${CSS.escape(id)}"]`)) || document.querySelector(`label[for="${CSS.escape(id)}"]`);
    };
  });
}

/** Element handle for a tagged question/option, wherever it lives (light or shadow DOM). */
const $deep = (page, sel) => page.$(`>>> ${sel}`).catch(() => null);

async function collectQuestions(page, rootSelector = 'form') {
  await installDeepHelpers(page);
  return page.evaluate(
    (rootSelector, CONTAINERS) => {
      const root = __jmQ(rootSelector) || document.body;
      const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
      // Text as the user sees it: follows <slot> assignments into web components.
      const flat = (node) => {
        if (!node) return '';
        if (node.nodeType === 3) return node.nodeValue;
        if (node.tagName === 'SLOT') return node.assignedNodes({ flatten: true }).map(flat).join(' ');
        if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') return '';
        return [...node.childNodes].map(flat).join(' ');
      };
      const txt = (e) => {
        if (!e) return '';
        const plain = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
        if (plain.replace(/[*✱\s]/g, '') || !e.querySelector || !e.querySelector('slot')) return plain;
        return flat(e).replace(/\s+/g, ' ').trim();
      };
      const byId = (id) => (id ? document.getElementById(id) : null);
      const labelFor = (el) => {
        const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        const viaAria = ids.map((i) => txt(byId(i))).filter(Boolean).join(' ');
        if (viaAria) return viaAria;
        if (el.id) {
          const l = __jmLabel(el, el.id);
          if (l && txt(l)) return txt(l);
        }
        // <spl-input label="First name"> and similar web components carry the label on the host.
        const host = el.getRootNode && el.getRootNode().host;
        const hostLabel = host && (host.getAttribute('label') || host.getAttribute('aria-label'));
        if (hostLabel) return hostLabel;
        const wrapLabel = el.closest('label');
        if (wrapLabel && txt(wrapLabel) && !['radio', 'checkbox'].includes(el.type)) return txt(wrapLabel);
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        const c = __jmClosest(el, CONTAINERS);
        if (c) {
          const head = c.querySelector('legend, label, .application-label, [class*="question-title"], [class*="label"], [class*="title"]');
          if (head && txt(head)) return txt(head);
        }
        // Web-component forms (SmartRecruiters <oc-input formcontrolname="firstName">)
        // expose no <label>; their visible wrapper text or semantic attributes do.
        const human = (v) => String(v || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ')
          .replace(/\b(personal info|input|spl form element \d+|oc|field|attrid)\b/gi, ' ').replace(/\s+/g, ' ').trim();
        let n = el;
        for (let i = 0; i < 12 && n; i++) {
          n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
          if (!n || !n.getAttribute) break;
          // A form-field component that renders its own <label> in its shadow root.
          const shadowLabel = n.shadowRoot && n.shadowRoot.querySelector('label');
          if (shadowLabel) {
            // Slotted label text (<spl-input><span slot="label">Question?</span>) is not in the label's own textContent.
            const slotted = [...shadowLabel.querySelectorAll('slot')].flatMap((sl) => sl.assignedNodes({ flatten: true })).map((x) => x.textContent || '').join(' ');
            const t = `${slotted} ${shadowLabel.textContent || ''}`.replace(/\s+/g, ' ').trim();
            if (t.replace(/[*✱\s]/g, '') && t.length < 300) return t;
          }
          if (n.hasAttribute('data-test') && /^div$/i.test(n.tagName)) {
            const t = txt(n);
            if (t && t.length < 80) return t;
          }
          const attr = n.getAttribute('formcontrolname') || n.getAttribute('data-test');
          if (attr && human(attr)) return human(attr);
        }
        return el.getAttribute('placeholder') || el.name || human(el.id) || '';
      };
      const optionLabel = (el) => {
        if (el.id) {
          const l = __jmLabel(el, el.id);
          if (l && txt(l)) return txt(l);
        }
        const l = el.closest('label');
        if (l && txt(l)) return txt(l);
        return txt(el.parentElement) || el.value || '';
      };
      const isRequired = (el, label, container) =>
        !!(el.required || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$|\*\s*\(|required/i.test(label) ||
          (container && container.querySelector('[required], [aria-required="true"]')));

      // Multi-page forms re-collect on every page: drop tags from the previous page.
      for (const e of __jmQA('[data-jm-q], [data-jm-opt]')) {
        e.removeAttribute('data-jm-q');
        e.removeAttribute('data-jm-opt');
      }
      const questions = [];
      let qid = 0;
      const tag = (el) => {
        const id = String(qid++);
        el.setAttribute('data-jm-q', id);
        return id;
      };
      const handled = new Set();
      const els = __jmQA('input, select, textarea, [role="combobox"]', root);
      for (const el of els) {
        if (handled.has(el)) continue;
        const type = (el.getAttribute('type') || el.tagName).toLowerCase();
        if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
        if (/recaptcha|h-captcha|cf-turnstile/.test(el.name || el.id || '')) continue;
        if (el.getAttribute('aria-hidden') === 'true' && type !== 'file') continue;
        const container = __jmClosest(el, CONTAINERS);

        if (type === 'file') {
          // File inputs are usually hidden behind an "Attach" button; keep them.
          // "Autofill from resume" widgets are not the resume field.
          if (__jmClosest(el, '[class*="autofill"], [class*="Autofill"], oc-apply-with-resume')) continue;
          // Custom elements name the upload: <oc-resume-upload>, <spl-dropzone> inside it.
          const ctxTag = __jmClosest(el, 'oc-resume-upload, [data-test*="resume"], [formcontrolname*="resume"]') ? 'Resume' : '';
          const label = ctxTag || labelFor(el) || txt(container).slice(0, 80);
          questions.push({ qid: tag(el), label, kind: 'file', required: isRequired(el, label, null) || /resume|cv/i.test(label), options: [] });
          continue;
        }
        if (!vis(el) && !(type === 'checkbox' && container && container.querySelector('button'))) continue;

        if (type === 'radio' || type === 'checkbox') {
          const group = el.name
            ? __jmQA(`input[name="${CSS.escape(el.name)}"]`, root)
            : container
              ? [...container.querySelectorAll(`input[type="${type}"]`)]
              : [el];
          group.forEach((g) => handled.add(g));
          // Ashby yes/no: hidden checkbox + "Yes"/"No" buttons.
          const btns = container ? [...container.querySelectorAll('button')].filter((b) => /^(yes|no)$/i.test(txt(b))) : [];
          let label = '';
          if (container) {
            const head = container.querySelector('legend, .application-label, [class*="question-title"], label:not(:has(input))');
            label = txt(head);
          }
          if (!label) label = labelFor(el);
          if (btns.length === 2 && !vis(el)) {
            questions.push({ qid: tag(container), label, kind: 'yesno', required: isRequired(el, label, container), options: ['Yes', 'No'] });
            continue;
          }
          const options = group.map(optionLabel);
          const kind = type === 'radio' ? 'radio' : group.length > 1 ? 'checkboxes' : 'checkbox';
          // A lone checkbox's own text IS the question ("I agree to the privacy policy").
          const qLabel = kind === 'checkbox' ? optionLabel(el) || label : label;
          const id = String(qid++);
          group.forEach((g, i) => g.setAttribute('data-jm-opt', `${id}:${i}`));
          questions.push({ qid: id, label: qLabel, kind, required: isRequired(el, label + qLabel, container), options, multiple: kind === 'checkboxes' });
          continue;
        }

        const label = labelFor(el);
        if (/^search\b/i.test(label) || __jmClosest(el, '.iti__dropdown-content, [class*="country-list"], spl-dropdown-search')) continue; // phone country search
        if (el.getAttribute('role') === 'combobox' || el.closest('[class*="select__control"], [class*="-control"]')) {
          questions.push({ qid: tag(el), label, kind: 'combobox', required: isRequired(el, label, container), options: [] });
          continue;
        }
        if (el.tagName === 'SELECT') {
          questions.push({ qid: tag(el), label, kind: 'select', required: isRequired(el, label, container), options: [...el.options].filter((o) => o.value !== '').map((o) => o.text.trim()) });
          continue;
        }
        const kind = el.tagName === 'TEXTAREA' ? 'textarea' : ['email', 'tel', 'url', 'number'].includes(type) ? type : 'text';
        questions.push({ qid: tag(el), label, kind, required: isRequired(el, label, container), options: [] });
      }
      return questions;
    },
    rootSelector,
    QUESTION_CONTAINERS
  );
}

/** Set a text-like value React-safely, then verify it stuck. */
async function setText(page, sel, value) {
  const el = await $deep(page, sel);
  if (!el) return false;
  await el.click({ clickCount: 3 }).catch(() => {});
  await page.evaluate(
    (sel, value) => {
      const e = __jmQ(sel);
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    },
    sel,
    String(value)
  );
  await el.press('Tab').catch(() => {});
  return page.evaluate((sel) => (__jmQ(sel)?.value || '').length > 0, sel);
}

/**
 * Options of THIS combobox only: react-select renders its menu inside the
 * select container (or as #react-select-<id>-listbox). The phone widget's
 * country list (.iti) is never read as a question's options.
 */
const OPTIONS_IN_PAGE = (sel) => {
  const e = __jmQ(sel);
  if (!e) return [];
  const id = e.id || '';
  const listbox = (id && document.getElementById(`react-select-${id}-listbox`)) ||
    (e.getAttribute('aria-controls') && document.getElementById(e.getAttribute('aria-controls')));
  const scope = listbox || e.closest('.select-shell, .select__container, [class*="select-container"], .select') || e.parentElement;
  const local = [...scope.querySelectorAll('[role="option"], [class*="select__option"]')].filter((o) => !o.closest('.iti, .iti__dropdown-content'));
  if (local.length || !window.__jmQA) return local;
  // Web-component dropdowns (SmartRecruiters <spl-dropdown>) render options in shadow roots.
  return window.__jmQA('spl-select-option, [role="option"]').filter((o) => (o.offsetWidth || o.offsetHeight) && (o.textContent || '').trim() && !o.closest('.iti, .iti__dropdown-content'));
};

async function chooseCombobox(page, sel, value) {
  const el = await $deep(page, sel);
  if (!el) return false;
  await el.click().catch(() => {});
  await sleep(300);
  const want = String(value).toLowerCase();
  const clickOption = async () =>
    page.evaluate(
      (sel, want, finder) => {
        const opts = new Function(`return (${finder})`)()(sel);
        const n = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const t = (o) => n(o.innerText || o.textContent);
        const hit = opts.find((o) => t(o) === want) || opts.find((o) => t(o).startsWith(want));
        if (!hit) return null;
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return t(hit);
      },
      sel,
      want,
      OPTIONS_IN_PAGE.toString()
    );
  let got = await clickOption();
  if (!got) {
    // Long lists (countries) and remote suggestions (cities): type, then wait for the pick.
    await el.type(String(value), { delay: 40 }).catch(() => {});
    for (let i = 0; i < 10 && !got; i++) {
      await sleep(500);
      got = await clickOption();
    }
  }
  await sleep(500);
  return page.evaluate(
    (e, want) => {
      const ctl = e.closest('[class*="control"]') || e.parentElement;
      if (ctl && ctl.querySelector('[class*="single-value"], [class*="multi-value"]')) return true;
      if ((e.value || '').trim().length > 0) return true;
      // Web components show the chosen value in their own (shadow) markup.
      let n = e;
      for (let i = 0; i < 5 && n; i++) {
        n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
        const t = n ? `${n.textContent || ''} ${(n.shadowRoot && n.shadowRoot.textContent) || ''}`.toLowerCase() : '';
        if (t.includes(want)) return true;
      }
      return false;
    },
    el,
    want
  );
}

/** Options of a combobox, read by opening it. */
async function comboboxOptions(page, sel) {
  const el = await $deep(page, sel);
  if (!el) return [];
  await el.click().catch(() => {});
  await sleep(400);
  const opts = await page.evaluate(
    (sel, finder) => new Function(`return (${finder})`)()(sel).map((o) => (o.innerText || o.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 80),
    sel,
    OPTIONS_IN_PAGE.toString()
  );
  await el.press('Escape').catch(() => {});
  return opts;
}

/**
 * Location autocompletes (Lever "Current location", Greenhouse "Location (City)"):
 * the typed text only counts once a suggestion is picked.
 */
async function typeAndPick(page, sel, value) {
  const el = await $deep(page, sel);
  if (!el) return false;
  await el.click({ clickCount: 3 }).catch(() => {});
  await el.type(String(value), { delay: 40 });
  await sleep(1800);
  const picked = await page.evaluate((want) => {
    const n = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const opts = [...document.querySelectorAll('.dropdown-location, .dropdown-results div, [role="option"], .pac-item, [class*="suggestion"]')]
      .filter((o) => (o.offsetWidth || o.offsetHeight) && n(o.innerText).includes(n(want).split(',')[0]));
    if (!opts.length) return false;
    opts[0].click();
    return true;
  }, String(value));
  await sleep(400);
  if (!picked) await el.press('Tab').catch(() => {});
  return page.evaluate((sel) => (__jmQ(sel)?.value || '').length > 0, sel);
}

async function fillQuestion(page, q, value) {
  await installDeepHelpers(page);
  const sel = `[data-jm-q="${q.qid}"]`;
  switch (q.kind) {
    case 'file': {
      const el = await $deep(page, sel);
      if (!el) return false;
      await el.uploadFile(value);
      await sleep(1500);
      return true;
    }
    case 'select':
      return page.evaluate(
        (sel, value) => {
          const e = __jmQ(sel);
          const o = [...e.options].find((o) => o.text.trim() === value) || [...e.options].find((o) => o.text.trim().toLowerCase().startsWith(String(value).toLowerCase()));
          if (!o) return false;
          e.value = o.value;
          e.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
        sel,
        value
      );
    case 'radio':
    case 'checkboxes':
    case 'checkbox': {
      const values = q.kind === 'checkbox' ? (value === true ? [0] : []) : [].concat(value).map((v) => q.options.findIndex((o) => o === v));
      let ok = false;
      for (const i of values) {
        if (i < 0) continue;
        const target = await $deep(page, `[data-jm-opt="${q.qid}:${i}"]`);
        if (!target) continue;
        const checked = await page.evaluate((e) => {
          if (!e.checked) ((e.id && __jmLabel(e, e.id)) || e.closest('label') || e).click();
          return e.checked;
        }, target);
        ok = ok || checked;
      }
      return ok;
    }
    case 'yesno':
      return page.evaluate(
        (sel, value) => {
          const c = __jmQ(sel);
          const b = [...c.querySelectorAll('button')].find((b) => (b.innerText || '').trim().toLowerCase() === String(value).toLowerCase());
          if (!b) return false;
          b.click();
          return true;
        },
        sel,
        value
      );
    case 'combobox':
      return chooseCombobox(page, sel, value);
    default: {
      const isAutocomplete = await page.evaluate((sel) => {
        const e = __jmQ(sel);
        return !!e && (e.id === 'location-input' || e.getAttribute('aria-autocomplete') === 'list' || /location/i.test(e.name || '') && e.getAttribute('autocomplete') === 'off');
      }, sel);
      return isAutocomplete ? typeAndPick(page, sel, value) : setText(page, sel, value);
    }
  }
}

/** Labels of required questions that still look empty (read back after filling). */
async function unfilledRequired(page, questions) {
  await installDeepHelpers(page);
  const empty = await page.evaluate((qs) => {
    const out = [];
    for (const q of qs) {
      if (!q.required) continue;
      if (['radio', 'checkboxes', 'checkbox'].includes(q.kind)) {
        if (!__jmQA(`[data-jm-opt^="${q.qid}:"]`).some((i) => i.checked)) out.push(q.label);
        continue;
      }
      const el = __jmQ(`[data-jm-q="${q.qid}"]`);
      if (!el) continue;
      let filled = true;
      if (q.kind === 'file') {
        // Uploaders often clear the <input> and show the file name instead — look
        // at the surrounding components (light and shadow DOM) for it.
        let shown = '';
        let n = el;
        for (let i = 0; i < 6 && n; i++) {
          n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
          if (!n) break;
          shown += ` ${n.innerText || ''} ${(n.shadowRoot && n.shadowRoot.textContent) || ''}`;
        }
        filled = !!(el.files && el.files.length) || /\.(pdf|docx?)\b/i.test(shown);
      }
      else if (q.kind === 'yesno') filled = !!el.querySelector('input:checked, [aria-pressed="true"], [class*="active"], [class*="selected"]');
      else if (q.kind === 'combobox') {
        const ctl = el.closest('[class*="control"]') || el.parentElement;
        filled = !!(ctl && ctl.querySelector('[class*="single-value"], [class*="multi-value"]')) || (el.value || '').length > 0;
      } else filled = (el.value || '').trim().length > 0;
      if (!filled) out.push(q.label);
    }
    return out;
  }, questions);
  return empty;
}

/**
 * A CAPTCHA the user would have to solve: a visible checkbox/image challenge.
 * Invisible reCAPTCHA / hCaptcha badges are not challenges and are ignored.
 */
async function challengeVisible(page) {
  return page.evaluate(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      const st = getComputedStyle(e);
      return r.width > 60 && r.height > 60 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || '';
      if (/recaptcha\/(api2|enterprise)\/bframe/.test(src) && vis(f)) return 'reCAPTCHA challenge';
      if (/recaptcha\/(api2|enterprise)\/anchor/.test(src) && /size=normal/.test(src) && vis(f)) return 'reCAPTCHA checkbox';
      if (/hcaptcha\.com/.test(src) && vis(f) && f.getBoundingClientRect().height > 100) return 'hCaptcha challenge';
      if (/challenges\.cloudflare\.com/.test(src) && vis(f)) return 'Cloudflare Turnstile';
    }
    return '';
  });
}

module.exports = { installDeepHelpers, collectQuestions, fillQuestion, comboboxOptions, unfilledRequired, challengeVisible, setText, typeAndPick };
