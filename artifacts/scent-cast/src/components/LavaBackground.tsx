import React, { useEffect, useRef } from 'react';

// Extract shader sources outside the component to prevent memory reallocation
const VERTEX_SHADER_SOURCE = `
  attribute vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER_SOURCE = `
  precision highp float;
  uniform float u_time;
  uniform vec2 u_resolution;

  // Pre-calculate rotation matrix to save ALU cycles
  const mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));

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
    for (int i = 0; i < 6; ++i) { 
      v += a * noise(p);
      p = rot * p * 2.0 + shift;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    // Aspect ratio correction for ultra-wide and mobile screens
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    float aspect = u_resolution.x / u_resolution.y;
    vec2 scaledUv = uv;
    scaledUv.x *= aspect;
    
    float t = u_time * 0.04; // Slower, heavier fluid motion
    
    // Domain warping for organic liquid feel
    vec2 q = vec2(0.0);
    q.x = fbm(scaledUv + 0.1 * t);
    q.y = fbm(scaledUv + vec2(1.0));
    
    vec2 r = vec2(0.0);
    r.x = fbm(scaledUv + 1.0 * q + vec2(1.7, 9.2) + 0.15 * t);
    r.y = fbm(scaledUv + 1.0 * q + vec2(8.3, 2.8) + 0.126 * t);
    float f = fbm(scaledUv + r);

    // Softer falloff for liquid mercury aesthetic
    float fluid = smoothstep(0.0, 1.0, 1.0 - abs(f - 0.5) * 2.0);
    float intensity = 0.5 + 0.5 * noise(scaledUv * 2.0 + t);

    // Premium Void / Liquid Silver Palette
    vec3 voidColor = vec3(0.02, 0.02, 0.03); // Not quite true black, adds depth
    vec3 silverCore = vec3(0.88, 0.90, 0.94); 
    vec3 softGlow = vec3(0.40, 0.45, 0.50);

    vec3 color = voidColor;
    color = mix(color, softGlow, fluid * 0.6);
    color = mix(color, silverCore * intensity, fluid * fluid);

    // Cubic Vignette
    float dist = distance(uv, vec2(0.5));
    float vignette = smoothstep(0.8, 0.2, dist);
    color *= vignette;

    // Output with alpha for CSS blending
    gl_FragColor = vec4(color, vignette * 0.8);
  }
`;

export const LavaBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animIdRef = useRef<number>(0);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // A11y: Reduce motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timeMultiplier = prefersReducedMotion ? 0.05 : 1.0;

    let gl = canvas.getContext('webgl', { 
      alpha: true, 
      antialias: false,
      powerPreference: 'high-performance',
      depth: false,
      stencil: false
    });
    
    if (!gl) return; // Fails gracefully to CSS background

    const createShader = (glContext: WebGLRenderingContext, type: number, source: string) => {
      const shader = glContext.createShader(type);
      if (!shader) return null;
      glContext.shaderSource(shader, source);
      glContext.compileShader(shader);
      if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
        glContext.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    const program = gl.createProgram();

    if (!vertexShader || !fragmentShader || !program) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      if (program) gl.deleteProgram(program);
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }

    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1.0, -1.0,  1.0, -1.0, -1.0,  1.0,
      -1.0,  1.0,  1.0, -1.0,  1.0,  1.0
    ]), gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');

    let lastTime = performance.now();
    let accumulatedTime = 0;

    const resizeCanvas = () => {
      if (!canvas || !isMounted.current) return;
      // Cap DPR to 1.5 to prevent GPU thermal throttling on 4K/Retina
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const displayWidth = Math.floor(canvas.clientWidth * dpr);
      const displayHeight = Math.floor(canvas.clientHeight * dpr);

      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        if(gl) gl.viewport(0, 0, canvas.width, canvas.height);
      }
    };

    const render = (time: number) => {
      if (!isMounted.current || !gl) return;
      
      // Delta time calculation with clamping for backgrounded tabs
      const deltaTime = Math.min(time - lastTime, 100);
      lastTime = time;
      accumulatedTime += deltaTime * timeMultiplier;
      
      resizeCanvas();
      
      // Prevent float precision failure over time
      gl.uniform1f(timeLocation, (accumulatedTime % 3600000) * 0.001);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      
      // Transparent clear to allow CSS background integration
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      
      animIdRef.current = requestAnimationFrame(render);
    };

    // GPU Context Loss Recovery
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(animIdRef.current);
    };
    
    const handleContextRestored = () => {
      // Re-init logic would go here in a larger app, but simple unmount/remount handles this best in React
      console.log('WebGL context restored');
    };

    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

    const resizeObserver = new ResizeObserver(() => {
      if (isMounted.current) requestAnimationFrame(resizeCanvas);
    });
    resizeObserver.observe(canvas);

    animIdRef.current = requestAnimationFrame(render);
    
    return () => {
      isMounted.current = false;
      cancelAnimationFrame(animIdRef.current);
      resizeObserver.disconnect();
      
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      
      if (gl) {
        gl.disableVertexAttribArray(positionLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.deleteBuffer(positionBuffer);
        
        gl.useProgram(null);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        gl.deleteProgram(program);
        
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    };
  }, []);

  return (
    <div 
      className="absolute inset-0 w-full h-full overflow-hidden bg-[#050507]"
      aria-hidden="true"
      role="presentation"
      style={{ zIndex: 0 }}
    >
      {/* Procedural CSS Grain Overlay: 
        Crucial for preventing color-banding and adding a premium tactile feel 
      */}
      <div 
        className="absolute inset-0 opacity-[0.03] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
          transform: 'translate3d(0,0,0)'
        }}
      />
      
      <canvas
        ref={canvasRef}
        className="w-full h-full pointer-events-none"
        style={{ 
          mixBlendMode: 'screen', 
          filter: 'blur(6px) contrast(1.15)', // Increased blur/contrast for softer fluid
          willChange: 'transform, opacity',
          animation: 'fadeIn 2s cubic-bezier(0.16, 1, 0.3, 1) forwards'
        }}
      />
      
      {/* Deep Space Vignette Gradient */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(5,5,7,0.95)_100%)] pointer-events-none" />

      {/* Injecting simple keyframe for smooth initial mount */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(1.02); }
          to { opacity: 0.6; transform: scale(1); }
        }
      `}</style>
    </div>
  );
};