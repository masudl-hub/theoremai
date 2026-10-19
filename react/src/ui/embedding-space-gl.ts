/**
 * Draws the embedding space with WebGL2 and nothing else: colonies, threads
 * and spores as soft instanced quads, light that adds where they overlap,
 * a glow from two blur passes, and the whole laid over the card with
 * premultiplied alpha so the card shows through. No React here: the
 * component owns one renderer and feeds it.
 *
 * @module
 */

import type { EmbeddingSpace, SpacePoint } from '../client/embedding-space.ts';
import {
  QUERY_COLONY,
  type QueryMatch,
  queryGeometry,
  SEGMENT_FLOATS,
  SPORE_FLOATS,
  type SpaceGeometry,
  spaceGeometry,
} from '../client/space-geometry.ts';

/** What the space highlights: a query's matches, and the document under the pointer. */
export type SpaceFocus = {
  query: SpacePoint | null;
  matches: readonly QueryMatch[];
  hovered: number | null;
};

export type SpaceRenderer = {
  /** Shows a new index: its colonies grow in from nothing. */
  setSpace(space: EmbeddingSpace): void;
  setFocus(focus: SpaceFocus): void;
  /** The colony nearest a point in CSS pixels from the canvas's corner, if one is close and facing. */
  pick(x: number, y: number): number | null;
  /** Turns the sphere as a drag moves, in CSS pixels. */
  drag(dx: number, dy: number): void;
  release(): void;
};

/** Colony states per texture row. */
const STATE_ROW = 1024;
/** Field of view, in radians. */
const FOV = (30 * Math.PI) / 180;
/** The camera's distance from the sphere's centre: far enough that fronds and lifted threads fit. */
const DISTANCE = 5.1;
/** Seconds a colony takes to grow, and the most one waits to start. */
const GROW_S = 1.1;
const GROW_STAGGER_S = 0.6;
/** Seconds a query's threads take to reach its matches. */
const REVEAL_S = 0.9;
/** Seconds the sphere takes to turn a query to face the viewer. */
const TURN_S = 1.2;
/** Radians per second the sphere turns on its own. */
const SPIN = 0.05;
/** How far, in CSS pixels, the pointer reaches for a colony. */
const PICK_PX = 22;
/** How bright a document reads when a query leaves it out. */
const DIMMED = 0.22;

const PREAMBLE = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

const STATE_GLSL = `
uniform sampler2D states;
vec4 stateOf(float i) {
  if (i < -0.5) return vec4(1.0, 1.0, 0.0, 0.0);
  int k = int(i + 0.5);
  return texelFetch(states, ivec2(k % ${STATE_ROW}, k / ${STATE_ROW}), 0);
}
float facingFade(vec3 p) {
  float facing = p.z / max(length(p), 1e-4);
  return mix(0.16, 1.0, smoothstep(-0.55, 0.45, facing));
}
`;

const SEGMENT_VERTEX = `${PREAMBLE}
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 from;
layout(location = 2) in vec3 to;
layout(location = 3) in vec3 colour;
layout(location = 4) in float alpha;
layout(location = 5) in float width;
layout(location = 6) in vec2 colonies;
layout(location = 7) in float along;
uniform mat4 projection;
uniform mat3 turn;
uniform vec2 viewport;
uniform float pxScale;
uniform float reveal;
${STATE_GLSL}
out vec3 vColour;
out float vAlpha;
out float vSide;
void main() {
  vec4 sa = stateOf(colonies.x);
  vec4 sb = stateOf(colonies.y);
  float grow = min(sa.g, sb.g);
  float bright = 0.5 * (sa.r + sb.r);
  float hover = max(sa.b, sb.b);
  float shown = step(along, grow + 1e-4) * step(along, reveal + 1e-4);
  float head = reveal < 1.5 ? exp(-pow((along - reveal) * 9.0, 2.0)) : 0.0;
  vec3 pa = turn * from;
  vec3 pb = turn * to;
  vec4 ca = projection * vec4(pa, 1.0);
  vec4 cb = projection * vec4(pb, 1.0);
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * viewport;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 c = corner.x < 0.5 ? ca : cb;
  float w = max(width * pxScale * (0.85 + 0.25 * bright + 0.6 * hover), 1.2);
  c.xy += normal * corner.y * w / viewport * c.w;
  gl_Position = c;
  vSide = corner.y;
  vColour = colour * (1.0 + 0.5 * hover) + vec3(0.8) * head;
  vAlpha = alpha * shown * bright * facingFade(corner.x < 0.5 ? pa : pb) * (1.0 + 1.5 * head);
}`;

