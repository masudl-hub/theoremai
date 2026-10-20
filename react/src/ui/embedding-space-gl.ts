/**
 * Draws the embedding space with WebGL2 and nothing else: anti-aliased lines,
 * solid dots and the query's white dot, laid over the card with premultiplied
 * alpha so the card shows through. Dots cover whatever lies behind them, and
 * every line stops just short of the dot it reaches; the far side of the
 * ball draws smaller and fainter. No React here: the component owns one
 * renderer and feeds it.
 *
 * @module
 */

import type { EmbeddingSpace, SpacePoint } from '../client/embedding-space.ts';
import {
  DOT_FLOATS,
  FRAME_SLOT,
  type QueryMatch,
  queryGeometry,
  SEGMENT_FLOATS,
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
  /** Shows a new index: its clusters grow in, one after another. */
  setSpace(space: EmbeddingSpace): void;
  setFocus(focus: SpaceFocus): void;
  /** The document nearest a point in CSS pixels from the canvas's corner, if one is close and facing. */
  pick(x: number, y: number): number | null;
  /** Turns the sphere as a drag moves, in CSS pixels. */
  drag(dx: number, dy: number): void;
  release(): void;
};

/** Slot states per texture row. */
const STATE_ROW = 1024;
/** Field of view, in radians. */
/** Wide enough that the ball, whose farthest document is on its rim, fits with a margin at the camera's distance. */
const FOV = (44 * Math.PI) / 180;
/** The camera's distance from the ball's centre: close, so depth reads as perspective. */
const DISTANCE = 3.2;
/** Seconds a cluster's lines take to draw, and the most a cluster waits to start. */
const GROW_S = 0.9;
const GROW_STAGGER_S = 0.6;
/** Seconds a query's lines take to reach its matches. */
const REVEAL_S = 0.7;
/** Seconds the sphere takes to turn a query to face the viewer. */
const TURN_S = 1.2;
/** Radians per second the sphere turns on its own. */
const SPIN = 0.05;
/** How far, in CSS pixels, the pointer reaches for a document. */
const PICK_PX = 18;
/** Squared CSS pixels within which two dots under the pointer are told apart by depth. */
const PICK_TIE = 16;
/** How bright a document reads when a query leaves it out. */
const DIMMED = 0.2;
/** How fast a flung sphere slows, per second, and the speed in radians per second below which it stops. */
const COAST_DECAY = 4;
const COAST_STOP = 0.01;
/** Milliseconds a drag may pause before release and still fling the sphere. */
const FLING_MS = 80;

const PREAMBLE = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

const STATE_GLSL = `
uniform sampler2D states;
vec4 stateOf(float i) {
  if (i < -0.5) return vec4(1.0, 1.0, 0.0, 0.0);
  int k = int(i + 0.5);
  return texelFetch(states, ivec2(k % ${STATE_ROW}, k / ${STATE_ROW}), 0);
}
// How near the viewer a point sits, from 0 at the ball's back to 1 at its front.
float facing(vec3 p) {
  return clamp(0.5 + 0.5 * p.z, 0.0, 1.0);
}
float facingFade(vec3 p) {
  return mix(0.18, 1.0, facing(p));
}
float facingSize(vec3 p) {
  return mix(0.6, 1.1, facing(p));
}
// The axes' circles fade with the square of depth, so their front reads strongly and their back recedes.
float frameFade(vec3 p) {
  float k = mix(0.2, 1.0, facing(p));
  return mix(0.24, 1.0, k * k);
}
`;

