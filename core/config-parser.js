// ═══════════════════════════════════════════════════════════════════════════
// Parses the @config JSON block embedded in a GLSL comment and generates
// DOM controls matching the app's visual language.
//
// Config block format (anywhere in the shader source):
//
//   / *
//   @config
//   {
//     "name": "Shader Display Name",
//     "palette": {                       // optional: shows palette section
//       "defaultSize": 4,                // initial swatch count (1..maxSize)
//       "maxSize": 8,                    // cap
//       "defaults": ["#...", "#...", …]  // initial colors (length == defaultSize)
//     },
//     "uniforms": [
//       { "id": "uSpeed", "label": "Speed", "type": "float",
//         "control": "slider", "min": 0.0, "max": 2.0, "default": 1.0 },
//       …
//     ]
//   }
//   * /
//
// Uniform descriptor fields:
//   id       — uniform name in GLSL (required)
//   label    — UI label (defaults to id)
//   type     — float | int | bool | color | vec2
//   control  — slider | toggle | color | select (inferred from type if omitted)
//   min/max  — numeric range
//   default  — initial value
//   labels   — string[] for select controls
// ═══════════════════════════════════════════════════════════════════════════

export function parseShaderConfig(glsl) {
    const m = glsl.match(/\/\*[\s\S]*?@config\s*([\s\S]*?)\*\//);
    if (!m) return { name: null, uniforms: [] };
    try {
        const cfg = JSON.parse(m[1].trim());
        if (!Array.isArray(cfg.uniforms)) cfg.uniforms = [];
        return cfg;
    } catch (e) {
        console.warn('[config-parser] Failed to parse @config:', e.message);
        return { name: null, uniforms: [] };
    }
}

// Build controls into `container` from a parsed config.
// `onChange(id, value)` is called every time a control is moved.
// Returns { [id]: initialValue } so callers can seed uniform state.
export function generateControls(config, container, onChange) {
    container.innerHTML = '';

    if (!config?.uniforms?.length) {
        container.innerHTML =
            '<p class="hint">No controls exposed by this shader.</p>';
        return {};
    }

    const initial = {};
    for (const u of config.uniforms) {
        const row = buildRow(u, onChange);
        if (row) {
            container.appendChild(row.el);
            initial[u.id] = row.initialValue;
        }
    }
    return initial;
}

// ─── Row builder (dispatches to the appropriate control) ────────────────────

function buildRow(u, onChange) {
    const control = u.control ?? inferControl(u.type, u);
    switch (control) {
        case 'slider': return buildSliderRow(u, onChange);
        case 'toggle': return buildToggleRow(u, onChange);
        case 'color':  return buildColorRow(u, onChange);
        case 'select': return buildSelectRow(u, onChange);
        default:       return buildSliderRow(u, onChange);
    }
}

function inferControl(type, u) {
    if (u.labels) return 'select';
    switch (type) {
        case 'float': return 'slider';
        case 'int':   return 'slider';
        case 'bool':  return 'toggle';
        case 'color': return 'color';
        default:      return 'slider';
    }
}

// ─── Slider ──────────────────────────────────────────────────────────────────

function buildSliderRow(u, onChange) {
    const row   = mkRow(u.label ?? u.id);
    const range = document.createElement('input');
    const val   = document.createElement('span');

    const min = u.min ?? 0;
    const max = u.max ?? 1;
    const def = u.default ?? (min + max) / 2;

    range.type  = 'range';
    range.min   = min;
    range.max   = max;
    range.step  = u.type === 'int' ? 1 : (max - min) / 200;
    range.value = def;

    val.className   = 'slider-val';
    val.textContent = formatVal(def, u);

    range.addEventListener('input', () => {
        const v = u.type === 'int' ? parseInt(range.value) : parseFloat(range.value);
        val.textContent = formatVal(v, u);
        onChange(u.id, v);
    });

    row.appendChild(range);
    row.appendChild(val);
    return { el: row, initialValue: u.type === 'int' ? Math.round(def) : def };
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

function buildToggleRow(u, onChange) {
    const row  = mkRow(u.label ?? u.id);
    const tog  = document.createElement('label');
    tog.className = 'toggle';
    const input = document.createElement('input');
    input.type  = 'checkbox';
    input.checked = !!u.default;
    const track = document.createElement('div');
    track.className = 'toggle-track';
    const thumb = document.createElement('div');
    thumb.className = 'toggle-thumb';
    tog.appendChild(input);
    tog.appendChild(track);
    tog.appendChild(thumb);

    input.addEventListener('change', () => onChange(u.id, input.checked));

    // Push toggle to the far right to keep rows aligned
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row.appendChild(spacer);
    row.appendChild(tog);

    return { el: row, initialValue: !!u.default };
}

// ─── Color picker ────────────────────────────────────────────────────────────

function buildColorRow(u, onChange) {
    const row   = mkRow(u.label ?? u.id);
    const input = document.createElement('input');
    input.type  = 'color';
    input.className = 'swatch-picker';
    input.value = u.default ?? '#ffffff';

    input.addEventListener('input', () => onChange(u.id, input.value));

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    row.appendChild(spacer);
    row.appendChild(input);

    return { el: row, initialValue: input.value };
}

// ─── Select (rendered as a segmented button group) ──────────────────────────

function buildSelectRow(u, onChange) {
    const row = document.createElement('div');
    row.className = 'slider-row config-select-row';

    const label = document.createElement('label');
    label.textContent = u.label ?? u.id;
    row.appendChild(label);

    const group = document.createElement('div');
    group.className = 'btn-group config-select-group';

    const min    = u.min ?? 0;
    const labels = u.labels ?? Array.from(
        { length: (u.max ?? 1) - min + 1 },
        (_, i) => String(i + min)
    );
    const def = u.default ?? min;

    labels.forEach((lbl, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ratio-btn';
        btn.textContent = lbl;
        const value = i + min;
        if (value === def) btn.classList.add('active');
        btn.addEventListener('click', () => {
            group.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            onChange(u.id, value);
        });
        group.appendChild(btn);
    });

    row.appendChild(group);
    return { el: row, initialValue: def };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkRow(labelText) {
    const row   = document.createElement('div');
    row.className = 'slider-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.appendChild(label);
    return row;
}

function formatVal(v, u) {
    if (u.type === 'int') return String(Math.round(v));
    const range = (u.max ?? 1) - (u.min ?? 0);
    if (range <= 2)   return v.toFixed(2);
    if (range <= 20)  return v.toFixed(1);
    return String(Math.round(v));
}
