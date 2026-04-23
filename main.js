// ═══════════════════════════════════════════════════════════════════════════
// web-tool — app orchestrator
//
// Pipeline : source → main shader → (effect shader?) → compositor → screen
//
// Shaders are plugged in via manifests in shaders/{main,effects}/index.json.
// Each shader exposes its own UI by embedding a JSON `@config` block in a
// GLSL comment; config-parser.js reads it and builds matching controls.
// ═══════════════════════════════════════════════════════════════════════════

import {
    compileShader, createProgram, createFBO,
    setU1i, setU1f, setU2f, setU1fv, hexToRgb, applyUniform,
} from './core/webgl-utils.js';
import { parseShaderConfig, generateControls } from './core/config-parser.js';
import {
    FORMATS, DEFAULT_FORMAT_ID,
    formatsForShader, defaultFormatForShader, getFormat,
} from './core/formats.js';

// ─── Inline pipeline shaders (not user-editable) ───────────────────────────
//
// Two passes downstream of the main shader:
//   MIX_FRAG  — blends raw source under main output via uBaseOpacity
//               (this is the transparency stage, runs even when no effect
//                so the effect later sees the *transparent* image, not the
//                raw main output)
//   COMP_FRAG — final to-screen pass, optionally blends the effect output
//               on top of the mix

const MIX_FRAG = `#version 300 es
precision highp float;

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uBase;
uniform float     uBaseOpacity;
uniform vec2      uSourceSize;
uniform vec2      uResolution;

vec2 coverUv(vec2 uv, vec2 src, vec2 canvas) {
    float srcAspect = src.x / src.y;
    float canAspect = canvas.x / canvas.y;
    if (srcAspect > canAspect) {
        float scale = canAspect / srcAspect;
        return vec2((uv.x - 0.5) * scale + 0.5, uv.y);
    } else {
        float scale = srcAspect / canAspect;
        return vec2(uv.x, (uv.y - 0.5) * scale + 0.5);
    }
}

void main() {
    vec3 src  = texture(uSource, coverUv(vUv, uSourceSize, uResolution)).rgb;
    vec3 base = texture(uBase,   vUv).rgb;
    fragColor = vec4(mix(src, base, uBaseOpacity), 1.0);
}`;

const COMP_FRAG = `#version 300 es
precision highp float;

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uMix;
uniform sampler2D uEffect;
uniform int       uEnableEffect;
uniform float     uEffectOpacity;

void main() {
    vec3 mixCol = texture(uMix, vUv).rgb;
    if (uEnableEffect == 1) {
        vec3 effect = texture(uEffect, vUv).rgb;
        fragColor = vec4(mix(mixCol, effect, uEffectOpacity), 1.0);
    } else {
        fragColor = vec4(mixCol, 1.0);
    }
}`;

// ─── Utility ─────────────────────────────────────────────────────────────────

async function fetchText(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Cannot load ${path} (HTTP ${r.status})`);
    return r.text();
}

async function fetchJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Cannot load ${path} (HTTP ${r.status})`);
    return r.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════════════════

