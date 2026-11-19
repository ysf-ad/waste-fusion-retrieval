/* Browser camera is opt-in. Taking a photo does not transmit it. */
window.BennyCamera = (() => {
    function attach({onPhoto, enabled = () => true}) {
        const byId = id => document.getElementById(id);
        const open = byId('web-camera-open'), panel = byId('web-camera-panel');
        const video = byId('web-camera-video'), snap = byId('web-camera-snap');
        const cancel = byId('web-camera-close'), status = byId('web-camera-status');
        const fallback = byId('web-native-camera');
        let stream = null, generation = 0, encoding = false;
        const stop = media => { for (const track of media?.getTracks() || []) track.stop(); };
        const frameReady = () => Boolean(stream && video.videoWidth && video.videoHeight && video.readyState >= 2);
        const refresh = () => { snap.disabled = encoding || !frameReady(); };
        function close() {
            generation++;
            stop(stream);
            stream = null;
            video.srcObject = null;
            panel.hidden = true;
            encoding = false;
            refresh();
        }
        function unavailable(message) {
            close();
            status.textContent = `${message} Choose a photo instead, or use your device camera if offered.`;
            if (fallback) fallback.hidden = false;
        }
        function explanation(error) {
            if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Camera permission was not granted.';
            if (error?.name === 'NotFoundError') return 'No camera was found.';
            if (error?.name === 'NotReadableError') return 'The camera is busy or could not start.';
            return 'Camera access is unavailable.';
        }
        open.addEventListener('click', async () => {
            if (!enabled() || !panel.hidden) return;
            if (window.isSecureContext !== true || !navigator.mediaDevices?.getUserMedia) {
                unavailable('This browser cannot open a camera here.');
                return;
            }
            const token = ++generation;
            panel.hidden = false;
            status.textContent = 'Waiting for camera permission…';
            try {
                const camera = await navigator.mediaDevices.getUserMedia({ audio:false,
                    video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}} });
                if (token !== generation) { stop(camera); return; }
                stream = camera;
                video.srcObject = camera;
                await video.play();
                if (token !== generation) return;
                status.textContent = 'Frame the item, then capture the photo.';
                refresh();
            } catch (error) {
                if (token === generation) unavailable(explanation(error));
            }
        });
        for (const event of ['loadeddata', 'playing', 'resize']) video.addEventListener(event, refresh);
        cancel.addEventListener('click', () => { close(); status.textContent = ''; });
        window.addEventListener('pagehide', close);
        snap.addEventListener('click', async () => {
            if (!enabled() || snap.disabled || !frameReady()) return;
            const token = generation;
            encoding = true;
            refresh();
            try {
                const canvas = document.createElement('canvas');
                const scale = Math.min(1, 1568 / Math.max(video.videoWidth, video.videoHeight));
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                const ctx = canvas.getContext('2d', {alpha:false});
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.9));
                if (token !== generation) return;
                if (!blob?.size || blob.type !== 'image/jpeg') throw new Error('Camera returned no JPEG');
                const photo = new File([blob], 'camera-photo.jpg', {type:'image/jpeg'});
                close();
                onPhoto(photo);
                status.textContent = 'Photo captured. Check the preview before analyzing.';
            } catch {
                if (token === generation) unavailable('Could not capture a photo.');
            }
        });
        return {close};
    }
    return {attach};
})();
