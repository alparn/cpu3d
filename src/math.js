// Minimal vector / matrix helpers. Matrices are column-major Float64Array(16), same layout as WebGL.

export const vec3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

const TMP = new Float64Array(16);

export const mat4 = {
  create() {
    const o = new Float64Array(16);
    o[0] = o[5] = o[10] = o[15] = 1;
    return o;
  },

  // o = a * b (o may alias a or b)
  multiply(o, a, b) {
    const t = TMP;
    for (let c = 0; c < 16; c += 4) {
      const b0 = b[c], b1 = b[c + 1], b2 = b[c + 2], b3 = b[c + 3];
      t[c] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      t[c + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      t[c + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      t[c + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    o.set(t);
    return o;
  },

  // OpenGL-style projection: clip z in [-w, w]
  perspective(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = (far + near) * nf;
    o[11] = -1;
    o[14] = 2 * far * near * nf;
    return o;
  },

  lookAt(o, eye, target, up) {
    const z = vec3.normalize(vec3.sub(eye, target));
    const x = vec3.normalize(vec3.cross(up, z));
    const y = vec3.cross(z, x);
    o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
    o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
    o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
    o[12] = -vec3.dot(x, eye); o[13] = -vec3.dot(y, eye); o[14] = -vec3.dot(z, eye); o[15] = 1;
    return o;
  },

  // T * Rz * Ry * Rx * S  (Euler angles in radians, X applied first)
  compose(o, p, r, s) {
    const cx = Math.cos(r[0]), sx = Math.sin(r[0]);
    const cy = Math.cos(r[1]), sy = Math.sin(r[1]);
    const cz = Math.cos(r[2]), sz = Math.sin(r[2]);
    o[0] = cz * cy * s[0]; o[1] = sz * cy * s[0]; o[2] = -sy * s[0]; o[3] = 0;
    o[4] = (cz * sy * sx - sz * cx) * s[1]; o[5] = (sz * sy * sx + cz * cx) * s[1]; o[6] = cy * sx * s[1]; o[7] = 0;
    o[8] = (cz * sy * cx + sz * sx) * s[2]; o[9] = (sz * sy * cx - cz * sx) * s[2]; o[10] = cy * cx * s[2]; o[11] = 0;
    o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; o[15] = 1;
    return o;
  },

  // Inverse-transpose of the upper 3x3, written row-major into o (length 9).
  normalMatrix(o, m) {
    const a00 = m[0], a01 = m[4], a02 = m[8];
    const a10 = m[1], a11 = m[5], a12 = m[9];
    const a20 = m[2], a21 = m[6], a22 = m[10];
    const c00 = a11 * a22 - a12 * a21, c01 = a12 * a20 - a10 * a22, c02 = a10 * a21 - a11 * a20;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    const id = det ? 1 / det : 0;
    o[0] = c00 * id; o[1] = c01 * id; o[2] = c02 * id;
    o[3] = (a02 * a21 - a01 * a22) * id; o[4] = (a00 * a22 - a02 * a20) * id; o[5] = (a01 * a20 - a00 * a21) * id;
    o[6] = (a01 * a12 - a02 * a11) * id; o[7] = (a02 * a10 - a00 * a12) * id; o[8] = (a00 * a11 - a01 * a10) * id;
    return o;
  },

  // rotation by `rad` around a (not necessarily normalized) axis through the origin
  axisAngle(o, axis, rad) {
    const l = Math.hypot(axis[0], axis[1], axis[2]) || 1, x = axis[0] / l, y = axis[1] / l, z = axis[2] / l;
    const c = Math.cos(rad), s = Math.sin(rad), t = 1 - c;
    o.fill(0);
    o[0] = t * x * x + c; o[1] = t * x * y + s * z; o[2] = t * x * z - s * y;
    o[4] = t * x * y - s * z; o[5] = t * y * y + c; o[6] = t * y * z + s * x;
    o[8] = t * x * z + s * y; o[9] = t * y * z - s * x; o[10] = t * z * z + c;
    o[15] = 1;
    return o;
  },

  translation(o, v) {
    o.fill(0);
    o[0] = o[5] = o[10] = o[15] = 1;
    o[12] = v[0]; o[13] = v[1]; o[14] = v[2];
    return o;
  },

  determinant3(m) {
    return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  },
};
