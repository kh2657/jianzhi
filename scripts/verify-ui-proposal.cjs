// 本地设计原型验收：node scripts/verify-ui-proposal.cjs
// 只打开独立 HTML 与临时 Chrome profile，不启动产品，不读真实库。
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const projectRoot = join(__dirname, '..');
const target = join(projectRoot, 'docs/设计提案-2026-10-10-学习工作台重构.html');
const output = join(projectRoot, 'docs/screenshots/premium-2026-10-10');
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const runtime = [];
  const checks = [];
  page.on('pageerror', e => runtime.push(e.message));
  page.on('console', m => { if (m.type() === 'error') runtime.push(m.text()); });
  page.on('requestfailed', r => runtime.push('requestfailed: ' + r.url()));
  page.on('response', r => { if (r.status() >= 400) runtime.push(r.status() + ': ' + r.url()); });
  try {
    await page.goto(pathToFileURL(target).href);
    await expect(page.locator('#premium')).toBeVisible();
    const root = page.locator('#premium');
    const interactions = [];
    async function click(selector) {
      const el = root.locator(selector);
      await el.scrollIntoViewIfNeeded();
      const hit = await el.evaluate(el => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return el === hit || el.contains(hit);
      });
      if (!hit) throw new Error('Hit test failed: ' + selector);
      await el.click();
    }
    async function gotoView(view) {
      if (await root.locator('#px-ideas-panel').isVisible()) {
        if (await root.locator('#px-quick-idea').getAttribute('aria-expanded') === 'true') await click('#px-close-ideas');
        await expect(root.locator('#px-ideas-panel')).toBeHidden();
      }
      if (view === 'ideas') { await click('#px-quick-idea'); return; }
      const groups = { notes:'learning',question:'learning',wiki:'learning',reader:'learning',schedule:'plan',footprint:'plan',library:'sources',papers:'sources' };
      await click('.px-primary-nav [data-px-group="'+groups[view]+'"]');
      if (view === 'reader') {
        if (await root.getAttribute('data-px-current-view') !== 'reader') await click('#px-resume-reading');
      } else if (await root.getAttribute('data-px-current-view') !== view) await click('#px-context-nav [data-px-view="'+view+'"]');
    }
    await expect(root.locator('#px-source-toggle')).toBeHidden();
    await expect(root.locator('.px-primary-nav [data-px-group]').first()).toHaveAttribute('data-px-group', 'learning');
    const views = ['notes','ideas','schedule','footprint','question','library','papers','wiki','reader'];
    await expect(root.locator('.px-primary-nav [data-px-group]')).toHaveCount(3);
    await expect(root).toHaveAttribute('data-px-current-view','notes');
    await click('.px-workspace-menu summary');
    await click('.px-workspace-options [data-px-group="plan"]');
    await expect(root).toHaveAttribute('data-px-primary-group', 'plan');
    await expect(root.locator('.px-workspace-menu')).not.toHaveAttribute('open');
    await click('.px-primary-nav [data-px-group="learning"]');
    await click('#px-context-nav [data-px-view="question"]');
    await click('#px-group-home');
    await expect(root).toHaveAttribute('data-px-current-view', 'notes');
    await click('#px-quick-idea');
    await expect(root).toHaveAttribute('data-px-current-view','notes');
    await expect(root.locator('#px-flow-idea-input')).toBeFocused();
    await root.locator('#px-flow-idea-input').fill('尚未保存的想法');
    await root.locator('#px-flow-idea-input').press('Escape');
    await expect(root.locator('#px-ideas-panel')).toBeHidden();
    await expect(root.locator('#px-quick-idea')).toBeFocused();
    await click('#px-quick-idea');
    await expect(root.locator('#px-flow-idea-input')).toHaveValue('尚未保存的想法');
    await root.locator('#px-flow-idea-input').fill('');
    await click('#px-close-ideas');
    const body = root.locator('#px-note-body');
    await expect(root.locator('#px-note-preview')).toBeVisible();
    await expect(root.locator('.px-theorem .katex')).toHaveCount(3);
    await expect(root.locator('.px-theorem math')).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    const mathBefore = await root.locator('.px-theorem .katex').first().evaluate(el => ({
      size: parseFloat(getComputedStyle(el).fontSize),
      parentSize: parseFloat(getComputedStyle(el.closest('.px-theorem')).fontSize),
      markup: el.outerHTML,
      fonts: [...document.fonts].filter(f => f.family.includes('KaTeX') && f.status === 'loaded').length,
    }));
    if (!mathBefore.fonts || Math.abs(mathBefore.size / mathBefore.parentSize - 1.21) > .01) throw new Error('Matched math fonts or standard size ratio missing: ' + JSON.stringify(mathBefore));
    await click('#px-type-settings summary');
    await root.locator('#px-reading-size').selectOption('20');
    await root.locator('#px-type-preset').selectOption('tex');
    const mathAfter = await root.locator('.px-theorem .katex').first().evaluate(el => ({size: parseFloat(getComputedStyle(el).fontSize), markup: el.outerHTML}));
    if (mathBefore.markup !== mathAfter.markup || Math.abs(mathAfter.size - 24.2) > .1) throw new Error('Typography setting changed math internals');
    await root.locator('#px-reading-size').selectOption('16');
    await root.locator('#px-type-preset').selectOption('times');
    await click('#px-type-settings summary');
    await root.locator('#px-search').fill('紧致性');
    await gotoView('library');
    await expect(root.locator('#px-search')).toHaveValue('');
    await root.locator('#px-search').fill('Functional');
    await gotoView('notes');
    await expect(root.locator('#px-search')).toHaveValue('紧致性');
    await root.locator('#px-search').fill('');
    await gotoView('library');
    await expect(root.locator('#px-search')).toHaveValue('Functional');
    await root.locator('#px-search').fill('');
    await gotoView('notes');
    await root.locator('.px-detail').hover();
    await page.mouse.wheel(0,260);
    await page.waitForFunction(() => document.querySelector('#premium .px-detail').scrollTop > 0);
    const savedScroll = await root.locator('.px-detail').evaluate(el => el.scrollTop);
    await gotoView('schedule');
    await click('#px-quick-idea');
    await root.locator('#px-flow-idea-input').fill('计划页尚未整理的想法');
    await expect(root).toHaveAttribute('data-px-current-view','schedule');
    await click('.px-primary-nav [data-px-group="sources"]');
    await expect(root).toHaveAttribute('data-px-current-view','library');
    await expect(root.locator('#px-flow-idea-input')).toHaveValue('计划页尚未整理的想法');
    await root.locator('#px-flow-idea-input').fill('');
    await click('#px-close-ideas');
    await expect(root.locator('#px-ideas-panel')).toBeHidden();
    await gotoView('notes');
    const restoredScroll = await root.locator('.px-detail').evaluate(el => el.scrollTop);
    if (Math.abs(savedScroll-restoredScroll)>2) throw new Error('Learning position was reset');
    await root.locator('.px-detail').hover();
    await page.mouse.wheel(0,-600);
    await page.waitForFunction(() => document.querySelector('#premium .px-detail').scrollTop === 0);
    await click('#px-resume-reading');
    await expect(root).toHaveAttribute('data-px-current-view','reader');
    await click('#px-context-back');
    await expect(root).toHaveAttribute('data-px-current-view','notes');
    await click('#px-edit-toggle');
    await body.fill('QA 草稿：切页、预览和回源后必须保留。');
    await click('#px-edit-toggle');
    await expect(body).toHaveAttribute('readonly', '');
    await expect(body).toHaveValue('QA 草稿：切页、预览和回源后必须保留。');
    await click('#px-edit-toggle');
    await expect(body).toBeEditable();
    await click('[data-px-item="compact"]');
    await click('[data-px-item="complete"]');
    await expect(body).toHaveValue('QA 草稿：切页、预览和回源后必须保留。');
    await root.locator('#px-note-title').fill('可检索的新标题');
    await root.locator('#px-search').fill('可检索的新标题');
    await expect(root.locator('[data-px-item]')).toHaveCount(1);
    await root.locator('#px-search').fill('不存在的内容');
    await expect(root.locator('#px-empty')).toBeVisible();
    await expect(root.locator('[data-px-item]')).toHaveCount(0);
    await root.locator('#px-search').fill('');
    await root.locator('#px-filter').selectOption('functional');
    await expect(root.locator('[data-px-item]')).toHaveCount(1);
    await root.locator('#px-filter').selectOption('all');
    await gotoView('ideas');
    await root.locator('#px-flow-idea-input').fill('QA 想法：研究这个极限。');
    await root.locator('#px-flow-idea-input').press('Control+Enter');
    await expect(root.locator('#px-flow-ideas-list')).toContainText('QA 想法');
    await click('[data-px-flow-action="edit-idea"][data-px-flow-id="3"]');
    await root.locator('[data-px-flow-edit="3"]').fill('QA 想法修改：研究这个极限。');
    await click('[data-px-flow-action="save-idea"][data-px-flow-id="3"]');
    await gotoView('schedule');
    await click('[data-px-flow-action="toggle-task"][data-px-flow-id="read"]');
    await expect(root.locator('[data-px-flow-action="toggle-task"][data-px-flow-id="read"]')).toHaveAttribute('aria-pressed','true');
    await click('[data-px-flow-action="toggle-task"][data-px-flow-id="read"]');
    await expect(root.locator('[data-px-flow-action="toggle-task"][data-px-flow-id="read"]')).toHaveAttribute('aria-pressed','false');
    await click('[data-px-flow-day="2026-10-06"]');
    await expect(root.locator('#px-flow-tasks')).toContainText('暂无');
    await gotoView('ideas');
    await expect(root.locator('#px-flow-ideas-list')).toContainText('QA 想法修改');
    await click('[data-px-flow-action="convert-idea"][data-px-flow-id="3"]');
    await expect(root).toHaveAttribute('data-px-current-view','notes');
    await expect(body).toHaveValue('QA 想法修改：研究这个极限。');
    await gotoView('ideas');
    await expect(root.locator('#px-flow-ideas-list')).toContainText('QA 想法修改');
    await gotoView('footprint');
    await expect(root.locator('[data-px-flow-foot-day]')).toHaveCount(119);
    await click('[data-px-flow-foot-day="2026-10-10"]');
    await click('#px-flow-activities [data-px-flow-nav="notes"]');
    await expect(body).toHaveValue('QA 草稿：切页、预览和回源后必须保留。');
    await gotoView('question');
    await click('#px-question-panel [data-px-flow-nav="wiki"]');
    await expect(root.locator('#px-wiki-panel')).toBeVisible();
    await gotoView('papers');
    await click('[data-px-flow-action="paper-summary"][data-px-flow-id="uniform"]');
    await expect(root.locator('.px-flow-paper-summary')).toBeVisible();
    await click('[data-px-flow-action="paper-follow"][data-px-flow-id="uniform"]');
    await expect(root.locator('[data-px-flow-action="paper-follow"][data-px-flow-id="uniform"]')).toHaveAttribute('aria-pressed','true');
    await gotoView('library');
    await expect(root.locator('#px-library-panel')).toBeVisible();
    await expect(root.locator('#px-notes-panel')).toBeHidden();
    await expect(root.locator('[data-px-item]')).toHaveCount(3);
    await click('[data-px-item="brezis"]');
    await expect(root.locator('#px-book-title')).toHaveText('Functional Analysis');
    await expect(root.locator('#px-continue')).toBeHidden();
    await click('[data-px-item="rudin"]');
    await click('#px-continue');
    await expect(root).toHaveAttribute('data-px-current-view','reader');
    await expect(root.locator('.px-master')).toBeHidden();
    await expect(root.locator('#px-paper-highlight')).toBeFocused();
    await click('#px-source-toggle');
    await expect(root.locator('.px-margin')).toBeHidden();
    await click('#px-source-toggle');
    await expect(root.locator('.px-margin')).toBeVisible();
    await root.locator('#px-margin-note').fill('阅读侧草稿');
    await click('#px-focus');
    await expect(root.locator('.px-sidebar')).toBeHidden();
    await expect(root.locator('.px-margin')).toBeHidden();
    await click('#px-focus');
    await expect(root.locator('.px-sidebar')).toBeVisible();
    await expect(root.locator('#px-margin-note')).toHaveValue('阅读侧草稿');
    await click('#px-theme');
    await expect(root).toHaveAttribute('data-px-theme','dark');
    await click('#px-theme');
    await expect(root).toHaveAttribute('data-px-theme','light');
    await click('#px-back-note');
    await expect(body).toHaveValue('QA 草稿：切页、预览和回源后必须保留。');
    await expect(root.locator('#px-note-title')).toHaveValue('可检索的新标题');
    await click('[data-px-open-source] >> nth=0');
    await expect(root).toHaveAttribute('data-px-current-view','reader');
    await expect(root.locator('#px-paper-highlight')).toBeFocused();
    await click('#px-copy-feedback');
    await expect(root.locator('#px-feedback-status')).toHaveText('先填写修改意见。');
    await root.locator('#px-feedback-text').fill('布局方向通过，正文再宽一些。');
    await click('#px-copy-feedback');
    await expect(root.locator('#px-feedback-status')).toContainText(/已复制|未允许复制/);
    interactions.push('three primary entries; current note opens directly; all nine capabilities retained', 'matched KaTeX fonts, MathML and 1.21 size ratio; text preset leaves math internals unchanged', 'idea keyboard capture, edit, persistence and conversion without deletion', 'task complete/undo and day empty state', '119 footprint dates and return to notes', 'question to Wiki; paper summary and follow', 'draft survives preview, selection, navigation and source jump', 'renamed title search and empty/filter states', 'library detail and reader flow', 'source panel and focus', 'themes', 'feedback and clipboard fallback');
    await page.reload();
    for (const [width, height] of [[1366,768],[1512,982],[1920,1080],[2560,1440],[1210,786],[1890,1228],[800,900],[390,844]]) {
      await page.setViewportSize({ width, height });
      for (const view of views) {
      await gotoView(view);
      const geometry = await page.locator('#premium').evaluate(root => {
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const bad = [...root.querySelectorAll('button,input,textarea,select')].filter(visible).flatMap(el => {
          const r = el.getBoundingClientRect();
          return r.width < 1 || r.height < 1 || r.left < -1 || r.right > innerWidth + 1 ? [{ text: el.getAttribute('aria-label') || el.textContent.slice(0,60), x:r.x,width:r.width }] : [];
        });
        return { rootWidth: root.getBoundingClientRect().width, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, bad };
      });
      checks.push({ width, height, view, ...geometry });
      if (geometry.overflow || geometry.bad.length) throw new Error('Geometry failed: ' + JSON.stringify(checks.at(-1)));
      if (width === 1512 || width === 390 && ['notes','ideas'].includes(view)) {
        await page.mouse.move(0,0);
        // Timer polling also observes settled animations when parallel Electron QA backgrounds Chrome.
        await page.waitForFunction(() => document.querySelector('#premium').getAnimations({subtree:true}).length === 0, null, { polling: 100 }).catch(async error => {
          console.error('Unsettled animations', { width, view }, await root.evaluate(root => root.getAnimations({subtree:true}).map(a => ({ state: a.playState, target: a.effect?.target?.outerHTML?.slice(0,180), timing: a.effect?.getComputedTiming() }))));
          throw error;
        });
        await root.locator('.px-shell').screenshot({ path: output + '/' + view + (width === 390 ? '-mobile' : '') + '.png' });
      }
      }
    }
    await page.setViewportSize({ width: 1512, height: 982 });
    // Interrupted transitions settle to the last requested view and leave no running animation.
    for (const group of ['sources','plan','learning']) await click('.px-primary-nav [data-px-group="'+group+'"]');
    await gotoView('notes');
    await expect(root).toHaveAttribute('data-px-current-view','notes');
    await page.waitForFunction(() => document.querySelector('#premium .px-detail').getAnimations().length === 0, null, { polling: 100 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoView('ideas');
    if (await root.evaluate(root => root.getAnimations({subtree:true}).length)) throw new Error('Reduced motion still animated');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    interactions.push('rapid page switching cancels old transitions; reduced motion disables animations', 'quick capture preserves work route and unsaved input; Escape restores trigger focus', 'note/library filters stay separate; work scroll restores; specific reading resumes in one click and returns', 'quick capture stays open and keeps input across primary group switches');
    await gotoView('notes');
    await page.mouse.move(0,0);
    await page.waitForFunction(() => document.querySelector('#premium').getAnimations({subtree:true}).length === 0);
    await root.locator('.px-shell').screenshot({ path: output + '/notes.png' });
    console.log(JSON.stringify({ checks, runtime, interactions }, null, 2));
    fs.writeFileSync(output + '/qa.json', JSON.stringify({ checks, runtime, interactions }, null, 2));
    if (runtime.length) throw new Error('Runtime errors: ' + runtime.join('\n'));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