async function boot() {

    // ── Manifests + vertex shader ────────────────────────────────────────────

    const [vertSrc, mainManifest, effectManifest] = await Promise.all([
        fetchText('vert.glsl'),
        fetchJSON('shaders/main/index.json'),
        fetchJSON('shaders/effects/index.json'),
    ]);

    // ── Canvas + WebGL ───────────────────────────────────────────────────────

    const canvas = document.getElementById('c');
    const gl     = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is not supported in this browser.');

    // ── Pipeline programs (constant) ─────────────────────────────────────────

    const progMix  = createProgram(gl, vertSrc, MIX_FRAG);
    const progComp = createProgram(gl, vertSrc, COMP_FRAG);

    // ── Quad buffer ──────────────────────────────────────────────────────────

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]),
        gl.STATIC_DRAW,
    );

    function drawQuad(prog) {
        const loc = gl.getAttribLocation(prog, 'aPos');
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── Canvas sizing + FBOs ─────────────────────────────────────────────────

    let W = 1080, H = 1080;
    let fboMain, fboMix, fboEffect;

    function rebuildFBOs() {
        canvas.width  = W;
        canvas.height = H;
        fboMain   = createFBO(gl, W, H);
        fboMix    = createFBO(gl, W, H);
        fboEffect = createFBO(gl, W, H);
        document.getElementById('meta-res').textContent = `${W} × ${H}`;
    }

    // ── Source texture (1×1 placeholder until an image/video is loaded) ──────

    const sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([30, 30, 30, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    let sourceElem       = null;
    let isVideo          = false;
    let sourceNativeSize = [1, 1];

    function uploadSource(elem) {
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, elem);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════

    const state = {
        // Shader slots
        mainId:     null,
        effectId:   null,

        // Parsed @config for each active slot
        mainConfig:   { uniforms: [] },
        effectConfig: { uniforms: [] },

        // Per-uniform values (keyed by uniform id)
        mainUniforms:   {},
        effectUniforms: {},

        // Compositor toggles
        baseOpacity:   1.0,
        effectOn:      false,
        effectOpacity: 0.7,

        // Palette
        paletteMax: 8,
        colors: [],

        // Loop state
        paused: false,
    };

    // Live programs (swapped when the user picks a different shader)
    let progMain   = null;
    let progEffect = null;

    // ═══════════════════════════════════════════════════════════════════════
    // Shader swap — main
    // ═══════════════════════════════════════════════════════════════════════

    async function loadMainShader(id) {
        const entry = mainManifest.find(s => s.id === id);
        if (!entry) throw new Error(`Main shader "${id}" not found in manifest.`);

        const errBox = document.getElementById('err-base');
        errBox.classList.add('hidden');

        let src;
        try {
            src = await fetchText(entry.file + '?t=' + Date.now());
        } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
            return;
        }

        const config = parseShaderConfig(src);
        let prog;
        try {
            prog = createProgram(gl, vertSrc, src);
        } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
            return;
        }

        // Clean up previous program
        if (progMain) gl.deleteProgram(progMain);
        progMain          = prog;
        state.mainId      = id;
        state.mainConfig  = config;

        // Rebuild the shader's controls + initial values
        const container = document.getElementById('main-controls');
        state.mainUniforms = generateControls(config, container, (uId, v) => {
            state.mainUniforms[uId] = v;
        });

        // Palette section visibility + defaults
        setupPalette(config.palette);

        // Transparency row visibility (some shaders disable it — e.g. GB
        // because it draws its own frame and source bleed-through is ugly)
        setupTransparency(!config.noTransparency);

        // Formats reachable for this shader + forced default
        rebuildFormatButtons(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Shader swap — effect
    // ═══════════════════════════════════════════════════════════════════════

    async function loadEffectShader(id) {
        const entry = effectManifest.find(s => s.id === id);
        if (!entry) throw new Error(`Effect shader "${id}" not found in manifest.`);

        const errBox = document.getElementById('err-effect');
        errBox.classList.add('hidden');

        let src;
        try {
            src = await fetchText(entry.file + '?t=' + Date.now());
        } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
            return;
        }

        const config = parseShaderConfig(src);
        let prog;
        try {
            prog = createProgram(gl, vertSrc, src);
        } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
            return;
        }

        if (progEffect) gl.deleteProgram(progEffect);
        progEffect          = prog;
        state.effectId      = id;
        state.effectConfig  = config;

        const container = document.getElementById('effect-controls');
        state.effectUniforms = generateControls(config, container, (uId, v) => {
            state.effectUniforms[uId] = v;
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Shader dropdowns
    // ═══════════════════════════════════════════════════════════════════════

    const selMain   = document.getElementById('sel-main-shader');
    const selEffect = document.getElementById('sel-effect-shader');

    mainManifest.forEach(s => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.label;
        selMain.appendChild(o);
    });
    effectManifest.forEach(s => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.label;
        selEffect.appendChild(o);
    });

    selMain.addEventListener('change',   () => loadMainShader(selMain.value));
    selEffect.addEventListener('change', () => loadEffectShader(selEffect.value));

    // ═══════════════════════════════════════════════════════════════════════
    // Format buttons
    // ═══════════════════════════════════════════════════════════════════════

    const formatGroup    = document.getElementById('format-group');
    const customResBlock = document.getElementById('custom-res-block');

    function rebuildFormatButtons(shaderId) {
        const formats = formatsForShader(shaderId);
        const forcedId = defaultFormatForShader(shaderId);

        formatGroup.innerHTML = '';
        formats.forEach(f => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ratio-btn';
            btn.dataset.id = f.id;
            btn.textContent = f.label;
            btn.addEventListener('click', () => {
                selectFormat(f.id);
                customResBlock.style.display = 'none';
            });
            formatGroup.appendChild(btn);
        });

        // Custom button only when no format is forced
        const isForced = FORMATS.find(f => f.id === forcedId)?.onlyFor?.includes(shaderId);
        if (!isForced) {
            const customBtn = document.createElement('button');
            customBtn.type = 'button';
            customBtn.className = 'ratio-btn';
            customBtn.id = 'btn-custom-res';
            customBtn.textContent = 'Custom';
            customBtn.addEventListener('click', () => {
                formatGroup.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
                customBtn.classList.add('active');
                customResBlock.style.display = 'block';
            });
            formatGroup.appendChild(customBtn);
        }

        selectFormat(forcedId);
    }

    function selectFormat(id) {
        const f = getFormat(id);
        if (!f) return;
        W = f.w;
        H = f.h;
        rebuildFBOs();

        formatGroup.querySelectorAll('.ratio-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.id === id);
        });
    }

    document.getElementById('btn-apply-res').addEventListener('click', () => {
        const w = parseInt(document.getElementById('inp-w').value);
        const h = parseInt(document.getElementById('inp-h').value);
        if (w >= 100 && h >= 100) {
            W = w;
            H = h;
            rebuildFBOs();
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Palette
    // ═══════════════════════════════════════════════════════════════════════

    const paletteSection  = document.getElementById('section-palette');
    const swatchContainer = document.getElementById('palette-swatches');

    function setupPalette(paletteCfg) {
        if (!paletteCfg) {
            paletteSection.classList.add('hidden');
            return;
        }
        paletteSection.classList.remove('hidden');
        state.paletteMax = paletteCfg.maxSize ?? 8;
        state.colors     = (paletteCfg.defaults ?? []).slice(0, state.paletteMax);
        if (state.colors.length === 0) state.colors = ['#ffffff'];
        renderSwatches();
    }

    function renderSwatches() {
        swatchContainer.innerHTML = '';
        state.colors.forEach((hex, i) => {
            const row = document.createElement('div');
            row.className = 'swatch-row';

            const picker = document.createElement('input');
            picker.type  = 'color';
            picker.value = hex;
            picker.className = 'swatch-picker';
            picker.addEventListener('input', () => { state.colors[i] = picker.value; });

            const label = document.createElement('span');
            label.className   = 'swatch-label';
            label.textContent = `Color ${i + 1}`;

            const removeBtn = document.createElement('button');
            removeBtn.className   = 'swatch-remove';
            removeBtn.textContent = '×';
            removeBtn.title       = 'Remove';
            removeBtn.addEventListener('click', () => {
                if (state.colors.length <= 1) return;
                state.colors.splice(i, 1);
                renderSwatches();
            });

            row.appendChild(picker);
            row.appendChild(label);
            row.appendChild(removeBtn);
            swatchContainer.appendChild(row);
        });
    }

    function getPaletteFlat() {
        const data = new Float32Array(8 * 3);
        state.colors.forEach((hex, i) => {
            const [r, g, b] = hexToRgb(hex);
            data[i * 3 + 0] = r;
            data[i * 3 + 1] = g;
            data[i * 3 + 2] = b;
        });
        return data;
    }

    document.getElementById('btn-add-color').addEventListener('click', () => {
        if (state.colors.length >= state.paletteMax) return;
        state.colors.push('#ffffff');
        renderSwatches();
    });

    // Palette randomizer (harmonic hues, largest-remainder rounding)

    function luminance(hex) {
        const [r, g, b] = hexToRgb(hex);
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }

    function hslToHex(h, s, l) {
        s /= 100;
        l /= 100;
        const a = s * Math.min(l, 1 - l);
        const f = n => {
            const k = (n + h / 30) % 12;
            return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
                .toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }

    const PERIOD_WEIGHTS = {
        1: [1],
        2: [0.60, 0.40],
        3: [0.60, 0.30, 0.10],
        4: [0.50, 0.25, 0.15, 0.10],
    };

    function maxPeriods(count) {
        if (count <= 4) return 2;
        if (count <= 7) return 3;
        return 4;
    }

    function buildHueAssignments(count, nbPeriod) {
        const weights = PERIOD_WEIGHTS[nbPeriod];
        const raw     = weights.map(w => w * count);
        const counts  = raw.map(Math.floor);

        let remainder = count - counts.reduce((a, b) => a + b, 0);
        raw.map((v, i) => ({ i, frac: v % 1 }))
            .sort((a, b) => b.frac - a.frac)
            .forEach(({ i }) => { if (remainder-- > 0) counts[i]++; });

        return counts.flatMap((c, i) => Array(c).fill(i));
    }

    function randomizePalette() {
        const count    = state.colors.length;
        const baseHue  = Math.random() * 360;
        const nbPeriod = Math.floor(Math.random() * maxPeriods(count)) + 1;
        const hues     = Array.from({ length: nbPeriod },
                            (_, i) => (baseHue + i * (360 / nbPeriod)) % 360);

        state.colors = buildHueAssignments(count, nbPeriod)
            .map(slot => {
                const h = (hues[slot] + (Math.random() - 0.5) * 30 + 360) % 360;
                const s = 40 + Math.random() * 50;
                const l = 10 + Math.random() * 65;
                return hslToHex(h, s, l);
            })
            .sort((a, b) => luminance(a) - luminance(b));

        renderSwatches();
    }

    document.getElementById('btn-randomize').addEventListener('click', randomizePalette);

    document.getElementById('btn-save-preset').addEventListener('click', () => {
        const data = JSON.stringify({ colors: state.colors }, null, 4);
        const blob = new Blob([data], { type: 'application/json' });
        const ts   = new Date().toISOString().slice(0, 10);
        const link = document.createElement('a');
        link.download = `palette_${ts}.json`;
        link.href     = URL.createObjectURL(blob);
        link.click();
    });

    document.getElementById('btn-load-preset').addEventListener('click', () => {
        document.getElementById('inp-preset').click();
    });

    document.getElementById('inp-preset').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const data = JSON.parse(ev.target.result);
                if (Array.isArray(data.colors) && data.colors.length > 0) {
                    state.colors = data.colors.slice(0, state.paletteMax);
                    renderSwatches();
                }
            } catch {
                alert('Invalid preset file.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Effect toggle + opacity
    // ═══════════════════════════════════════════════════════════════════════

    document.getElementById('tog-effect').addEventListener('change', e => {
        state.effectOn = e.target.checked;
        document.getElementById('section-effect').classList.toggle('disabled', !state.effectOn);
        document.getElementById('effect-body').classList.toggle('hidden', !state.effectOn);
        document.getElementById('btn-reload-effect').classList.toggle('hidden', !state.effectOn);
    });

    const effOpSlider = document.getElementById('sl-effect-op');
    const effOpVal    = document.getElementById('val-effect-op');
    effOpSlider.addEventListener('input', () => {
        state.effectOpacity = parseFloat(effOpSlider.value);
        effOpVal.textContent = Math.round(state.effectOpacity * 100) + '%';
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Transparency (shader-agnostic — blends the raw source through)
    // ═══════════════════════════════════════════════════════════════════════

    const trSlider = document.getElementById('sl-transparency');
    const trVal    = document.getElementById('val-transparency');
    const trRow    = trSlider.closest('.slider-row');
    trSlider.addEventListener('input', () => {
        const t = parseFloat(trSlider.value);
        state.baseOpacity    = 1.0 - t;
        trVal.textContent    = Math.round(t * 100) + '%';
    });

    function setupTransparency(enabled) {
        trRow.classList.toggle('hidden', !enabled);
        if (!enabled) {
            // Force-pin to fully opaque so the source never bleeds through
            trSlider.value      = 0;
            trVal.textContent   = '0%';
            state.baseOpacity   = 1.0;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Source — file + drag/drop
    // ═══════════════════════════════════════════════════════════════════════

    const overlay   = document.getElementById('drop-overlay');
    const fileInput = document.getElementById('file-input');
    const srcName   = document.getElementById('source-name');

    function loadFile(file) {
        stopCamera();
        srcName.textContent = file.name;

        if (file.type.startsWith('video/')) {
            if (sourceElem instanceof HTMLVideoElement) sourceElem.pause();
            const video       = document.createElement('video');
            video.src         = URL.createObjectURL(file);
            video.loop        = true;
            video.muted       = true;
            video.autoplay    = true;
            video.playsInline = true;
            video.oncanplay   = () => {
                video.play();
                sourceElem        = video;
                isVideo           = true;
                sourceNativeSize  = [video.videoWidth, video.videoHeight];
            };
        } else {
            const img = new Image();
            img.onload = () => {
                sourceElem       = img;
                isVideo          = false;
                uploadSource(img);
                sourceNativeSize = [img.naturalWidth, img.naturalHeight];
            };
            img.src = URL.createObjectURL(file);
        }

        overlay.classList.add('has-media');
    }

    overlay.addEventListener('click',     () => fileInput.click());
    overlay.addEventListener('dragover',  e  => { e.preventDefault(); overlay.classList.add('drag-over'); });
    overlay.addEventListener('dragleave', ()  => overlay.classList.remove('drag-over'));
    overlay.addEventListener('drop', e => {
        e.preventDefault();
        overlay.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', e => {
        if (e.target.files[0]) loadFile(e.target.files[0]);
        e.target.value = '';
    });
    document.getElementById('btn-change-source').addEventListener('click', () => fileInput.click());

    // ═══════════════════════════════════════════════════════════════════════
    // Source — live camera
    // ═══════════════════════════════════════════════════════════════════════

    let cameraStream = null;
    let cameraFacing = 'environment';
    let cameraVideo  = null;

    const camBtn   = document.getElementById('btn-camera');
    const swCamBtn = document.getElementById('btn-switch-camera');

    async function startCamera(facingMode = cameraFacing) {
        if (!navigator.mediaDevices?.getUserMedia) {
            alert('Camera not supported by this browser.');
            return;
        }
        stopCamera();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: facingMode },
                    width:      { ideal: 1920 },
                    height:     { ideal: 1080 },
                },
                audio: false,
            });

            cameraStream = stream;
            cameraFacing = facingMode;

            const video       = document.createElement('video');
            video.srcObject   = stream;
            video.muted       = true;
            video.autoplay    = true;
            video.playsInline = true;

            await new Promise(res => { video.onloadedmetadata = res; });
            await video.play();

            cameraVideo       = video;
            sourceElem        = video;
            isVideo           = true;
            sourceNativeSize  = [video.videoWidth, video.videoHeight];

            overlay.classList.add('has-media');
            srcName.textContent = `camera (${facingMode === 'user' ? 'front' : 'rear'})`;

            swCamBtn.classList.remove('hidden');
            camBtn.textContent = '◉ Stop camera';
            camBtn.classList.add('camera-active');
        } catch (e) {
            alert('Could not access camera: ' + (e.message || e.name));
        }
    }

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
            cameraStream = null;
        }
        if (cameraVideo) {
            cameraVideo.srcObject = null;
            cameraVideo = null;
        }
        swCamBtn.classList.add('hidden');
        camBtn.textContent = '◉ Camera';
        camBtn.classList.remove('camera-active');
    }

    camBtn.addEventListener('click', () => {
        if (cameraStream) {
            stopCamera();
            srcName.textContent = 'no file loaded';
            overlay.classList.remove('has-media');
        } else {
            startCamera();
        }
    });

    swCamBtn.addEventListener('click', () => {
        startCamera(cameraFacing === 'user' ? 'environment' : 'user');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Shader hot-reload (⟳ buttons)
    // ═══════════════════════════════════════════════════════════════════════

    document.getElementById('btn-reload-base').addEventListener('click', async () => {
        const btn = document.getElementById('btn-reload-base');
        btn.textContent = '…';
        try   { await loadMainShader(state.mainId); }
        finally { btn.textContent = '⟳'; }
    });

    document.getElementById('btn-reload-effect').addEventListener('click', async () => {
        const btn = document.getElementById('btn-reload-effect');
        btn.textContent = '…';
        try   { await loadEffectShader(state.effectId); }
        finally { btn.textContent = '⟳'; }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Render loop
    // ═══════════════════════════════════════════════════════════════════════

    let startTime   = Date.now();
    let frameCount  = 0;
    let lastFpsTime = Date.now();
    let rafId       = null;

    function bindFBO(fbo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo ? fbo.fbo : null);
        gl.viewport(0, 0, fbo ? fbo.w : W, fbo ? fbo.h : H);
    }

    function bindTex(unit, tex) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    // Common uniforms every shader can read without declaring them in @config
    function setCommonUniforms(prog, time) {
        setU2f(gl, prog, 'uResolution', W, H);
        setU2f(gl, prog, 'uSourceSize', sourceNativeSize[0], sourceNativeSize[1]);
        setU1f(gl, prog, 'uTime',   time);
        setU1f(gl, prog, 'uAspect', W / H);
    }

    function applyShaderUniforms(prog, config, values) {
        for (const u of config.uniforms ?? []) {
            const v = values[u.id];
            if (v === undefined) continue;
            applyUniform(gl, prog, u, v);
        }
    }

    function render() {
        const time = (Date.now() - startTime) / 1000;

        // Refresh video texture every frame
        if (isVideo && sourceElem?.readyState >= 2) {
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceElem);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.generateMipmap(gl.TEXTURE_2D);
        }

        // ── Pass 1: main shader → fboMain ────────────────────────────────────
        if (progMain) {
            bindFBO(fboMain);
            gl.useProgram(progMain);
            bindTex(0, sourceTex);
            setU1i(gl, progMain, 'uSource', 0);
            setCommonUniforms(progMain, time);
            applyShaderUniforms(progMain, state.mainConfig, state.mainUniforms);

            // Palette (only if declared)
            if (state.mainConfig.palette) {
                setU1i(gl, progMain, 'uColorCount', state.colors.length);
                const palLoc = gl.getUniformLocation(progMain, 'uColors');
                if (palLoc) gl.uniform3fv(palLoc, getPaletteFlat());
            }

            drawQuad(progMain);
        }

        // ── Pass 2: transparency mix (source ⨉ main) → fboMix ────────────────
        // Runs even when transparency is 0% — keeps the pipeline branch-free,
        // and means the effect shader downstream sees the *blended* image.
        bindFBO(fboMix);
        gl.useProgram(progMix);
        bindTex(0, sourceTex);
        bindTex(1, fboMain.tex);
        setU1i(gl, progMix, 'uSource',      0);
        setU1i(gl, progMix, 'uBase',        1);
        setU1f(gl, progMix, 'uBaseOpacity', state.baseOpacity);
        setU2f(gl, progMix, 'uSourceSize',  sourceNativeSize[0], sourceNativeSize[1]);
        setU2f(gl, progMix, 'uResolution',  W, H);
        drawQuad(progMix);

        // ── Pass 3: effect shader (reads fboMix, conditional) ────────────────
        if (state.effectOn && progEffect) {
            bindFBO(fboEffect);
            gl.useProgram(progEffect);
            bindTex(0, fboMix.tex);
            setU1i(gl, progEffect, 'uBase', 0);
            setCommonUniforms(progEffect, time);
            applyShaderUniforms(progEffect, state.effectConfig, state.effectUniforms);
            drawQuad(progEffect);
        }

        // ── Compositor → screen ──────────────────────────────────────────────
        bindFBO(null);
        gl.useProgram(progComp);
        bindTex(0, fboMix.tex);
        bindTex(1, fboEffect.tex);
        setU1i(gl, progComp, 'uMix',           0);
        setU1i(gl, progComp, 'uEffect',        1);
        setU1i(gl, progComp, 'uEnableEffect',  state.effectOn ? 1 : 0);
        setU1f(gl, progComp, 'uEffectOpacity', state.effectOpacity);
        drawQuad(progComp);

        // FPS counter
        frameCount++;
        const now = Date.now();
        if (now - lastFpsTime >= 1000) {
            document.getElementById('meta-fps').textContent =
                Math.round(frameCount * 1000 / (now - lastFpsTime)) + ' fps';
            frameCount  = 0;
            lastFpsTime = now;
        }
    }

    function startLoop() {
        if (rafId) return;
        const loop = () => { render(); rafId = requestAnimationFrame(loop); };
        rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden)       stopLoop();
        else if (!state.paused)    startLoop();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Pause / Play
    // ═══════════════════════════════════════════════════════════════════════

    const pauseBtn = document.getElementById('btn-pause-play');
    pauseBtn.addEventListener('click', () => {
        state.paused = !state.paused;
        if (state.paused) {
            stopLoop();
            pauseBtn.querySelector('.btn-label').textContent = 'Resume';
            pauseBtn.querySelector('.btn-icon').textContent  = '▶';
            pauseBtn.classList.add('paused');
        } else {
            startLoop();
            pauseBtn.querySelector('.btn-label').textContent = 'Pause';
            pauseBtn.querySelector('.btn-icon').textContent  = '⏸';
            pauseBtn.classList.remove('paused');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Export PNG
    // ═══════════════════════════════════════════════════════════════════════

    document.getElementById('btn-export-png').addEventListener('click', () => {
        render();
        const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const link = document.createElement('a');
        link.download = `web-tool_${ts}.png`;
        link.href     = canvas.toDataURL('image/png');
        link.click();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Record video (WebM → MP4 via ffmpeg.wasm, WebM fallback)
    // ═══════════════════════════════════════════════════════════════════════

    let recorder  = null;
    let recChunks = [];

    const recBtn = document.getElementById('btn-record');
    const recInd = document.getElementById('rec-indicator');

    recBtn.addEventListener('click', () => {
        if (recorder?.state === 'recording') {
            recorder.stop();
        } else {
            recChunks = [];
            const stream   = canvas.captureStream(60);
            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
                ? 'video/webm;codecs=vp9' : 'video/webm';

            recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 20_000_000,
            });

            recorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
            recorder.onstop = async () => {
                const blob = new Blob(recChunks, { type: 'video/webm' });
                const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

                recInd.classList.remove('hidden');
                recInd.querySelector('span:last-child').textContent = 'Converting to MP4…';
                recBtn.querySelector('.btn-label').textContent = 'Converting…';
                recBtn.disabled = true;

                try {
                    // ffmpeg.wasm 0.11 needs SharedArrayBuffer, which the
                    // browser only exposes when the page is cross-origin
                    // isolated (COOP: same-origin + COEP: require-corp headers).
                    // Catch this *before* trying to load — otherwise the error
                    // surfaces deep in ffmpeg-core and is hard to diagnose.
                    if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
                        throw new Error(
                            'SharedArrayBuffer unavailable — the server must send ' +
                            'COOP: same-origin and COEP: require-corp headers for MP4 export.'
                        );
                    }
                    if (typeof FFmpeg === 'undefined') {
                        throw new Error('FFmpeg global is missing — the ffmpeg.min.js script did not load.');
                    }

                    const { createFFmpeg, fetchFile } = FFmpeg;
                    // Pin corePath explicitly so we don't depend on the bundled
                    // auto-resolution (which sometimes races against COEP).
                    const ffmpeg = createFFmpeg({
                        log:      false,
                        corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
                    });
                    await ffmpeg.load();

                    ffmpeg.FS('writeFile', 'input.webm', await fetchFile(blob));
                    await ffmpeg.run(
                        '-i', 'input.webm',
                        '-c:v', 'libx264',
                        '-preset', 'ultrafast',
                        '-crf', '18',
                        '-pix_fmt', 'yuv420p',
                        'output.mp4',
                    );
                    const data    = ffmpeg.FS('readFile', 'output.mp4');
                    const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });

                    const link    = document.createElement('a');
                    link.download = `web-tool_${ts}.mp4`;
                    link.href     = URL.createObjectURL(mp4Blob);
                    link.click();
                } catch (err) {
                    console.error('MP4 conversion failed, falling back to WebM:', err);
                    // Surface the failure in the UI so it doesn't silently
                    // fall back without explanation.
                    srcName.textContent = 'MP4 export failed: ' + (err.message || err);
                    const link    = document.createElement('a');
                    link.download = `web-tool_${ts}.webm`;
                    link.href     = URL.createObjectURL(blob);
                    link.click();
                }

                recInd.classList.add('hidden');
                recInd.querySelector('span:last-child').textContent = 'Recording…';
                recBtn.querySelector('.btn-label').textContent = 'Record video';
                recBtn.querySelector('.btn-icon').textContent  = '⏺';
                recBtn.disabled = false;
            };

            recorder.start();
            recInd.classList.remove('hidden');
            recBtn.querySelector('.btn-label').textContent = 'Stop recording';
            recBtn.querySelector('.btn-icon').textContent  = '⏹';
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Initial load
    // ═══════════════════════════════════════════════════════════════════════

    // Main shader first (sets format + palette), then pre-load the default
    // effect program so the toggle fires instantly later on.
    selMain.value = mainManifest[0].id;
    await loadMainShader(selMain.value);

    if (effectManifest.length > 0) {
        selEffect.value = effectManifest[0].id;
        await loadEffectShader(selEffect.value);
    }

    startLoop();
}

// ─── Boot with friendly error message ───────────────────────────────────────

boot().catch(err => {
    document.body.innerHTML = `
        <div style="
            color: #c05858;
            padding: 48px;
            font-family: 'DM Mono', monospace;
            font-size: 13px;
            line-height: 1.7;
            background: #080808;
            height: 100dvh;
        ">
            <b>Startup error:</b><br>
            ${err.message}<br><br>
            Run via a local server:<br>
            <code style="color:#9baa1f">python3 server.py</code>
        </div>`;
    console.error(err);
});