const SEGMENT_VERTEX = `${PREAMBLE}
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 from;
layout(location = 2) in vec3 to;
layout(location = 3) in vec3 colour;
layout(location = 4) in float alpha;
layout(location = 5) in float width;
layout(location = 6) in vec2 slots;
layout(location = 7) in float along;
layout(location = 8) in vec2 gaps;
uniform mat4 projection;
uniform mat3 turn;
uniform vec2 viewport;
uniform float ratio;
uniform float reveal;
${STATE_GLSL}
out vec3 vColour;
out float vAlpha;
out float vAcross;
out float vHalf;
out float vAlong;
out vec3 vEnds;
void main() {
  vec4 sa = stateOf(slots.x);
  vec4 sb = stateOf(slots.y);
  float grow = min(sa.g, sb.g);
  float hover = max(sa.b, sb.b);
  float shown = step(along, grow + 1e-4) * step(along, reveal + 1e-4);
  vec3 pa = turn * from;
  vec3 pb = turn * to;
  vec4 ca = projection * vec4(pa, 1.0);
  vec4 cb = projection * vec4(pb, 1.0);
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * viewport;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec3 p = corner.x < 0.5 ? pa : pb;
  vec4 c = corner.x < 0.5 ? ca : cb;
  // invariant: only the axes' circles read the frame slot, and they keep one width at every depth.
  bool frame = slots.x < ${FRAME_SLOT + 0.5};
  // why: a line thinner than a device pixel is drawn one pixel wide and fainter, so it stays smooth.
  float full = width * ratio * (frame ? 1.0 : facingSize(p)) * (1.0 + 0.8 * hover);
  float half_ = 0.5 * max(full, 1.0);
  float reach = half_ + 1.0;
  c.xy += normal * corner.y * reach * 2.0 / viewport * c.w;
  gl_Position = c;
  vAcross = corner.y * reach;
  vHalf = half_;
  vAlong = corner.x * len;
  // invariant: each end's gap grows with its dot, as the dot grows when hovered.
  vEnds = vec3(
    len,
    gaps.x * ratio * facingSize(pa) * (1.0 + 0.6 * sa.b),
    gaps.y * ratio * facingSize(pb) * (1.0 + 0.6 * sb.b)
  );
  vColour = colour;
  vAlpha = min(alpha * shown * min(sa.r, sb.r) * (1.0 + hover), 1.0) * (frame ? frameFade(p) : facingFade(p)) * min(full, 1.0);
}`;

const SEGMENT_FRAGMENT = `${PREAMBLE}
in vec3 vColour;
in float vAlpha;
in float vAcross;
in float vHalf;
in float vAlong;
in vec3 vEnds;
out vec4 outColour;
void main() {
  float clear = clamp(vAlong - vEnds.y + 0.5, 0.0, 1.0) * clamp(vEnds.x - vAlong - vEnds.z + 0.5, 0.0, 1.0);
  float a = vAlpha * clear * clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0);
  if (a < 0.002) discard;
  outColour = vec4(vColour * a, a);
}`;

const DOT_VERTEX = `${PREAMBLE}
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 position;
layout(location = 2) in vec3 colour;
layout(location = 3) in float alpha;
layout(location = 4) in float radius;
layout(location = 5) in float slot;
layout(location = 6) in float along;
uniform mat4 projection;
uniform mat3 turn;
uniform vec2 viewport;
uniform float ratio;
uniform float reveal;
${STATE_GLSL}
out vec3 vColour;
out float vAlpha;
out vec2 vAt;
out float vRadius;
void main() {
  vec4 s = stateOf(slot);
  float shown = step(along, s.g + 1e-4) * step(along, reveal + 1e-4);
  vec3 p = turn * position;
  vec4 c = projection * vec4(p, 1.0);
  float size = ratio * facingSize(p);
  float r = radius * size * (1.0 + 0.6 * s.b);
  float reach = r + 1.0;
  c.xy += corner * reach * 2.0 / viewport * c.w;
  gl_Position = c;
  vAt = corner * reach;
  vRadius = r;
  vColour = colour;
  vAlpha = alpha * shown * min(s.r, 1.0) * facingFade(p);
}`;

const DOT_FRAGMENT = `${PREAMBLE}
in vec3 vColour;
in float vAlpha;
in vec2 vAt;
in float vRadius;
out vec4 outColour;
void main() {
  float d = length(vAt);
  float a = vAlpha * clamp(vRadius + 0.5 - d, 0.0, 1.0);
  // invariant: only what a dot covers writes depth, so the lines behind it and nothing else are hidden.
  if (a < 0.002) discard;
  outColour = vec4(vColour * a, a);
}`;

