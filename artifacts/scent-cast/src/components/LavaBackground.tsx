import React, { useEffect, useRef, useState } from 'react';

export const LavaBackground: React.FC = React.memo(() => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateReducedMotion = () => setReducedMotion(media.matches);
    updateReducedMotion();

    media.addEventListener('change', updateReducedMotion);
    return () => media.removeEventListener('change', updateReducedMotion);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setWebglFailed(false);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const failToFallback = () => setWebglFailed(true);
    const gl = canvas.getContext('webgl');
    if (!gl) {
      failToFallback();
      return;
    }

    const vertexShaderSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fragmentShaderSource = `
      precision highp float;
      uniform float u_time;
      uniform vec2 u_resolution;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        mat2 rot = mat2(0.86, 0.5, -0.5, 0.86);
        for (int i = 0; i < 5; ++i) {
          v += a * noise(p);
          p = rot * p * 2.03 + vec2(17.7, 9.2);
          a *= 0.52;
        }
        return v;
      }

      mat2 rotate2d(float a) {
        float s = sin(a);
        float c = cos(a);
        return mat2(c, -s, s, c);
      }

      float beam(vec2 p, float angle, float offset, float width, float falloff) {
        vec2 r = rotate2d(angle) * p;
        float core = 1.0 - smoothstep(0.0, width, abs(r.y + offset));
        float glow = exp(-pow(abs(r.y + offset) / falloff, 1.45));
        float taper = smoothstep(-1.4, 0.55, r.x) * (1.0 - smoothstep(0.18, 1.75, r.x));
        return (core * 0.75 + glow * 0.42) * taper;
      }

      float rayLattice(vec2 p, float t) {
        float n1 = fbm(p * 1.15 + vec2(t * 0.05, -t * 0.03));
        float n2 = fbm((p + vec2(n1 * 0.28, -n1 * 0.18)) * 3.0 - vec2(t * 0.08, t * 0.04));

        float a = beam(p + vec2(0.02 * sin(t), 0.0), -0.54, -0.35 + 0.05 * sin(t * 0.37), 0.018, 0.22);
        float b = beam(p, -0.31, 0.04 + 0.04 * cos(t * 0.31), 0.013, 0.18);
        float c = beam(p, 0.22, 0.28 + 0.05 * sin(t * 0.43), 0.012, 0.17);
        float d = beam(p, 0.64, -0.16 + 0.04 * cos(t * 0.27), 0.01, 0.14);

        float ribbing = 0.72 + 0.28 * sin((p.x * 9.0 - p.y * 4.0) + t * 0.75 + n2 * 3.4);
        return (a * 0.9 + b * 1.15 + c * 0.82 + d * 0.72) * ribbing * (0.64 + n1 * 0.52);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        vec2 p = (uv - 0.5) * 2.0;
        p.x *= u_resolution.x / u_resolution.y;

        float t = u_time * 0.52;
        float atmosphere = fbm(p * 1.6 + vec2(-t * 0.055, t * 0.028));
        float fineSmoke = fbm(p * 5.2 + vec2(t * 0.045, -t * 0.07));
        float rays = rayLattice(p, t);

        float upperStage = smoothstep(-0.88, 0.56, p.y);
        float centerAir = 1.0 - smoothstep(0.05, 1.7, length(p * vec2(0.72, 0.95)));
        float goldBloom = pow(max(rays, 0.0), 1.42) * (0.64 + centerAir * 0.5) * upperStage;
        float whiteEdge = pow(max(rays - 0.35, 0.0), 2.5) * 0.9;

        float shadowA = beam(p + vec2(-0.08, 0.0), -0.42, 0.18 + 0.04 * sin(t * 0.29), 0.045, 0.3);
        float shadowB = beam(p, 0.48, -0.42 + 0.05 * cos(t * 0.24), 0.055, 0.34);
        float shadowVeil = clamp(shadowA * 0.72 + shadowB * 0.58 + smoothstep(0.48, 0.92, fineSmoke) * 0.18, 0.0, 1.0);

        vec3 black = vec3(0.0, 0.0, 0.0);
        vec3 warmBlack = vec3(0.017, 0.012, 0.008);
        vec3 smoky = vec3(0.075, 0.067, 0.058);
        vec3 deepGold = vec3(0.92, 0.54, 0.13);
        vec3 richGold = vec3(1.0, 0.72, 0.28);
        vec3 ivory = vec3(1.0, 0.95, 0.78);

        vec3 color = mix(black, warmBlack, 0.75);
        color += smoky * pow(atmosphere, 2.15) * 0.065;
        color += deepGold * goldBloom * 0.34;
        color += richGold * pow(goldBloom, 2.0) * 0.24;
        color += ivory * whiteEdge * 0.16;

        color *= 1.0 - shadowVeil * 0.34;

        float vignette = smoothstep(1.65, 0.22, length(p * vec2(0.78, 0.92)));
        color *= 0.44 + vignette * 0.82;

        float topGlaze = smoothstep(-0.2, 1.0, uv.y) * (0.018 + atmosphere * 0.02);
        color += vec3(1.0, 0.74, 0.36) * topGlaze;

        float grain = hash(gl_FragCoord.xy + floor(u_time * 24.0)) - 0.5;
        color += grain * 0.018;

        gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
      }
    `;

    const createShader = (gl: WebGLRenderingContext, type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const program = gl.createProgram();
    if (!program) {
      failToFallback();
      return;
    }
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) {
      failToFallback();
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      failToFallback();
      return;
    }
    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      failToFallback();
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'position');
    if (positionLocation < 0) {
      failToFallback();
      return;
    }
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    if (!timeLocation || !resolutionLocation) {
      failToFallback();
      return;
    }

    let animId: number | null = null;
    setWebglFailed(false);

    const resizeCanvas = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      const width = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const render = (time: number) => {
      resizeCanvas();
      gl.uniform1f(timeLocation, time * 0.001);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animId = requestAnimationFrame(render);
    };

    const stop = () => {
      if (animId !== null) {
        cancelAnimationFrame(animId);
        animId = null;
      }
    };

    const start = () => {
      if (animId !== null) return;
      animId = requestAnimationFrame(render);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        start();
      }
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      stop();
      failToFallback();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    canvas.addEventListener('webglcontextlost', handleContextLost);
    start();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      stop();
    };
  }, [reducedMotion]);

  return (
    <>
      <div
        className={`scent-lava-fallback ${reducedMotion ? 'scent-lava-fallback--static' : 'scent-lava-fallback--animated'} ${
          webglFailed || reducedMotion ? 'scent-lava-fallback--visible' : ''
        }`}
        aria-hidden="true"
      />
      {!reducedMotion && !webglFailed ? (
        <canvas
          ref={canvasRef}
          className="fixed inset-0 w-full h-full pointer-events-none opacity-100"
          style={{ zIndex: 0 }}
        />
      ) : null}
      <div className="scent-beam-atmosphere" aria-hidden="true" />
      <div className="scent-beam-grain" aria-hidden="true" />
    </>
  );
});
