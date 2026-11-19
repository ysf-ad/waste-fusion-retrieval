/* Presentation only: never draw transformed pixels or modify an upload Blob. */
(function (root) {
    'use strict';
    const DEFAULTS = Object.freeze({ screen_rotation: 180, live_rotation: 180,
        captured_rotation: 0, live_mirror: false, captured_mirror: false });
    let state = { ...DEFAULTS };
    const images = new Map();
    const angle = (value, fallback, allowed) => Number.isInteger(value) && allowed.includes(value) ? value : fallback;
    const flag = (value, fallback) => typeof value === 'boolean' ? value : fallback;

    function normalize(config = {}) {
        if (!config || typeof config !== 'object') config = {};
        const raw = config.orientation && typeof config.orientation === 'object' ? config.orientation : {};
        return {
            screen_rotation: angle(raw.screen_rotation, DEFAULTS.screen_rotation, [0, 180]),
            live_rotation: angle(raw.live_rotation, DEFAULTS.live_rotation, [0, 90, 180, 270]),
            captured_rotation: angle(raw.captured_rotation, DEFAULTS.captured_rotation, [0, 90, 180, 270]),
            live_mirror: flag(raw.live_mirror, DEFAULTS.live_mirror),
            captured_mirror: flag(raw.captured_mirror, flag(config.flip_image, DEFAULTS.captured_mirror))
        };
    }
    function transformFor({ source = 'camera', view = 'captured' } = {}) {
        if (!['camera', 'upload'].includes(source)) throw new TypeError('Unknown image source');
        if (!['live', 'captured'].includes(view)) throw new TypeError('Unknown image view');
        // Uploaded files retain native orientation in scan, result and zoom.
        if (source === 'upload') return 'none';
        const rotation = view === 'live' ? state.live_rotation : state.captured_rotation;
        const mirror = view === 'live' ? state.live_mirror : state.captured_mirror;
        return `rotate(${rotation}deg) scaleX(${mirror ? -1 : 1})`;
    }
    function applyImage(element, options = {}) {
        if (!element || !element.style) return;
        const transform = transformFor(options);
        images.set(element, { ...options });
        element.style.transform = transform;
    }
    function configure(config = {}, document = root.document) {
        state = normalize(config);
        const style = document?.documentElement?.style;
        if (style) {
            style.setProperty('--screen-rotation', `${state.screen_rotation}deg`);
            style.setProperty('--camera-live-rotation', `${state.live_rotation}deg`);
            style.setProperty('--camera-live-mirror', state.live_mirror ? '-1' : '1');
        }
        for (const [image, options] of images) image.style.transform = transformFor(options);
        return { ...state };
    }
    root.CameraOrientation = Object.freeze({ normalize, configure, applyImage, transformFor,
        getState: () => ({ ...state }) });
})(typeof window === 'undefined' ? globalThis : window);
