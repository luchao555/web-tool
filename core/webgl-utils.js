// ═══════════════════════════════════════════════════════════════════════════
// Minimal WebGL2 helpers shared by the compositor.
// Throws on compile/link failure so callers can report errors cleanly.
// ═══════════════════════════════════════════════════════════════════════════

export function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(log);
    }
    return sh;
}

export function createProgram(gl, vertSrc, fragSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER,   vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
}

export function createFBO(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
}

// ─── Uniform setters ─────────────────────────────────────────────────────────
// All setters are no-ops if the uniform location is not found,
// so unused uniforms (e.g. placeholders declared by the shader but not in
// the @config block) don't cause errors.

export function setU1i (gl, p, n, v)        { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform1i(l, v); }
export function setU1f (gl, p, n, v)        { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform1f(l, v); }
export function setU2f (gl, p, n, x, y)     { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform2f(l, x, y); }
export function setU3f (gl, p, n, x, y, z)  { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform3f(l, x, y, z); }
export function setU1fv(gl, p, n, arr)      { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform1fv(l, arr); }
export function setU3fv(gl, p, n, arr)      { const l = gl.getUniformLocation(p, n); if (l !== null) gl.uniform3fv(l, arr); }

// Convert "#rrggbb" to [r, g, b] in 0..1
export function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
    ];
}

// Apply a uniform value to a program, dispatching by @config descriptor type
export function applyUniform(gl, prog, u, value) {
    switch (u.type) {
        case 'float':
            setU1f(gl, prog, u.id, value);
            break;
        case 'int':
        case 'bool':
            setU1i(gl, prog, u.id, u.type === 'bool' ? (value ? 1 : 0) : value);
            break;
        case 'color': {
            const [r, g, b] = hexToRgb(value);
            setU3f(gl, prog, u.id, r, g, b);
            break;
        }
        case 'vec2':
            setU2f(gl, prog, u.id, value[0] ?? 0, value[1] ?? 0);
            break;
        default:
            setU1f(gl, prog, u.id, parseFloat(value) || 0);
    }
}