const SEGMENT_FRAGMENT = `${PREAMBLE}
in vec3 vColour;
in float vAlpha;
in float vSide;
out vec4 outColour;
void main() {
  float a = vAlpha * (1.0 - smoothstep(0.3, 1.0, abs(vSide)));
  outColour = vec4(vColour * a, a);
}`;

const SPORE_VERTEX = `${PREAMBLE}
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 position;
layout(location = 2) in vec3 colour;
layout(location = 3) in float alpha;
layout(location = 4) in float size;
layout(location = 5) in float colony;
layout(location = 6) in float along;
uniform mat4 projection;
uniform mat3 turn;
uniform vec2 viewport;
uniform float pxScale;
uniform float reveal;
${STATE_GLSL}
out vec3 vColour;
out float vAlpha;
out vec2 vAt;
void main() {
  vec4 s = stateOf(colony);
  float grown = along < 0.01 ? smoothstep(0.0, 0.35, s.g) : step(along, s.g + 1e-4);
  float shown = grown * step(along, reveal + 1e-4);
  vec3 p = turn * position;
  vec4 c = projection * vec4(p, 1.0);
  float px = size * pxScale * (0.8 + 0.25 * s.r + 0.5 * s.b) * (along < 0.01 ? max(s.g, 0.05) : 1.0);
  c.xy += corner * px / viewport * c.w;
  gl_Position = c;
  vAt = corner;
  vColour = colour * (1.0 + 0.4 * s.b);
  vAlpha = alpha * shown * s.r * facingFade(p);
}`;

const SPORE_FRAGMENT = `${PREAMBLE}
in vec3 vColour;
in float vAlpha;
in vec2 vAt;
out vec4 outColour;
void main() {
  float d = dot(vAt, vAt);
  if (d > 1.0) discard;
  float a = vAlpha * (exp(-d * 4.0) + 0.5 * (1.0 - smoothstep(0.0, 0.2, d)));
  outColour = vec4(vColour * a, a);
}`;

