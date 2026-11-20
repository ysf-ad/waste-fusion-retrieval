import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const source = new URL('../../frontend/static/', import.meta.url);
const media = new URL('../public/benny-media/', import.meta.url);
const sampleIds = ['can', 'hand', 'wood'];
const esc = text => String(text).replace(/[&<>"']/g, value => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]));
function https(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Expected a public HTTPS photo credit URL');
    return esc(url.href);
}
export async function buildBennyWeb() {
    const load = name => readFile(new URL(name, source), 'utf8');
    const [html, css, info, orientation, web, camera] = await Promise.all(['index.html','styles.css','result-info.js','camera-orientation.js','benny-web.js','benny-camera.js'].map(load));
    const credits = JSON.parse(await readFile(new URL('credits.json', media), 'utf8'));
    const photos = Object.fromEntries(await Promise.all(sampleIds.map(async id => {
        const jpg = await readFile(new URL(`${id}.jpg`, media));
        if (jpg.length < 4 || jpg.length > 120_000 || jpg[0] !== 255 || jpg[1] !== 216 || jpg[2] !== 255 ||
            createHash('sha256').update(jpg).digest('hex') !== credits[id]?.sha256) throw new Error(`Invalid or changed sample photo: ${id}`);
        return [id, jpg.toString('base64')];
    })));
    const creditList = sampleIds.map(id => {
        const {author, source, license, license_url} = credits[id];
        return `<li><a href="${https(source)}">${esc({can:'Drink can',hand:'Bare hand',wood:'Wood fragment'}[id])}</a> by ${esc(author)} · <a href="${https(license_url)}">${esc(license)}</a> · resized and recompressed</li>`;
    }).join('\n');
    const normalize = text => text.replaceAll('\r\n','\n');
    const cacheVersion = createHash('sha256').update(JSON.stringify(photos)).update(normalize(web)).update(normalize(info));
    for (const name of ['questions.mjs','policy.mjs','catalog-decision.mjs','providers.mjs','items.json']) cacheVersion.update(normalize(await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')));
    const cacheTag = cacheVersion.digest('hex').slice(0, 16);
    let page = html;
    const replace = (needle, text) => {
        if (page.split(needle).length !== 2) throw new Error(`Browser build anchor must appear exactly once: ${needle}`);
        page = page.replace(needle, () => text);
    };
    const inline = js => `<script>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`;
    const webCss = `
        [hidden] { display: none !important; }
        :root { --screen-rotation: 0deg; }
        .header-bar { justify-content: flex-start; }
        .header-bar .contrast-button-group { margin-left: auto; }
        #web-demo { color: var(--ink); background: #eef5ff; border: 3px solid var(--edge); border-radius: 14px; padding: clamp(18px,4vw,48px); flex:1; overflow:auto; }
        .web-inner { max-width: 1050px; margin: 0 auto; }
        .web-kicker { color: #264f8a; font-size:.83rem; letter-spacing:.07em; text-transform:uppercase; font-weight:600; }
        #web-demo h2 { font-family:var(--head); font-size:clamp(1.6rem,4vw,2.75rem); margin:.25em 0; }
        .web-lead { max-width:60ch; line-height:1.5; }
        .web-example-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:clamp(8px,2vw,20px); margin:1.3rem 0; }
        .web-example-grid button { color:var(--ink); border:2px solid #c0d4ee; background:white; border-radius:14px; overflow:hidden; cursor:pointer; font:600 clamp(.85rem,2vw,1.1rem) var(--body); padding:0 0 .7em; }
        .web-example-grid button:hover,.web-example-grid button:focus-visible { border-color:#264f8a; background:#f5faff; }
        .web-example-grid img { width:100%; aspect-ratio: 2/1; object-fit:contain; background:#e0eaf7; display:block; margin-bottom:.55em; }
        #web-live { background:#fff; border:1px solid #aec6e5; border-radius:14px; padding:clamp(14px,3vw,24px); margin-top:.75rem; }
        #web-live p { margin:.5rem 0; line-height:1.4; }
        #web-live label { display:block; margin:.6rem 0; }
        .web-photo-controls { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.7rem; }
        .web-picker { font-weight:600; border:1px solid #aec6e5; border-radius:10px; padding:.6rem; min-width:0; }
        .web-picker input { display:block; width:100%; margin-top:.4rem; font:inherit; font-size:.8rem; }
        .web-picker input::file-selector-button { min-height:32px; cursor:pointer; }
        .web-example-heading { margin-top:1.2rem; }
        .web-mode-button { margin:.3rem .2rem; min-height:36px; padding:.25rem .55rem; border:1px solid #7b97b9; border-radius:8px; background:#fff; color:#15375f; cursor:pointer; }
        #web-camera-panel { margin:.6rem 0; }
        #web-camera-panel video { display:block; width:min(100%,540px); aspect-ratio:16/9; object-fit:contain; background:#142337; border-radius:10px; margin-bottom:.6rem; }
        #web-camera-panel button { margin:.15rem .15rem .15rem 0; }
        #web-camera-status:empty { display:none; }
        #web-selected-photo { display:block; width:min(100%,340px); max-height:220px; object-fit:contain; background:#142337; border-radius:10px; margin:.6rem 0; }
        #web-example-status:empty,#web-status:empty { display:none; }
        @media (max-width: 460px) { .web-photo-controls { grid-template-columns:minmax(0,1fr); gap:0; } #web-submit { width:100%; min-height:44px; } }
        #web-submit:disabled { opacity:.5; }
        #web-output-kind { font-weight:700; }
        .web-kind-note { font-size:.8rem; opacity:.85; }
        @media (max-width: 700px) {
          .result-page.active, .scan-page.active { grid-template-columns:minmax(0,1fr); grid-template-rows:repeat(3,max-content); align-content:start; height:100dvh; overflow-y:auto; font-size:14px; }
          /* Panels grow with their content on phones; never clip the item name or confidence. */
          .result-page.active > .panel, .scan-page.active > .panel { min-height:max-content; overflow:visible; }
          .result-page .info-wrapper { flex:none; overflow:visible; }
          .layout-info .image-wrapper { max-height:180px; }
          .layout-info .info-title,.layout-info .bin-text { font-size:2em; }
          .layout-info .right-panel { min-height:230px; }
          .web-example-grid img { aspect-ratio:1.08; }
          .header-bar { gap:.3rem; }.header-btn { padding:.6rem .7rem; }
        }
    `;
    replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n${webCss}\n</style>`);
    // Keep fully offline sample mode self-contained, including fonts and initial frame.
    const fontTag = page.match(/^    <link href="https:\/\/fonts\.googleapis\.com[^\n]+\n/m)?.[0];
    if (fontTag) replace(fontTag, '');
    replace('src="/api/stream"', '');
    replace('<label><input type="checkbox" id="debug-long" /> Long text</label>', '<input type="hidden" id="debug-long" />');
    replace('        <div class="camera-container" id="camera-wrapper">', `        <section id="web-demo" hidden>
            <div class="web-inner">
                <p class="web-kicker">Benny · Web demo</p>
                <h2>What are you sorting?</h2>
                <section id="web-live" aria-label="Analyze your own photo">
                    <p class="web-lead">Take a photo, choose one, or paste an image (Ctrl+V) to check it against the Waste Wizard catalog.</p>
                    <div class="web-photo-controls">
                        <label class="web-picker">Choose a photo<input id="web-file" type="file" accept="image/jpeg,image/png" /></label>
                        <div class="web-picker"><button class="header-btn" id="web-camera-open" type="button">Take Photo</button></div>
                    </div>
                    <div id="web-camera-panel" hidden>
                        <video id="web-camera-video" autoplay muted playsinline aria-label="Camera preview"></video>
                        <button class="header-btn" id="web-camera-snap" type="button" disabled>Capture photo</button>
                        <button class="header-btn" id="web-camera-close" type="button">Close camera</button>
                    </div>
                    <p id="web-camera-status" role="status" aria-live="polite"></p>
                    <label id="web-native-camera" class="web-picker" hidden>Try device camera<input id="web-camera-file" type="file" accept="image/jpeg,image/png" capture="environment" /></label>
                    <img id="web-selected-photo" alt="Selected photo, not yet sent" hidden />
                    <button class="header-btn" id="web-submit" type="button" disabled>Analyze photo</button>
                    <p class="web-kind-note">JPEG or PNG up to 10 MB. Analyze sends a prepared copy to the model provider. Use a photo you have permission to share.</p>
                    <p id="web-status" role="status" aria-live="polite"></p>
                </section>
                <h3 class="web-example-heading">Or try an example</h3>
                <p id="web-example-mode" class="web-kind-note">Click a photo to analyze it live. <button type="button" class="web-mode-button" id="web-simulate" aria-pressed="false">Show simulated examples</button></p>
                <p id="web-offline-note" class="web-lead" hidden>Offline preview. Sample results are simulated. No image is uploaded.</p>
                <p id="web-example-status" role="status" aria-live="polite"></p>
                <div class="web-example-grid">
                    <button type="button" data-example="can"><img alt="" />Drink can</button>
                    <button type="button" data-example="hand"><img alt="" />Bare hand</button>
                    <button type="button" data-example="wood"><img alt="" />Wood fragment</button>
                </div>
                <details id="web-credits">
                    <summary>Sample photo credits</summary>
                    <ul>${creditList}</ul>
                </details>

            </div>
        </section>
        <div class="camera-container" id="camera-wrapper">`);
    replace('<span>How Long It Took Benny To Process Your Query: <span id="inference-time">-</span></span>', '<span><span id="web-output-kind">Sample result · no live inference</span><span id="web-live-timing" hidden> · <span id="inference-time">-</span></span></span>');
    replace('<script src="result-info.js"></script>', inline(info));
    replace('<script src="camera-orientation.js"></script>', `${inline(orientation)}\n${inline(`window.BennySamplePhotos = Object.freeze(${JSON.stringify(photos)}); window.BennyExampleCacheVersion = ${JSON.stringify(cacheTag)};`)}\n${inline(camera)}\n${inline(web)}`);
    replace('        startCamera();', `        window.CameraOrientation.configure({orientation:{screen_rotation:0,live_rotation:0}},document);
        window.BennyWeb.setup({
            sample: async (id, cached) => {
                const sample = window.BennyWeb.chooseSample(id);
                uploadMode = true;
                setScanImage(sample.blob);
                document.getElementById('image-preview-label').textContent = 'Sample photo';
                document.getElementById('web-output-kind').textContent = cached ? 'Cached live result · no new request' : 'Sample result · no live inference';
                document.getElementById('web-live-timing').hidden = true;
                if (cached) {
                    const scan = beginScan();
                    inferenceStartTime = performance.now();
                    startScanTimer();
                    showPage(loadingPage);
                    const delay = Number.isFinite(cached.demo_replay_ms) ? Math.min(3000, Math.max(250, cached.demo_replay_ms)) : 650;
                    await new Promise(resolve => setTimeout(resolve, delay));
                    if (!isCurrentScan(scan)) return;
                    finishScan(scan);
                    const { demo_replay_ms, ...result } = cached;
                    return displayResult(result, null, 0);
                }
                await displayResult(sample.result, null, 0);
            },
            live: async (original, prepared) => {
                const scan = beginScan();
                uploadMode = true;
                setScanImage(original);
                document.getElementById('image-preview-label').textContent = 'Original photo preview';
                document.getElementById('web-output-kind').textContent = 'Live exact-mode result';
                document.getElementById('web-live-timing').hidden = false;
                inferenceTimeDisplay.textContent = '-';
                showPage(loadingPage);
                return processImage(prepared,scan);
            }
        });`);
    replace("const API_ENDPOINT = '/api/predict';", "const API_ENDPOINT = '/predict';");
    replace("            formData.append('file', blob, 'capture.jpg');", "            formData.append('file', blob, 'capture.jpg');\n            formData.append('mode', 'exact');");
    replace('                await displayResult(data, blob, inferenceTime);', '                await displayResult(data, null, inferenceTime);\n                return data;');
    replace('            autoReturnTimer = debugMode ? null : setTimeout(resetCamera, 5000);','            autoReturnTimer = null; // Web testers can read results until they choose Back.');
    replace('            if (debugMode) return; // never store fake debug photos','            return; // Web demo does not save any photos.');
    return '<!-- Generated from the Pi kiosk. Run node worker/scripts/build-benny-web.mjs; do not edit directly. -->\n' + page.replace(/^[\t ]+$/gm, '');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const target = new URL('../public/benny.html', import.meta.url);
    const page = await buildBennyWeb();
    if (process.argv.includes('--check')) {
        if ((await readFile(target,'utf8')).replaceAll('\r\n','\n') !== page.replaceAll('\r\n','\n')) throw new Error('Generated Benny demo is stale');
    } else {
        await mkdir(new URL('.',target),{recursive:true});
        await writeFile(target,page);
    }
    console.log(`Benny web demo ${process.argv.includes('--check') ? 'verified' : 'built'}`);
}