/** Why the space could not be drawn here. */
class SpaceUnavailable extends Error {}

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
    depth: true,
    stencil: false,
  });
  if (!context) throw new SpaceUnavailable('webgl2');
  const gl: WebGL2RenderingContext = context;

  const segmentProgram = compile(gl, SEGMENT_VERTEX, SEGMENT_FRAGMENT);
  const dotProgram = compile(gl, DOT_VERTEX, DOT_FRAGMENT);
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
  const SEGMENT_WIDTHS = [3, 3, 3, 1, 1, 2, 1, 2];
  const DOT_WIDTHS = [3, 3, 1, 1, 1, 1];
  const layers = {
    segments: layer(strip, SEGMENT_FLOATS, SEGMENT_WIDTHS),
    dots: layer(square, DOT_FLOATS, DOT_WIDTHS),
    querySegments: layer(strip, SEGMENT_FLOATS, SEGMENT_WIDTHS),
    queryDots: layer(square, DOT_FLOATS, DOT_WIDTHS),
  };
  function fill(target: Layer, data: Float32Array, floats: number) {
    gl.bindBuffer(gl.ARRAY_BUFFER, target.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    target.count = data.length / floats;
  }
  function fillGeometry(geometry: SpaceGeometry, segments: Layer, dots: Layer) {
    fill(segments, geometry.segments, SEGMENT_FLOATS);
    fill(dots, geometry.dots, DOT_FLOATS);
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
  /** Where the sphere turns from and to while it turns to face the query. */
  let turning: { from: Quat; to: Quat } | null = null;
  let turnAt = 0;
  let dragging = false;
  /** How fast the sphere turns about its y and x axes, in radians per second, from the last drag; it coasts on this after release. */
  let coast: [number, number] = [0, 0];
  let draggedAt = 0;
  let last = performance.now();
  let frame = 0;
  let visible = true;
  let destroyed = false;

  function aimAt(point: SpacePoint) {
    const turned = turnPoint(quatMatrix(turn), point);
    const length = Math.hypot(...turned);
    // why: a query at the centre faces the viewer from every turn.
    if (length < 1e-6) return;
    turning = {
      from: turn,
      to: quatNormalise(
        quatMultiply(
          quatBetween(
            turned.map((v) => v / length),
            [0, 0, 1],
          ),
          turn,
        ),
      ),
    };
    turnAt = performance.now();
  }

  /** Every document's brightness for the focus: a query's matches full, the rest dimmed. */
  function retarget() {
    if (!space) return;
    const closeness = new Map(focus.matches.map((m) => [m.index, m.closeness]));
    for (const document of space.documents) {
      const close = closeness.get(document.index);
      brightTarget[document.index] = !focus.query || close !== undefined ? 1 : DIMMED;
    }
  }

  function resize() {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
  }

  function turnBy(aboutY: number, aboutX: number) {
    turn = quatNormalise(
      quatMultiply(quatMultiply(quatAxis([0, 1, 0], aboutY), quatAxis([1, 0, 0], aboutX)), turn),
    );
  }

  function coasting(): boolean {
    return Math.hypot(...coast) > COAST_STOP;
  }

  function easeSlots(ease: number) {
    const want = focus.hovered;
    for (let i = 0; i < bright.length; i += 1) {
      bright[i] += (brightTarget[i] - bright[i]) * ease;
      hover[i] += ((want === i ? 1 : 0) - hover[i]) * ease;
    }
  }

  function faceQuery(now: number, { from, to }: { from: Quat; to: Quat }) {
    const t = still ? 1 : Math.min((now - turnAt) / (TURN_S * 1000), 1);
    turn = quatSlerp(from, to, easeInOut(t));
    if (t >= 1) turning = null;
  }

  function turnSphere(now: number, dt: number) {
    if (turning) faceQuery(now, turning);
    else if (dragging) return;
    else if (coasting()) {
      turnBy(coast[0] * dt, coast[1] * dt);
      const decay = Math.exp(-COAST_DECAY * dt);
      coast = [coast[0] * decay, coast[1] * decay];
    } else if (!still && !focus.query) turnBy(SPIN * dt, 0);
  }

  function step(now: number) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    // why: with reduced motion, brightness changes at once rather than fading.
    easeSlots(still ? 1 : 1 - Math.exp(-dt * 7));
    turnSphere(now, dt);
  }

  /** Whether the sphere turns, or a cluster or the query is still growing in. */
  function animating(now: number): boolean {
    if (dragging || turning || coasting()) return true;
    if (still) return false;
    if (!focus.query) return true;
    return now - queryAt < REVEAL_S * 1000 || bornAt.some((at) => now < at + GROW_S * 1000);
  }

  /** Whether every slot's brightness and hover have reached where they are going. */
  function eased(): boolean {
    for (let i = 0; i < bright.length; i += 1) {
      const hovering = focus.hovered === i ? 1 : 0;
      if (Math.abs(brightTarget[i] - bright[i]) > 0.005 || Math.abs(hovering - hover[i]) > 0.005)
        return false;
    }
    return true;
  }

  /** Whether anything is still moving; a settled sphere draws again only on change. */
  function settled(now: number): boolean {
    return !animating(now) && eased();
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

  function draw(
    program: WebGLProgram,
    part: Layer,
    reveal: number,
    view: { projection: Float32Array; turn: Float32Array; ratio: number },
  ) {
    if (part.count === 0) return;
    activate(program);
    gl.uniformMatrix4fv(uniform(program, 'projection'), false, view.projection);
    gl.uniformMatrix3fv(uniform(program, 'turn'), false, view.turn);
    gl.uniform2f(uniform(program, 'viewport'), canvas.width, canvas.height);
    gl.uniform1f(uniform(program, 'ratio'), view.ratio);
    gl.uniform1f(uniform(program, 'reveal'), reveal);
    gl.uniform1i(uniform(program, 'states'), 0);
    gl.bindVertexArray(part.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, part.count);
  }

  function render(now: number) {
    resize();
    step(now);
    writeStates(now);
    const view = {
      projection: projectionMatrix(canvas.width / canvas.height),
      turn: quatMatrix(turn),
      ratio: canvas.width / Math.max(canvas.clientWidth, 1),
    };
    const shown = still ? 1 : Math.min((now - queryAt) / (REVEAL_S * 1000), 1);
    const reveal = shown >= 1 ? 2 : shown;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, stateTexture);
    // invariant: dots first, writing depth; then lines, tested against it, so a dot covers the lines behind it.
    gl.depthMask(true);
    draw(dotProgram, layers.dots, 2, view);
    draw(dotProgram, layers.queryDots, reveal, view);
    gl.depthMask(false);
    draw(segmentProgram, layers.segments, 2, view);
    draw(segmentProgram, layers.querySegments, reveal, view);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
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
      layers.queryDots.count = 0;
      return;
    }
    fillGeometry(
      queryGeometry(space, focus.query, focus.matches),
      layers.querySegments,
      layers.queryDots,
    );
  }

  return {
    setSpace(next) {
      space = next;
      const now = performance.now();
      const count = next.documents.length;
      stateShape = stateSize(count);
      // invariant: a cluster's documents grow together; clusters start in turn.
      const startOf = (k: number) =>
        now + (GROW_STAGGER_S * 1000 * k) / Math.max(next.clusters.length, 1);
      bornAt = next.documents.map((d) => startOf(d.cluster));
      bright = new Float32Array(count).fill(1);
      hover = new Float32Array(count);
      brightTarget = new Float32Array(count).fill(1);
      fillGeometry(spaceGeometry(next), layers.segments, layers.dots);
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
      let bestDepth = -Infinity;
      for (const document of space.documents) {
        const p = turnPoint(turnMatrix, document.position);
        const w = projection[11] * p[2] + projection[15];
        const sx = ((projection[0] * p[0]) / w + 1) * 0.5 * canvas.width;
        const sy = (1 - (projection[5] * p[1]) / w) * 0.5 * canvas.height;
        const d = (sx / ratio - x) ** 2 + (sy / ratio - y) ** 2;
        // why: of two dots under the pointer, within a dot's width, the nearer one is the one seen.
        const nearer = d < bestDistance + PICK_TIE && p[2] > bestDepth;
        if (d < bestDistance - PICK_TIE || (d < PICK_PX * PICK_PX && nearer)) {
          bestDistance = d;
          bestDepth = p[2];
          best = document.index;
        }
      }
      return best;
    },
    drag(dx, dy) {
      const now = performance.now();
      const dt = Math.max((now - draggedAt) / 1000, 1 / 120);
      dragging = true;
      turning = null;
      draggedAt = now;
      const speed = 3 / Math.max(Math.min(canvas.clientWidth, canvas.clientHeight), 1);
      turnBy(dx * speed, dy * speed);
      // why: half this move and half the run before it, so one jittery event does not decide the fling.
      coast = [0.5 * coast[0] + (0.5 * dx * speed) / dt, 0.5 * coast[1] + (0.5 * dy * speed) / dt];
      wake();
    },
    release() {
      dragging = false;
      if (still || performance.now() - draggedAt > FLING_MS) coast = [0, 0];
      wake();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      watcher.disconnect();
      sizer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const l of Object.values(layers)) {
        gl.deleteVertexArray(l.vao);
        gl.deleteBuffer(l.buffer);
      }
      for (const program of [segmentProgram, dotProgram]) gl.deleteProgram(program);
      gl.deleteBuffer(strip);
      gl.deleteBuffer(square);
      gl.deleteTexture(stateTexture);
    },
  };
}
