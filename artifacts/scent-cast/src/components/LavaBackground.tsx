import React, { useEffect, useRef } from 'react';

export const LavaBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { alpha: true, antialias: false });
    if (!gl) return;

    const vertexShaderSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Refactored fragment shader for a refined, dark-theme atmospheric fluid
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
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        vec2 shift = vec2(100.0);
        mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
        for (int i = 0; i < 6; ++i) { // Increased iterations for smoother fluid dynamics
          v += a * noise(p);
          p = rot * p * 2.0 + shift;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        uv.x *= u_resolution.x / u_resolution.y;
        
        // Slowed down the global time multiplier for a more elegant, creeping flow
        float t = u_time * 0.06; 
        
        vec2 q = vec2(0.0);
        q.x = fbm(uv + 0.1 * t);
        q.y = fbm(uv + vec2(1.0));
        
        vec2 r = vec2(0.0);
        r.x = fbm(uv + 1.0 * q + vec2(1.7, 9.2) + 0.15 * t);
        r.y = fbm(uv + 1.0 * q + vec2(8.3, 2.8) + 0.126 * t);
        float f = fbm(uv + r);

        // Softened the hard lines for a more "viscous fluid" feel rather than cracked rock
        float fluid = 1.0 - abs(f - 0.5) * 2.0;
        fluid = pow(fluid, 3.5);

        float intensity = 0.5 + 0.5 * noise(uv * 2.0 + t);

        // Refined Dark Theme Palette: Obsidian, Deep Violet, and soft Cyan
        vec3 darkBase = vec3(0.03, 0.03, 0.04);     // Deep, rich dark gray/obsidian
        vec3 fluidCore = vec3(0.3, 0.6, 1.0);       // Soft bioluminescent cyan core
        vec3 fluidGlow = vec3(0.2, 0.1, 0.5);       // Deep amethyst/violet glow

        vec3 color = darkBase;
        color = mix(color, fluidGlow, fluid * 0.8);
        color = mix(color, fluidCore * intensity, pow(fluid, 2.0));

        // Add an ambient atmospheric haze
        float halo = pow(fluid, 1.5) * 0.4;
        color += fluidGlow * halo;
        
        // Subtle vignette to draw the eye to the center and blend into dark containers
        vec2 centerUv = gl_FragCoord.xy / u_resolution.xy;
        float vignette = smoothstep(1.5, 0.2, length(centerUv - 0.5));
        color *= vignette;

        gl_FragColor = vec4(color, 1.0);
      }
    `;

    const createShader = (gl: WebGLRenderingContext, type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const program = gl.createProgram();
    if (!program) return;
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) return;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');

    let animId: number;
    let startTime = performance.now();

    const resizeCanvas = () => {
      // Cap DPR to 1.5 to maintain high performance on 4K/Retina displays
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const displayWidth = Math.floor(canvas.clientWidth * dpr);
      const displayHeight = Math.floor(canvas.clientHeight * dpr);

      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
    };

    const render = (time: number) => {
      resizeCanvas();
      
      const elapsedTime = time - startTime;
      gl.uniform1f(timeLocation, elapsedTime * 0.001);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      
      gl.clearColor(0.03, 0.03, 0.04, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      
      animId = requestAnimationFrame(render);
    };

    // Modern resize handling
    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(canvas);

    animId = requestAnimationFrame(render);
    
    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(positionBuffer);
    };
  }, []);

  return (
    <div className="absolute inset-0 w-full h-full overflow-hidden bg-neutral-950 pointer-events-none">
      <canvas
        ref={canvasRef}
        className="w-full h-full opacity-80"
        style={{ 
          mixBlendMode: 'lighten', 
          filter: 'blur(4px) contrast(1.1)' // Softens the fractal noise for a premium feel
        }}
      />
      {/* Optional atmospheric overlay gradient to deepen the edges */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(10,10,12,0.8)_100%)]" />
    </div>
  );
};