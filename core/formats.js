// ═══════════════════════════════════════════════════════════════════════════
// Canvas format presets.
//
// `onlyFor` restricts a format to specific main-shader ids.
// A shader listed in `onlyFor` is also forced to use that format.
//
// To add a format: append an object here.
// To gate it to certain shaders: add `onlyFor: ['shader-id', ...]`.
// ═══════════════════════════════════════════════════════════════════════════

export const FORMATS = [
    { id: 'gb',   w: 1200, h: 1080, label: 'GB',   onlyFor: ['gb'] },
    { id: '1_1',  w: 1080, h: 1080, label: '1:1'  },
    { id: '16_9', w: 1920, h: 1080, label: '16:9' },
    { id: '4_3',  w: 1440, h: 1080, label: '4:3'  },
    { id: '9_16', w: 1080, h: 1920, label: '9:16' },
    { id: '4_5',  w: 1080, h: 1350, label: '4:5'  },
];

export const DEFAULT_FORMAT_ID = '1_1';

// Returns the formats selectable for a given main shader.
// If the shader has a forced format (any entry listing it in `onlyFor`),
// only that single format is returned — it takes over the whole panel.
export function formatsForShader(shaderId) {
    const forced = FORMATS.find(f => f.onlyFor?.includes(shaderId));
    if (forced) return [forced];
    return FORMATS.filter(f => !f.onlyFor);
}

// If a shader has a forced format, returns it; otherwise returns default
export function defaultFormatForShader(shaderId) {
    const forced = FORMATS.find(f => f.onlyFor?.includes(shaderId));
    return forced ? forced.id : DEFAULT_FORMAT_ID;
}

export function getFormat(id) {
    return FORMATS.find(f => f.id === id);
}
