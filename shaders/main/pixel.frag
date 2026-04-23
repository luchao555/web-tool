#version 300 es
precision highp float;

/*
@config
{
    "name": "Pixel",
    "palette": {
        "defaultSize": 4,
        "maxSize": 8,
        "defaults": ["#0f2408", "#314d0f", "#547b15", "#9baa1f"]
    },
    "uniforms": [
        { "id": "uPixelSize", "label": "PixelSize", "type": "int",
          "control": "slider", "min": 4, "max": 40, "default": 7 },
        { "id": "uDither",    "label": "Dither",    "type": "float",
          "control": "slider", "min": 0.0, "max": 0.5, "default": 0.15 }
    ]
}
*/

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2      uSourceSize;
uniform vec2      uResolution;

uniform int       uPixelSize;
uniform float     uDither;

// Palette (provided globally when the shader declares @config.palette)
uniform vec3      uColors[8];
uniform int       uColorCount;

// ─── Bayer 4×4 ordered dithering ────────────────────────────────────────────
float bayer4x4(vec2 pos) {
    const mat4 m = mat4(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
    );
    ivec2 idx = ivec2(mod(pos, 4.0));
    return m[idx.y][idx.x] / 16.0 - 0.5;
}

float luminance(vec3 c) {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

vec3 unmultiply(vec4 texel) {
    return texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0);
}

vec4 premultiply(vec3 color, float alpha) {
    return vec4(color * alpha, alpha);
}

// Cover-fit UV mapping (preserve source aspect, crop overflow)
vec2 coverUV(vec2 uv, vec2 canvasSize, vec2 sourceSize) {
    float canvasAspect = canvasSize.x / canvasSize.y;
    float sourceAspect = sourceSize.x / sourceSize.y;

    vec2 scale;
    if (sourceAspect > canvasAspect) {
        scale = vec2(canvasAspect / sourceAspect, 1.0);
    } else {
        scale = vec2(1.0, sourceAspect / canvasAspect);
    }
    return (uv - 0.5) * scale + 0.5;
}

void main() {
    float pixelSize = float(uPixelSize);

    // Cell grid fills the canvas. Cells may straddle fractional canvas pixels,
    // but since we don't draw cell boundaries this is invisible.
    vec2 grid = floor(uResolution / pixelSize);

    // Snap UV to the center of the cell
    vec2 snapped = (floor(vUv * grid) + 0.5) / grid;

    // LOD keeps the source free of aliasing when downsampled to grid resolution
    float canvasAspect = uResolution.x / uResolution.y;
    float sourceAspect = uSourceSize.x  / uSourceSize.y;
    float scaleX = (sourceAspect > canvasAspect) ? (canvasAspect / sourceAspect) : 1.0;
    float scaleY = (sourceAspect > canvasAspect) ? 1.0 : (sourceAspect / canvasAspect);
    float lodX   = log2((uResolution.x / grid.x) * scaleX);
    float lodY   = log2((uResolution.y / grid.y) * scaleY);
    float lod    = max(lodX, lodY);

    vec2 sampledUV = coverUV(snapped, uResolution, uSourceSize);
    vec4 src       = textureLod(uSource, sampledUV, lod);
    vec3 img       = unmultiply(src);

    // Dither + quantize to palette
    vec2  cellPos = floor(vUv * grid);
    float dither  = bayer4x4(cellPos) * uDither;
    float lum     = clamp(luminance(img) + dither, 0.0, 0.999);
    int   idx     = int(floor(lum * float(uColorCount)));

    fragColor = premultiply(uColors[idx], src.a);
}
