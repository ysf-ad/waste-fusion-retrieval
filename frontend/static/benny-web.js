/* Web-only controls. The kiosk still owns the page layout and result renderer. */
window.BennyWeb = (() => {
    // Remembered in English so the FR/EN button can re-render it later.
    const say = (el, text) => window.BennyI18n ? window.BennyI18n.setText(el, text) : (el.textContent = text);
    const samples = {
        can: {
            result:{status:'catalog_match',selected_item:'Aluminum can',policy_category:'Blue Bin',source_category:'Blue Bin',match_probability:.96,instructions:['Empty the can before recycling.'],automatic_routing_enabled:false}},
        hand: {
            result:{status:'no_item',no_item_reason:'human_only',observed:{subject:{choice:'human_only',p:.97}},selected_item:null,category:null,identity_uncertain:true,automatic_routing_enabled:false}},
        wood: {
            result:{status:'manual_review',observed:{match:{choice:'none',p:.89}},selected_item:null,category:null,identity_uncertain:true,automatic_routing_enabled:false}}
    };
    const photoUrl = id => `data:image/jpeg;base64,${window.BennySamplePhotos[id]}`;
    function chooseSample(id) {
        if (!Object.hasOwn(samples, id)) throw new Error('Unknown demo example');
        const bytes = Uint8Array.from(atob(window.BennySamplePhotos[id]), char => char.charCodeAt(0));
        return {blob:new Blob([bytes], {type:'image/jpeg'}), result:{...samples[id].result, fixture:true, build_id:'benny-demo-sample'}};
    }
    async function prepareUpload(file) {
        if (!['image/png','image/jpeg'].includes(file.type) || file.size < 1 || file.size > 10_000_000) throw new Error('Choose a JPEG or PNG up to 10 MB.');
        const bitmap = await createImageBitmap(file, {imageOrientation:'from-image'});
        try {
            if (bitmap.width * bitmap.height > 24_000_000) throw new Error('Choose an image under 24 megapixels.');
            const scale = Math.min(Math.max(1, 280 / Math.min(bitmap.width, bitmap.height)), 1568 / Math.max(bitmap.width, bitmap.height));
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(280, width); canvas.height = Math.max(280, height);
            const ctx = canvas.getContext('2d', {alpha:false});
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
            for (const q of [.90,.75,.55]) {
                const image = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',q));
                if (image?.size > 0 && image.size <= 2_500_000) return image;
            }
            throw new Error('Could not prepare a sufficiently small image.');
        } finally { bitmap.close(); }
    }
    function setup(callbacks) {
        const section = document.getElementById('web-demo');
        section.hidden = false;
        document.getElementById('camera-wrapper').hidden = true;
        document.getElementById('capture-btn').style.display = 'none';
        const nativeHelp = document.querySelector('.instructions-section');
        if (nativeHelp) nativeHelp.hidden = true;
        const live = /^https?:$/.test(location.protocol);
        const file = document.getElementById('web-file');
        const camera = document.getElementById('web-camera-file');
        const submit = document.getElementById('web-submit');
        const status = document.getElementById('web-status');
        const exampleStatus = document.getElementById('web-example-status');
        const simulate = document.getElementById('web-simulate');
        let demoMode = !live;
        simulate.addEventListener('click', () => {
            if (!live || busy) return;
            demoMode = !demoMode;
            simulate.setAttribute('aria-pressed', String(demoMode));
            say(simulate, demoMode ? 'Use live examples' : 'Show simulated examples');
            say(exampleStatus, demoMode ? 'Simulated mode. No example photo will be sent.' : '');
        });
        const buttons = [...section.querySelectorAll('[data-example]')];
        document.getElementById('web-live').hidden = !live;
        document.getElementById('web-example-mode').hidden = !live;
        document.getElementById('web-offline-note').hidden = live;
        let busy = false;
        let captured = null, previewUrl = null, cameraControl;
        const preview = document.getElementById('web-selected-photo');
        const selectedPhoto = () => file.files?.[0] || camera.files?.[0] || captured;
        function refreshPhoto() {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            const photo = selectedPhoto();
            previewUrl = photo ? URL.createObjectURL(photo) : null;
            preview.hidden = !previewUrl;
            if (previewUrl) preview.src = previewUrl;
            else preview.removeAttribute('src');
            update();
        }
        const update = () => {
            submit.disabled = busy || !selectedPhoto();
            for (const button of buttons) button.disabled = busy;
        };
        const cacheKey = id => `benny-example:${window.BennyExampleCacheVersion}:${id}`;
        function cached(id) {
            try {
                const entry = JSON.parse(window.sessionStorage.getItem(cacheKey(id)));
                return entry && entry.until > Date.now() ? entry.result : null;
            } catch { return null; }
        }
        function remember(id, result, durationMs) {
            if (!result || !['catalog_match','no_item','manual_review'].includes(result.status)) return;
            try { window.sessionStorage.setItem(cacheKey(id), JSON.stringify({until:Date.now()+30*60*1000,result:{...result, demo_replay_ms:Math.round(durationMs)}})); } catch { /* cache is optional */ }
        }
        async function runLive(message, action) {
            if (busy) return;
            busy = true;
            cameraControl?.close();
            update();
            say(message, 'Checking exact-mode availability…');
            try {
                const health = await fetch('/api/health', {cache:'no-store', signal:AbortSignal.timeout(4500)});
                if (!health.ok) throw new Error('Live API unavailable. No photo was sent.');
                const api = await health.json();
                if (api.ready !== true || !api.modes?.includes('exact') || api.rate_limit_enforced !== true || api.kiosk_open_set !== true) throw new Error('The matching live kiosk API is not ready or rate-limited. No photo was sent.');
                say(message, '');
                await action();
            } catch (error) { say(message, error instanceof Error ? error.message : 'Live test unavailable.'); }
            finally { busy = false; update(); }
        }
        for (const button of buttons) {
            const id = button.dataset.example;
            button.querySelector('img').src = photoUrl(id);
            button.addEventListener('click', async () => {
                if (busy) return;
                cameraControl?.close();
                if (demoMode) return callbacks.sample(id);
                const prior = cached(id);
                if (prior) {
                    busy = true; update();
                    try { return await callbacks.sample(id, prior); }
                    finally { busy = false; update(); }
                }
                await runLive(exampleStatus, async () => {
                    const {blob} = chooseSample(id);
                    const start = performance.now();
                    remember(id, await callbacks.live(blob, blob), performance.now() - start);
                });
            });
        }
        if (!live) return;
        cameraControl = window.BennyCamera.attach({enabled:() => !busy, onPhoto: photo => {
            file.value = camera.value = '';
            captured = photo;
            refreshPhoto();
        }});
        file.addEventListener('change', () => { cameraControl.close(); camera.value = ''; captured = null; refreshPhoto(); });
        camera.addEventListener('change', () => { cameraControl.close(); file.value = ''; captured = null; refreshPhoto(); });
        // Ctrl+V / Cmd+V an image anywhere on the start page selects it like a chosen photo.
        // It is only previewed; Analyze photo still sends it.
        document.addEventListener('paste', event => {
            if (busy || !document.getElementById('camera-page')?.classList.contains('active')) return;
            const item = [...(event.clipboardData?.items || [])].find(entry => entry.kind === 'file' && entry.type.startsWith('image/'));
            if (!item) return;
            event.preventDefault();
            const blob = item.getAsFile();
            if (!blob || !['image/png', 'image/jpeg'].includes(blob.type)) {
                say(status, 'Paste a PNG or JPEG image.');
                return;
            }
            cameraControl.close();
            file.value = camera.value = '';
            captured = new File([blob], blob.name || `pasted-image.${blob.type === 'image/png' ? 'png' : 'jpg'}`, {type: blob.type});
            refreshPhoto();
            say(status, 'Pasted image ready. Press Analyze photo to check it.');
            submit.focus?.();
        });
        submit.addEventListener('click', async () => {
            if (submit.disabled) return;
            const selected = selectedPhoto();
            await runLive(status, async () => {
                const payload = await prepareUpload(selected);
                file.value = camera.value = '';
                captured = null;
                refreshPhoto();
                await callbacks.live(selected, payload);
            });
        });
        update();
    }
    return {setup, chooseSample};
})();