const SCREEN_VERTEX = `${PREAMBLE}
layout(location = 0) in vec2 corner;
out vec2 vUv;
void main() {
  vUv = corner * 0.5 + 0.5;
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

/** The sphere's rim: a faint ring of light where the globe meets the void, and a faint body inside it. */
const RIM_FRAGMENT = `${PREAMBLE}
in vec2 vUv;
uniform vec2 viewport;
uniform float radius;
out vec4 outColour;
void main() {
  vec2 p = (vUv - 0.5) * viewport;
  float d = length(p) / radius;
  float ring = exp(-pow((d - 1.0) * 22.0, 2.0)) * 0.22 + (1.0 - smoothstep(0.85, 1.0, d)) * smoothstep(0.2, 1.0, d) * 0.035;
  vec3 colour = vec3(0.25, 0.85, 0.95);
  outColour = vec4(colour * ring, ring);
}`;

const BLUR_FRAGMENT = `${PREAMBLE}
in vec2 vUv;
uniform sampler2D source;
uniform vec2 texel;
out vec4 outColour;
void main() {
  vec3 sum = texture(source, vUv).rgb * 0.227027;
  sum += texture(source, vUv + texel * 1.384615).rgb * 0.316216;
  sum += texture(source, vUv - texel * 1.384615).rgb * 0.316216;
  sum += texture(source, vUv + texel * 3.230769).rgb * 0.070270;
  sum += texture(source, vUv - texel * 3.230769).rgb * 0.070270;
  outColour = vec4(sum, 1.0);
}`;

/** The scene and its glow, tone-mapped so bright overlaps keep their hue, then premultiplied over the card. */
const COMPOSITE_FRAGMENT = `${PREAMBLE}
in vec2 vUv;
uniform sampler2D scene;
uniform sampler2D glow;
out vec4 outColour;
void main() {
  vec3 light = texture(scene, vUv).rgb + texture(glow, vUv).rgb * 1.1;
  vec3 colour = 1.0 - exp(-light * 1.25);
  float a = clamp(max(colour.r, max(colour.g, colour.b)), 0.0, 1.0);
  outColour = vec4(colour, a);
}`;

type Target = {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
};

/** Why the space could not be drawn here. */
export class SpaceUnavailable extends Error {}

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new SpaceUnavailable('shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new SpaceUnavailable(gl.getShaderInfoLog(shader) ?? 'shader');
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new SpaceUnavailable(gl.getProgramInfoLog(program) ?? 'program');
  return program;
}

type Quat = [number, number, number, number];

function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatAxis(axis: readonly number[], angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

function quatNormalise(q: Quat): Quat {
  const length = Math.hypot(...q) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const to: Quat = cos < 0 ? [-b[0], -b[1], -b[2], -b[3]] : [...b];
  cos = Math.abs(cos);
  if (cos > 0.9995) return quatNormalise(a.map((v, i) => v + (to[i] - v) * t) as Quat);
  const angle = Math.acos(cos);
  const sin = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / sin;
  const wb = Math.sin(t * angle) / sin;
  return a.map((v, i) => v * wa + to[i] * wb) as Quat;
}

/** The turn that carries one unit direction onto another. */
function quatBetween(from: readonly number[], to: readonly number[]): Quat {
  const cos = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (cos < -0.9999) return quatAxis(Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], Math.PI);
  const axis = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
  ];
  return quatNormalise([axis[0], axis[1], axis[2], 1 + cos]);
}

/** A unit quaternion as the column-major 3×3 matrix GLSL takes. */
function quatMatrix([x, y, z, w]: Quat): Float32Array {
  return new Float32Array([
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ]);
}

function turnPoint(m: Float32Array, p: readonly number[]): [number, number, number] {
  return [
    m[0] * p[0] + m[3] * p[1] + m[6] * p[2],
    m[1] * p[0] + m[4] * p[1] + m[7] * p[2],
    m[2] * p[0] + m[5] * p[1] + m[8] * p[2],
  ];
}

/** Perspective looking down -z from the camera, with the sphere's centre at the origin in front of it. */
function projectionMatrix(aspect: number): Float32Array {
  const f = 1 / Math.tan(FOV / 2);
  const near = 0.5;
  const far = 20;
  // invariant: the camera sits DISTANCE along +z, folded into the matrix as a translation.
  const m = new Float32Array(16);
  m[0] = aspect >= 1 ? f / aspect : f;
  m[5] = aspect >= 1 ? f : f * aspect;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far) + m[10] * -DISTANCE;
  m[15] = DISTANCE;
  return m;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

type Layer = { vao: WebGLVertexArrayObject; buffer: WebGLBuffer; count: number };

/**
 * One renderer for one canvas. Throws {@link SpaceUnavailable} when the
 * browser cannot draw it, so the caller shows the list instead.
 */
export function createSpaceRenderer(
  canvas: HTMLCanvasElement,
  { still }: { still: boolean },
): SpaceRenderer & { destroy(): void } {
  const context = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
  });
  if (!context) throw new SpaceUnavailable('webgl2');
  const gl: WebGL2RenderingContext = context;
  const floatTargets = gl.getExtension('EXT_color_buffer_float') !== null;

  const segmentProgram = compile(gl, SEGMENT_VERTEX, SEGMENT_FRAGMENT);
  const sporeProgram = compile(gl, SPORE_VERTEX, SPORE_FRAGMENT);
  const rimProgram = compile(gl, SCREEN_VERTEX, RIM_FRAGMENT);
  const blurProgram = compile(gl, SCREEN_VERTEX, BLUR_FRAGMENT);
  const compositeProgram = compile(gl, SCREEN_VERTEX, COMPOSITE_FRAGMENT);
  // why: WebGL names this call useProgram; one wrapper keeps the React hook rule from reading it as a hook.
  const activate = gl.useProgram.bind(gl);
  const uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  const uniform = (program: WebGLProgram, name: string) => {
    let names = uniforms.get(program);
    if (!names) {
      names = new Map();
      uniforms.set(program, names);
    }
    if (!names.has(name)) names.set(name, gl.getUniformLocation(program, name));
    return names.get(name) ?? null;
  };

  const strip = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, strip);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const square = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, square);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const screen = gl.createVertexArray();
  gl.bindVertexArray(screen);
  gl.bindBuffer(gl.ARRAY_BUFFER, square);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  /** A vertex array for instances of one kind: the shared corners, then each instance's floats by width. */
  function layer(corners: WebGLBuffer, floats: number, widths: readonly number[]): Layer {
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    let offset = 0;
    widths.forEach((width, i) => {
      gl.enableVertexAttribArray(i + 1);
      gl.vertexAttribPointer(i + 1, width, gl.FLOAT, false, floats * 4, offset * 4);
      gl.vertexAttribDivisor(i + 1, 1);
      offset += width;
    });
    gl.bindVertexArray(null);
    return { vao, buffer, count: 0 };
  }
  const SEGMENT_WIDTHS = [3, 3, 3, 1, 1, 2, 1];
  const SPORE_WIDTHS = [3, 3, 1, 1, 1, 1];
  const layers = {
    segments: layer(strip, SEGMENT_FLOATS, SEGMENT_WIDTHS),
    spores: layer(square, SPORE_FLOATS, SPORE_WIDTHS),
    querySegments: layer(strip, SEGMENT_FLOATS, SEGMENT_WIDTHS),
    querySpores: layer(square, SPORE_FLOATS, SPORE_WIDTHS),
  };
  function fill(target: Layer, data: Float32Array, floats: number) {
    gl.bindBuffer(gl.ARRAY_BUFFER, target.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    target.count = data.length / floats;
  }
  function fillGeometry(geometry: SpaceGeometry, segments: Layer, spores: Layer) {
    fill(segments, geometry.segments, SEGMENT_FLOATS);
    fill(spores, geometry.spores, SPORE_FLOATS);
  }

  const stateTexture = gl.createTexture();
  let stateData = new Float32Array(4);
  function stateSize(count: number) {
    const width = Math.max(1, Math.min(count, STATE_ROW));
    const height = Math.max(1, Math.ceil(count / STATE_ROW));
    gl.bindTexture(gl.TEXTURE_2D, stateTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    stateData = new Float32Array(width * height * 4);
    return { width, height };
  }
  let stateShape = stateSize(1);

  function target(width: number, height: number): Target {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (floatTargets)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, texture, width, height };
  }
  function dropTarget(t: Target | null) {
    if (!t) return;
    gl.deleteFramebuffer(t.framebuffer);
    gl.deleteTexture(t.texture);
  }
  let targets: { scene: Target; a: Target; b: Target } | null = null;

  let space: EmbeddingSpace | null = null;
  let bornAt: number[] = [];
  let bright = new Float32Array(0);
  let hover = new Float32Array(0);
  let brightTarget = new Float32Array(0);
  let focus: SpaceFocus = { query: null, matches: [], hovered: null };
  let queryAt = -Infinity;
  let turn: Quat = quatNormalise(
    quatMultiply(quatAxis([1, 0, 0], 0.35), quatAxis([0, 1, 0], -0.5)),
  );
  let turnFrom: Quat | null = null;
  let turnTo: Quat | null = null;
  let turnAt = 0;
  let dragging = false;
  let last = performance.now();
  let frame = 0;
  let visible = true;
  let destroyed = false;

  function aimAt(point: SpacePoint) {
    const turned = turnPoint(quatMatrix(turn), point);
    const length = Math.hypot(...turned) || 1;
    turnFrom = turn;
    turnTo = quatNormalise(
      quatMultiply(
        quatBetween(
          turned.map((v) => v / length),
          [0, 0, 1],
        ),
        turn,
      ),
    );
    turnAt = performance.now();
  }

  function retarget() {
    const closeness = new Map(focus.matches.map((m) => [m.index, m.closeness]));
    for (let i = 0; i < brightTarget.length; i += 1) {
      const close = closeness.get(i);
      brightTarget[i] = !focus.query ? 1 : close === undefined ? DIMMED : 1 + 0.9 * close;
    }
  }

  function resize(): boolean {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (targets && canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    if (targets) for (const t of Object.values(targets)) dropTarget(t);
    const half = (n: number) => Math.max(1, Math.round(n / 2));
    targets = {
      scene: target(width, height),
      a: target(half(width), half(height)),
      b: target(half(width), half(height)),
    };
    return true;
  }

  function step(now: number) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const ease = 1 - Math.exp(-dt * 7);
    const want = focus.hovered;
    for (let i = 0; i < bright.length; i += 1) {
      bright[i] += (brightTarget[i] - bright[i]) * ease;
      hover[i] += ((want === i ? 1 : 0) - hover[i]) * ease;
    }
    if (turnFrom && turnTo) {
      const t = still ? 1 : Math.min((now - turnAt) / (TURN_S * 1000), 1);
      turn = quatSlerp(turnFrom, turnTo, easeInOut(t));
      if (t >= 1) turnFrom = turnTo = null;
    } else if (!still && !dragging && !focus.query) {
      turn = quatNormalise(quatMultiply(quatAxis([0, 1, 0], SPIN * dt), turn));
    }
  }

  /** Whether anything is still moving; a settled sphere draws again only on change. */
  function settled(now: number): boolean {
    const spinning = !still && !focus.query;
    if (spinning || dragging || turnFrom) return false;
    if (!still && bornAt.some((at) => now < at + GROW_S * 1000)) return false;
    if (!still && now - queryAt < REVEAL_S * 1000) return false;
    for (let i = 0; i < bright.length; i += 1) {
      const hovering = focus.hovered === i ? 1 : 0;
      if (Math.abs(brightTarget[i] - bright[i]) > 0.005 || Math.abs(hovering - hover[i]) > 0.005)
        return false;
    }
    return true;
  }

  function writeStates(now: number) {
    for (let i = 0; i < bright.length; i += 1) {
      const grown = still ? 1 : Math.min(Math.max((now - bornAt[i]) / (GROW_S * 1000), 0), 1);
      stateData[i * 4] = bright[i];
      stateData[i * 4 + 1] = 1 - (1 - grown) ** 3;
      stateData[i * 4 + 2] = hover[i];
      stateData[i * 4 + 3] = 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, stateTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      stateShape.width,
      stateShape.height,
      gl.RGBA,
      gl.FLOAT,
      stateData,
    );
  }

  function drawLayers(
    segments: Layer,
    spores: Layer,
    reveal: number,
    projection: Float32Array,
    turnMatrix: Float32Array,
    scale: number,
  ) {
    for (const [program, part] of [
      [segmentProgram, segments],
      [sporeProgram, spores],
    ] as const) {
      if (part.count === 0) continue;
      activate(program);
      gl.uniformMatrix4fv(uniform(program, 'projection'), false, projection);
      gl.uniformMatrix3fv(uniform(program, 'turn'), false, turnMatrix);
      gl.uniform2f(uniform(program, 'viewport'), canvas.width, canvas.height);
      gl.uniform1f(uniform(program, 'pxScale'), scale);
      gl.uniform1f(uniform(program, 'reveal'), reveal);
      gl.uniform1i(uniform(program, 'states'), 0);
      gl.bindVertexArray(part.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, part.count);
    }
  }

  function blur(from: Target, to: Target, dx: number, dy: number) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
    gl.viewport(0, 0, to.width, to.height);
    activate(blurProgram);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.uniform1i(uniform(blurProgram, 'source'), 1);
    gl.uniform2f(uniform(blurProgram, 'texel'), dx / from.width, dy / from.height);
    gl.bindVertexArray(screen);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function render(now: number) {
    resize();
    if (!targets) return;
    const { scene, a, b } = targets;
    step(now);
    writeStates(now);
    const aspect = canvas.width / canvas.height;
    const projection = projectionMatrix(aspect);
    const turnMatrix = quatMatrix(turn);
    // why: sizes are authored for a 480-pixel-tall sphere; this keeps them in proportion at any size.
    const scale = Math.min(canvas.width, canvas.height) / 480;

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.framebuffer);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, stateTexture);

    const f = 1 / Math.tan(FOV / 2);
    const radiusNdc = (f / Math.sqrt(DISTANCE * DISTANCE - 1)) * (aspect >= 1 ? 1 : aspect);
    activate(rimProgram);
    gl.uniform2f(uniform(rimProgram, 'viewport'), canvas.width, canvas.height);
    gl.uniform1f(uniform(rimProgram, 'radius'), (radiusNdc * canvas.height) / 2);
    gl.bindVertexArray(screen);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    drawLayers(layers.segments, layers.spores, 2, projection, turnMatrix, scale);
    const reveal = still ? 1 : Math.min((now - queryAt) / (REVEAL_S * 1000), 1);
    drawLayers(
      layers.querySegments,
      layers.querySpores,
      reveal >= 1 ? 2 : reveal,
      projection,
      turnMatrix,
      scale,
    );

    gl.disable(gl.BLEND);
    blur(scene, a, 1, 0);
    blur(a, b, 0, 1);
    blur(b, a, 2.5, 0);
    blur(a, b, 0, 2.5);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    activate(compositeProgram);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.uniform1i(uniform(compositeProgram, 'scene'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, b.texture);
    gl.uniform1i(uniform(compositeProgram, 'glow'), 2);
    gl.bindVertexArray(screen);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  function loop(now: number) {
    frame = 0;
    if (destroyed || !visible) return;
    render(now);
    if (!settled(now)) frame = requestAnimationFrame(loop);
  }
  function wake() {
    if (destroyed || !visible || frame !== 0) return;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }

  const watcher = new IntersectionObserver(([entry]) => {
    visible = (entry?.isIntersecting ?? true) && document.visibilityState === 'visible';
    if (visible) wake();
  });
  watcher.observe(canvas);
  const onVisibility = () => {
    visible = document.visibilityState === 'visible';
    if (visible) wake();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const sizer = new ResizeObserver(() => wake());
  sizer.observe(canvas);

  function applyQuery() {
    if (!space || !focus.query) {
      layers.querySegments.count = 0;
      layers.querySpores.count = 0;
      return;
    }
    fillGeometry(
      queryGeometry(space, focus.query, focus.matches),
      layers.querySegments,
      layers.querySpores,
    );
  }

  return {
    setSpace(next) {
      space = next;
      const now = performance.now();
      const count = next.colonies.length;
      stateShape = stateSize(count);
      bornAt = next.colonies.map(
        (c) => now + GROW_STAGGER_S * 1000 * c.genome.size * (0.5 + 0.5 * ((c.index * 0.618) % 1)),
      );
      bright = new Float32Array(count).fill(1);
      hover = new Float32Array(count);
      brightTarget = new Float32Array(count).fill(1);
      fillGeometry(spaceGeometry(next), layers.segments, layers.spores);
      retarget();
      applyQuery();
      wake();
    },
    setFocus(next) {
      const moved =
        next.query !== focus.query &&
        (!next.query || !focus.query || next.query.some((v, i) => v !== focus.query?.[i]));
      focus = next;
      retarget();
      if (moved) {
        applyQuery();
        queryAt = performance.now();
        if (next.query) aimAt(next.query);
      }
      wake();
    },
    pick(x, y) {
      if (!space) return null;
      const ratio = canvas.width / Math.max(canvas.clientWidth, 1);
      const projection = projectionMatrix(canvas.width / canvas.height);
      const turnMatrix = quatMatrix(turn);
      let best: number | null = null;
      let bestDistance = PICK_PX * PICK_PX;
      for (const colony of space.colonies) {
        const p = turnPoint(turnMatrix, colony.position);
        if (p[2] < -0.1) continue;
        const w = projection[11] * p[2] + projection[15];
        const sx = ((projection[0] * p[0]) / w + 1) * 0.5 * canvas.width;
        const sy = (1 - (projection[5] * p[1]) / w) * 0.5 * canvas.height;
        const d = (sx / ratio - x) ** 2 + (sy / ratio - y) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = colony.index;
        }
      }
      return best;
    },
    drag(dx, dy) {
      dragging = true;
      turnFrom = turnTo = null;
      const speed = 3 / Math.max(Math.min(canvas.clientWidth, canvas.clientHeight), 1);
      turn = quatNormalise(
        quatMultiply(
          quatMultiply(quatAxis([0, 1, 0], dx * speed), quatAxis([1, 0, 0], dy * speed)),
          turn,
        ),
      );
      wake();
    },
    release() {
      dragging = false;
      wake();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      watcher.disconnect();
      sizer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (targets) for (const t of Object.values(targets)) dropTarget(t);
      for (const l of Object.values(layers)) {
        gl.deleteVertexArray(l.vao);
        gl.deleteBuffer(l.buffer);
      }
      for (const program of [
        segmentProgram,
        sporeProgram,
        rimProgram,
        blurProgram,
        compositeProgram,
      ])
        gl.deleteProgram(program);
      gl.deleteBuffer(strip);
      gl.deleteBuffer(square);
      gl.deleteVertexArray(screen);
      gl.deleteTexture(stateTexture);
    },
  };
}

export { QUERY_COLONY };
