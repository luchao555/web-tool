#version 300 es
precision highp float;

/*
@config
{
    "name": "Game Boy",
    "uniforms": [
        { "id": "uLodBias", "label": "Lod Bias", "type": "float", "control": "slider",
          "min": -1.0, "max": 1.0, "default": 0.0 },
        { "id": "uShadowX", "label": "ShadowX",  "type": "float", "control": "slider",
          "min": -20.0, "max": 20.0, "default": 10.0 },
        { "id": "uShadowY", "label": "ShadowY",  "type": "float", "control": "slider",
          "min": -20.0, "max": 20.0, "default": -8.0 }
    ]
}
*/

in  vec2 vUv;
out vec4 fragColor;

uniform float     uTime;
uniform vec2      uResolution;
uniform float     uAspect;
uniform sampler2D uSource;
uniform float     uLodBias;
uniform float     uShadowX;
uniform float     uShadowY;

// Placeholder uniforms (currently unused by main(); kept for future tweaks)
uniform float uParam1;
uniform float uSpeed;
uniform vec3  uAccent;

#define PI 3.14159265359

// Authentic GB screen palette (dark → light)
const vec3 darkest = vec3(0.180, 0.357, 0.043);
const vec3 dark    = vec3(0.192, 0.325, 0.008);
const vec3 medium  = vec3(0.329, 0.416, 0.024);
const vec3 light   = vec3(0.557, 0.604, 0.031);
const vec3 yellow  = vec3(0.604, 0.647, 0.004);

const float dark_thresh  = 0.25;
const float mid_thresh   = 0.5;
const float light_thresh = 0.75;

// ─── Noise ──────────────────────────────────────────────────────────────────

float random(in vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

// Based on Morgan McGuire @morgan3d — https://www.shadertoy.com/view/4dS3Wd
float noise(in vec2 st) {
    vec2 i = floor(st);
    vec2 f = fract(st);

    float a = random(i);
    float b = random(i + vec2(1.0, 0.0));
    float c = random(i + vec2(0.0, 1.0));
    float d = random(i + vec2(1.0, 1.0));

    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x)
         + (c - a) * u.y * (1.0 - u.x)
         + (d - b) * u.x * u.y;
}

// ─── Simplex noise (Stefan Gustavson / Ian McEwan) ──────────────────────────

vec4 taylorInvSqrt(in vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

vec3 mod289(const in vec3 x) { return x - floor(x * (1. / 289.)) * 289.; }
vec4 mod289(const in vec4 x) { return x - floor(x * (1. / 289.)) * 289.; }

vec4 permute(const in vec4 v) { return mod289(((v * 34.0) + 1.0) * v); }

float snoise(in vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ─── Utils ──────────────────────────────────────────────────────────────────

float luminance(vec3 c) {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

vec3 unmultiply(vec4 texel) {
    return texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0);
}

vec4 premultiply(vec3 color, float alpha) {
    return vec4(color * alpha, alpha);
}

float bayer_4x4(vec2 pos) {
    const mat4 bayer = mat4(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
    ) / 16.0 - 0.5;

    ivec2 idx = ivec2(mod(pos, 4.0));
    return bayer[idx.y][idx.x];
}

float squareSdf(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// ─── Main ───────────────────────────────────────────────────────────────────

void main() {
    vec2 uv = vUv;
    vec2 grid = vec2(160.0, 144.0);

    vec2  shadow_shift    = vec2(uShadowX, uShadowY);
    float dither_strength = 0.15;

    // 1200×1080 canvas with a 40×36 border → 1120×1008 inner screen
    vec2 px       = floor(vUv * uResolution);
    float borderX = 40.0;
    float borderY = 36.0;
    vec2 innerSize = vec2(1120.0, 1008.0);

    vec2 innerPx  = px - vec2(borderX, borderY);
    vec2 shadowPx = innerPx - shadow_shift;

    bool inZone = innerPx.x >= 0.0 && innerPx.x < innerSize.x
               && innerPx.y >= 0.0 && innerPx.y < innerSize.y;

    bool shadowInZone = shadowPx.x >= 0.0 && shadowPx.x < innerSize.x
                     && shadowPx.y >= 0.0 && shadowPx.y < innerSize.y;

    vec4 src = vec4(1.0);

    float lod_x = log2(uResolution.x / grid.x);
    float lod_y = log2(uResolution.y / grid.y);
    float lod   = max(lod_x, lod_y) + uLodBias;

    // Background (outer frame)
    vec3 color = yellow;

    // Background grid of cells
    if (inZone) {
        vec2 uv_inner = innerPx / innerSize;
        vec2 st_f = fract(uv_inner * grid);
        vec2 p = st_f - vec2(0.5);
        p.x *= (uResolution.x / grid.x) / (uResolution.y / grid.y);

        float half_size = 0.43;
        float pixel = smoothstep(-0.003, 0.01, squareSdf(p, vec2(half_size)));
        color = mix(light, color, pixel);
    }

    // Shadow layer under the image
    if (shadowInZone) {
        vec2 shadowUV       = shadowPx / innerSize;
        vec2 shadow_snapped = (floor(shadowUV * grid) + 0.5) / grid;
        vec2 shadow_f       = fract(shadowUV * grid);
        float half_size_shad = 0.6;

        vec4  shadowSrc = textureLod(uSource, shadow_snapped, lod);
        float shadowLum = luminance(unmultiply(shadowSrc));

        vec2  cell_pos = floor(shadowUV * grid);
        float dither   = bayer_4x4(cell_pos) * dither_strength;
        shadowLum = shadowLum + dither;

        float shadowStrength = 0.0;
        if (shadowLum < dark_thresh) {
            shadowStrength = 0.5;
        } else if (shadowLum < mid_thresh) {
            shadowStrength = 0.45;
        } else if (shadowLum < light_thresh) {
            shadowStrength = 0.4;
        } else {
            shadowStrength = 0.0;
        }

        vec2  sp = shadow_f - 0.5;
        float shadowMask = 1.0 - step(0.0, squareSdf(sp, vec2(half_size_shad)));

        color = mix(color, vec3(0.0), shadowMask * shadowStrength * 0.4);
    }

    // Image pixels
    if (inZone) {
        vec2 uv_inner   = innerPx / innerSize;
        vec2 st_snapped = (floor(uv_inner * grid) + 0.5) / grid;
        vec2 st_f       = fract(uv_inner * grid);

        src = textureLod(uSource, st_snapped, lod);
        vec3 img = unmultiply(src);

        vec2 p = st_f - vec2(0.5);
        p.x *= (uResolution.x / grid.x) / (uResolution.y / grid.y);

        float half_size = 0.43;
        float pixel     = smoothstep(-0.003, 0.01, squareSdf(p, vec2(half_size)));

        // Subtle organic border noise to avoid perfectly square cells
        float n = noise(uv * 250.0) / 500.0;
        pixel = smoothstep(-0.007, 0.007 + n, squareSdf(p, vec2(half_size)));

        vec2  cell_pos = floor(uv_inner * grid);
        float dither   = bayer_4x4(cell_pos) * dither_strength;
        float lum      = luminance(img) + dither;

        if (lum < dark_thresh) {
            color = mix(darkest, color, pixel);
        } else if (lum < mid_thresh) {
            color = mix(dark, color, pixel);
        } else if (lum < light_thresh) {
            color = mix(medium, color, pixel);
        }
    }

    // Screen grain
    color += snoise(vec3(uv * grid * 100.0, 1.0)) / 25.0;

    fragColor = premultiply(color, src.a);
}
